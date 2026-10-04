/**
 * A2 — counterfactual replay of the proactive prune rule against recorded sessions.
 *
 * THE QUESTION
 *
 *   "If the plugin's rule had pruned at 35% of the window, would this token
 *    trajectory still have crossed the compaction threshold?"
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 *
 * This is an ARITHMETIC counterfactual. The recorded event stream is replayed
 * verbatim — every assistant settlement keeps the provider-reported usage it was
 * recorded with, every tool result keeps the text it was recorded with, and every
 * real compaction still happens exactly where it happened. The only thing added
 * is the plugin's own decision: at each surface-growing settlement, if
 * `decide()` returns `act: true`, the nodes the pruner would have shrunk are
 * priced, and their reclaimed tokens are subtracted from the measured pressure
 * from that point on.
 *
 * It therefore answers "is there enough arithmetic room?" and NOT "what would the
 * agent have done?". Pruning changes what the model sees, which changes what it
 * writes next, which changes the whole future trajectory. That feedback is not
 * modelled and cannot be recovered from a log of the branch that was not taken.
 * The result is a NECESSARY condition for avoidance, never a sufficient one:
 * if the arithmetic says the curve still crosses, pruning would not have avoided
 * it either; if the arithmetic says the curve stays below, avoidance is still
 * only possible, because the post-prune agent may grow the context faster.
 *
 * WHY THE TRAJECTORY IS EXACT
 *
 * `TokenMeter.measure()` reduces to
 *
 *   totalTokens = baseline.tokens + (surfaceTokens - anchorSurfaceTokens)
 *
 * where `baseline` is the provider's own reported total whenever that total is
 * at least the route-priced anchor estimate (verified for all 2,104 settlements
 * of the largest session: `baseline.kind === 'usage'` and the reading equals the
 * raw usage total to the token). Pruning perturbs ONLY `surfaceTokens`, so its
 * effect on the curve is exactly the pruner's own surface re-pricing — no
 * heuristic scaling factor is involved, and provider usage is never re-estimated.
 *
 * @module tools/a2-counterfactual
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { DEFAULTS, decide } from '../src/index.js'
import { readSessionLog, listSessionLogs } from './session-log.mjs'
import { applyToSurface } from './surface.mjs'
import { appendRecorded, seedBoundary, seedSession } from './replay.mjs'
import { compactionThreshold, routeAt, routeTimeline } from './metrics.mjs'
import { MANIFEST_PATH, loadManifest, restrictToManifest } from './corpus.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.

/**
 * Select the session logs a run should analyse.
 *
 * The sessions directory is live, so absolute counts drift as new sessions
 * appear. `--manifest` pins the session SET (see `tools/corpus.mjs`) while still
 * reading current bytes, which is what keeps the reported counts reproducible.
 *
 * @param filters - session-id substrings; empty means "all".
 * @param useManifest - whether to restrict to the pinned set.
 * @returns `{ logs, manifest, missing }`.
 */
export function selectLogs(filters = [], useManifest = false) {
  let logs = listSessionLogs(SESSIONS_ROOT)
  let manifest
  let missing = []
  if (useManifest) {
    manifest = loadManifest()
    const restricted = restrictToManifest(logs, manifest)
    logs = restricted.logs
    missing = restricted.missing
  }
  if (filters.length > 0) {
    logs = logs.filter((item) => filters.some((filter) => item.sessionId.includes(filter) || item.dir.includes(filter)))
    if (logs.length === 0) throw new Error(`no session matches ${JSON.stringify(filters)}`)
  }
  return { logs, manifest, missing }
}

/** The plugin configuration under test. Defaults, unchanged. */
export const CONFIG = Object.freeze({ ...DEFAULTS, mode: 'prune' })

/**
 * Build a mounted dependency chain so the REAL token meter and the REAL pruner
 * are used for every priced quantity.
 *
 * @returns `{ ctx, meter, pruner }`.
 */
export async function mountChain() {
  const ctx = new Context()
  await ctx.plugin(SessionProjection, {})
  await ctx.plugin(SessionStore, {})
  await ctx.plugin(TokenMeter, {})
  await ctx.plugin(ToolResultPruner, {})
  return { ctx, meter: ctx.tokenMeter, pruner: ctx.toolResultPruner }
}

/**
 * Price one model-visible message the way the token meter prices surface nodes.
 *
 * @param meter - the mounted token meter.
 * @param message - a derived message.
 * @returns token price under the fixed heuristic.
 */
function priceMessage(meter, message) {
  return meter.estimateMessage(message)
}

/**
 * Enumerate the surface's `tool/result` nodes and how much each would yield.
 *
 * Mirrors `estimateRemovable()` in the plugin, but reports per node so a prune
 * can be priced node by node, and accepts an exclusion set so an
 * already-counterfactually-pruned node is not counted twice.
 *
 * @param session - the replayed session.
 * @param pruner - the mounted pruner (supplies `thresholdChars`).
 * @param excluded - seqs already pruned in the counterfactual.
 * @returns `{ entries, charsRemovable }`.
 */
function surveyToolResults(session, pruner, excluded) {
  const thresholdChars = pruner.config.thresholdChars
  const entries = []
  let charsRemovable = 0
  for (const seq of session.surface.nodes) {
    if (excluded.has(seq)) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null || !Array.isArray(message.content)) continue
    let chars = 0
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    }
    if (chars <= thresholdChars) continue
    charsRemovable += chars - thresholdChars
    entries.push({ seq, message, chars })
  }
  return { entries, charsRemovable }
}

/**
 * Replay one recorded session twice — as recorded, and under the plugin's rule.
 *
 * @param log - a `listSessionLogs` entry.
 * @param options - `config` (plugin config), `collectSamples` (per-settlement rows).
 * @returns a report for this session.
 */
export async function counterfactual(log, options = {}) {
  const config = options.config ?? CONFIG
  const { ctx, meter, pruner } = await mountChain()
  const { header, events } = readSessionLog(log.path)

  const timeline = routeTimeline(events)
  const boundary = seedBoundary(header, events)
  const session = seedSession(header, events.slice(0, boundary))

  /** Reclaimed tokens per pruned node, still on the surface. */
  const gainBySeq = new Map()
  const prunedSeqs = new Set()
  let lastPruneAt
  let prunesPerformed = 0
  let charsReclaimed = 0
  let tokensReclaimedTotal = 0

  /** Real compaction boundaries, for reporting. */
  const realCompactions = []
  const samples = []
  const reach = []
  let prunedBeforeCompaction = 0
  let crossingReal = 0
  let crossingCounterfactual = 0
  let avoidedCrossings = 0

  for (const event of events.slice(boundary)) {
    appendRecorded(session, event)

    if (event.type === 'compaction/start') {
      // Compose the surface at this instant: how much of the pressure the
      // pruner can even reach, and what its own budget could ever reclaim.
      const measured = meter.measure(session)
      let toolResultTokens = 0
      let toolResultNodes = 0
      let toolResultChars = 0
      let theoreticalReclaim = 0
      for (const seq of session.surface.nodes) {
        const nodeEvent = session.eventAt(seq)
        if (nodeEvent?.type !== 'tool/result') continue
        const message = session.deriveEventMessage(nodeEvent)
        if (message === null || !Array.isArray(message.content)) continue
        toolResultNodes += 1
        const before = meter.estimateMessage(message)
        toolResultTokens += before
        for (const block of message.content) {
          if (block.type === 'text' && typeof block.text === 'string') toolResultChars += block.text.length
        }
        const prunedContent = pruner.pruneContent(message.content)
        if (prunedContent === null) continue
        theoreticalReclaim += Math.max(0, before - meter.estimateMessage({ ...message, content: prunedContent }))
      }
      reach.push({
        seq: event.seq,
        turn: event.data.turn,
        totalTokens: measured.totalTokens,
        surfaceTokens: measured.surfaceTokens,
        toolResultNodes,
        toolResultTokens,
        toolResultChars,
        toolResultShareOfSurface: measured.surfaceTokens === 0 ? null : toolResultTokens / measured.surfaceTokens,
        theoreticalReclaim,
      })
      realCompactions.push({
        seq: event.seq,
        turn: event.data.turn,
        reclaimedBefore: prunedBeforeCompaction,
      })
      continue
    }

    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const route = routeAt(timeline, event.seq)
    if (route === undefined || route.contextWindow === undefined) continue

    const measured = meter.measure(session)
    const realTotal = measured.totalTokens

    // Reclaimed tokens still represented on the current surface. A node dropped
    // by a real compaction leaves the surface and its claim disappears with it.
    const onSurface = new Set(session.surface.nodes)
    let reclaimedOnSurface = 0
    for (const [seq, gain] of gainBySeq) {
      if (onSurface.has(seq)) reclaimedOnSurface += gain
    }
    const counterfactualTotal = Math.max(0, realTotal - reclaimedOnSurface)

    const threshold = compactionThreshold({
      contextWindow: route.contextWindow,
      reservedCompletionTokens: route.maxTokens ?? 0,
      headroomTokens: 65536,
      thresholdRatio: 0.8,
    })
    const trigger = Math.floor(route.contextWindow * config.triggerRatio)

    const realCrosses = threshold !== null && realTotal >= threshold
    const counterfactualCrosses = threshold !== null && counterfactualTotal >= threshold
    if (realCrosses) crossingReal += 1
    if (counterfactualCrosses) crossingCounterfactual += 1
    if (realCrosses && !counterfactualCrosses) avoidedCrossings += 1

    const { entries, charsRemovable } = surveyToolResults(session, pruner, prunedSeqs)
    const decision = decide({
      totalTokens: counterfactualTotal,
      contextWindow: route.contextWindow,
      charsRemovable,
      config,
      lastPruneAt,
      now: event.time,
    })

    let actedThisSample = false
    let tokensReclaimedThisSample = 0
    if (decision.act) {
      actedThisSample = true
      prunesPerformed += 1
      lastPruneAt = event.time
      for (const entry of entries) {
        const prunedContent = pruner.pruneContent(entry.message.content)
        if (prunedContent === null) continue
        const before = priceMessage(meter, entry.message)
        const after = priceMessage(meter, { ...entry.message, content: prunedContent })
        const gain = Math.max(0, before - after)
        gainBySeq.set(entry.seq, gain)
        prunedSeqs.add(entry.seq)
        tokensReclaimedThisSample += gain
        charsReclaimed += entry.chars - pruner.measureContent(prunedContent)
      }
      tokensReclaimedTotal += tokensReclaimedThisSample
      prunedBeforeCompaction += 1
    }

    samples.push({
      seq: event.seq,
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      route: `${route.provider}/${route.model}`,
      contextWindow: route.contextWindow,
      trigger,
      threshold,
      realTotal,
      counterfactualTotal,
      reclaimOnSurface: reclaimedOnSurface,
      charsRemovable,
      action: decision.act ? 'prune' : 'skip',
      reason: decision.reason,
      actedThisSample,
      tokensReclaimedThisSample,
      realCrosses,
      counterfactualCrosses,
    })
  }

  // A session that inherited a large prefix may publish almost nothing of its
  // own: seed events never fire `session/event`, so the plugin never observes
  // them. Such a session has no trajectory to analyse.
  if (samples.length === 0) {
    return {
      sessionId: log.sessionId,
      group: log.group,
      path: log.path,
      events: events.length,
      isSeeded: header.isSeeded === true,
      seedBoundary: boundary,
      samples: 0,
      unanalysable: 'no live settlements of its own',
      realCompactions: realCompactions.length,
    }
  }

  const peakReal = samples.reduce((best, item) => (item.realTotal > best.realTotal ? item : best), samples[0])
  const peakCounterfactual = samples.reduce((best, item) => (item.counterfactualTotal > best.counterfactualTotal ? item : best), samples[0])
  const thresholds = samples.filter((item) => item.threshold !== null).map((item) => item.threshold)
  const minThreshold = thresholds.length === 0 ? null : Math.min(...thresholds)
  const peakHeadroom = peakReal.threshold === null ? null : peakReal.realTotal - peakReal.threshold

  // Per-compaction verdict: the last settlement before each real compaction, as
  // recorded versus as the plugin would have left it. "Avoided" means the
  // counterfactual total stayed strictly below the threshold at that instant —
  // the arithmetic condition under which compaction would not have been needed.
  const compactionVerdicts = realCompactions.map((item) => {
    const before = samples.filter((sample) => sample.seq < item.seq).at(-1)
    if (before === undefined) return { ...item, verdict: 'no-sample' }
    return {
      seq: item.seq,
      turn: item.turn,
      sampleSeq: before.seq,
      threshold: before.threshold,
      realTotal: before.realTotal,
      counterfactualTotal: before.counterfactualTotal,
      realOver: before.threshold === null ? null : before.realTotal - before.threshold,
      counterfactualOver: before.threshold === null ? null : before.counterfactualTotal - before.threshold,
      avoidedArithmetically: before.threshold !== null && before.counterfactualTotal < before.threshold,
      reclaimOnSurface: before.reclaimOnSurface,
      prunesThusFar: item.reclaimedBefore,
    }
  })

  // How much the plugin COULD ever reclaim on this trajectory: the largest
  // single-sample reclaim, and the ceiling implied by the pruner's own budget
  // (every over-threshold text node shrunk to exactly `thresholdChars`).
  const maxReclaimOnSurface = samples.reduce((best, item) => Math.max(best, item.reclaimOnSurface), 0)
  const maxCharsRemovable = samples.reduce((best, item) => Math.max(best, item.charsRemovable), 0)
  const worstGap = compactionVerdicts.reduce((best, item) => Math.max(best, item.realOver ?? 0), 0)

  const report = {
    sessionId: log.sessionId,
    group: log.group,
    path: log.path,
    events: events.length,
    samples: samples.length,
    route: peakReal.route,
    contextWindow: peakReal.contextWindow,
    maxTokens: peakReal.maxTokens ?? null,
    trigger: peakReal.trigger,
    threshold: peakReal.threshold,
    minThreshold,
    peakReal: peakReal.realTotal,
    peakRealSeq: peakReal.seq,
    peakCounterfactual: peakCounterfactual.counterfactualTotal,
    peakOverThreshold: peakHeadroom,
    realCompactions: realCompactions.length,
    compactionSeqs: realCompactions.map((item) => item.seq),
    realSamplesOverThreshold: crossingReal,
    counterfactualSamplesOverThreshold: crossingCounterfactual,
    crossingsAvoidedArithmetically: avoidedCrossings,
    compactionVerdicts,
    compactionsAvoidedArithmetically: compactionVerdicts.filter((item) => item.avoidedArithmetically === true).length,
    reach,
    maxReclaimOnSurface,
    maxCharsRemovable,
    worstGapOverThreshold: worstGap,
    pluginPrunes: prunesPerformed,
    tokensReclaimed: tokensReclaimedTotal,
    charsReclaimed,
    nodesPruned: prunedSeqs.size,
  }
  await ctx.fiber.dispose()
  if (options.collectSamples === true) report.sampleRows = samples
  return report
}

/** Run A2 over every recorded session that has usable samples. */
export async function counterfactualAll(sessionsRoot = SESSIONS_ROOT) {
  const reports = []
  for (const log of listSessionLogs(sessionsRoot)) {
    let decoded
    try {
      decoded = readSessionLog(log.path)
    } catch (error) {
      reports.push({ sessionId: log.sessionId, group: log.group, error: error.message })
      continue
    }
    const hasUsage = decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)
    if (!hasUsage) continue
    try {
      reports.push(await counterfactual(log))
    } catch (error) {
      reports.push({ sessionId: log.sessionId, group: log.group, error: `${error.message.split('\n')[0]}` })
    }
  }
  return reports
}

/**
 * Self-test: with `mode: off` the counterfactual must reproduce the real curve
 * EXACTLY — same totals at every sample, zero prunes, zero deviations.
 *
 * This is the control that catches a replay that has drifted: if the reconstruction
 * were pricing fabricating pressure, the control would deviate.
 *
 * @returns `{ ok, deviations, samples, details }`.
 */
export async function selfTest(log) {
  const report = await counterfactual(log, {
    config: Object.freeze({ ...DEFAULTS, mode: 'off' }),
    collectSamples: true,
  })
  const deviations = (report.sampleRows ?? []).filter((row) => row.counterfactualTotal !== row.realTotal)
  const analysable = (report.sampleRows?.length ?? 0) > 0
  return {
    // A session with no live settlements of its own cannot be checked either
    // way; it is reported as skipped, not as a pass or a failure.
    ok: analysable ? deviations.length === 0 && report.pluginPrunes === 0 && report.tokensReclaimed === 0 : null,
    skipped: !analysable,
    deviations: deviations.length,
    samples: report.samples,
    pluginPrunes: report.pluginPrunes,
    firstDeviation: deviations[0] ?? null,
    note: report.unanalysable,
  }
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const sweep = args.includes('--sweep')
  const selftest = args.includes('--selftest')
  const useManifest = args.includes('--manifest')
  const filters = args.filter((arg) => !arg.startsWith('--'))

  /** Parameter sweep: does ANY setting of the plugin's own knobs change the verdict? */
  const SWEEP = [
    ['as-shipped (ratio .35, min 2048)', {}],
    ['eager: min 0 chars', { minimumCharsRemoved: 0 }],
    ['eager: ratio .05 (earliest legal trigger)', { triggerRatio: 0.05 }],
    ['eager: ratio .05 + min 0 + no cooldown', { triggerRatio: 0.05, minimumCharsRemoved: 0, cooldownMs: 0 }],
    ['control: mode off (counterfactual == real)', { mode: 'off' }],
  ]

  const run = async () => {
    const { logs, manifest, missing } = selectLogs(filters, useManifest)
    if (useManifest) {
      console.error(`corpus manifest: ${MANIFEST_PATH} (${manifest.sessions.length} pinned session(s); ${logs.length} present${missing.length > 0 ? `, ${missing.length} missing` : ''})`)
    }

    if (selftest) {
      const rows = []
      for (const log of logs) {
        let decoded
        try {
          decoded = readSessionLog(log.path)
        } catch (error) {
          rows.push({ sessionId: log.sessionId, ok: false, error: error.message })
          continue
        }
        if (!decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)) continue
        try {
          const result = await selfTest(log)
          rows.push({ sessionId: log.sessionId, ...result })
        } catch (error) {
          rows.push({ sessionId: log.sessionId, ok: false, error: error.message.split('\n')[0] })
        }
      }
      if (json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return }
      const failed = rows.filter((row) => row.ok === false)
      const skipped = rows.filter((row) => row.skipped === true)
      console.log(['sessionId'.padEnd(34), 'ok'.padEnd(8), 'samples'.padStart(8), 'deviations'.padStart(11), 'prunes'.padStart(7)].join(' '))
      for (const row of rows) {
        console.log([
          row.sessionId.slice(0, 34).padEnd(34),
          String(row.error !== undefined ? 'ERROR' : row.skipped === true ? 'skipped' : row.ok).padEnd(8),
          String(row.samples ?? '-').padStart(8),
          String(row.deviations ?? '-').padStart(11),
          String(row.pluginPrunes ?? '-').padStart(7),
        ].join(' '))
        if (row.error !== undefined) console.log(`    error: ${row.error}`)
        if (row.note !== undefined) console.log(`    note: ${row.note}`)
        if (row.firstDeviation !== null && row.firstDeviation !== undefined) {
          console.log(`    first deviation: ${JSON.stringify(row.firstDeviation)}`)
        }
      }
      const checked = rows.filter((row) => row.ok === true)
      console.log(`\ncontrol: ${checked.length} session(s) reproduce the real curve EXACTLY under mode: off, ${skipped.length} skipped (no live settlements), ${failed.length} failed.`)
      if (failed.length > 0) process.exitCode = 1
      return
    }

    if (sweep) {
      const rows = []
      for (const [label, override] of SWEEP) {
        const config = Object.freeze({ ...DEFAULTS, mode: 'prune', ...override })
        for (const log of logs) {
          let decoded
          try {
            decoded = readSessionLog(log.path)
          } catch { continue }
          if (!decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)) continue
          let report
          try {
            report = await counterfactual(log, { config })
          } catch (error) {
            rows.push({ label, sessionId: log.sessionId, error: error.message.split('\n')[0] })
            continue
          }
          if (report.realCompactions === 0) continue
          rows.push({
            label,
            sessionId: report.sessionId,
            realCompactions: report.realCompactions,
            compactionsAvoided: report.compactionsAvoidedArithmetically,
            pluginPrunes: report.pluginPrunes,
            tokensReclaimed: report.tokensReclaimed,
            peakReal: report.peakReal,
            peakCounterfactual: report.peakCounterfactual,
            threshold: report.threshold,
            minMarginOverThreshold: Math.min(...report.compactionVerdicts.filter((v) => v.realOver !== null && v.realOver >= 0).map((v) => v.realOver).concat([Infinity])),
          })
        }
      }
      if (json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
        return
      }
      console.log(['sweep'.padEnd(38), 'session'.padEnd(30), 'cmps', 'avoided', 'prunes', 'tokens', 'margin(min over-thr)'].join(' | '))
      for (const row of rows) {
        if (row.error !== undefined) { console.log(`${row.label.padEnd(38)} | ${row.sessionId.slice(0, 30).padEnd(30)} | ERROR ${row.error.slice(0, 40)}`); continue }
        console.log([
          row.label.padEnd(38),
          row.sessionId.slice(0, 30).padEnd(30),
          String(row.realCompactions).padStart(4),
          String(row.compactionsAvoided).padStart(7),
          String(row.pluginPrunes).padStart(6),
          String(row.tokensReclaimed).padStart(6),
          String(row.minMarginOverThreshold === Infinity ? '-' : row.minMarginOverThreshold).padStart(18),
        ].join(' | '))
      }
      return
    }

    const reports = []
    for (const log of logs) {
      let decoded
      try {
        decoded = readSessionLog(log.path)
      } catch (error) {
        reports.push({ sessionId: log.sessionId, group: log.group, error: error.message })
        continue
      }
      if (!decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)) continue
      try {
        reports.push(await counterfactual(log))
      } catch (error) {
        reports.push({ sessionId: log.sessionId, group: log.group, error: `${error.message.split('\n')[0]}` })
      }
    }
    if (json) {
      process.stdout.write(JSON.stringify(reports, null, 2) + '\n')
      return
    }
    const fmt = (row) => {
      if (row.error !== undefined) return `${row.sessionId.slice(0, 30).padEnd(30)} ERROR ${row.error.slice(0, 60)}`
      return [
        row.sessionId.slice(0, 30).padEnd(30),
        String(row.peakReal).padStart(9),
        String(row.contextWindow).padStart(8),
        String(row.threshold).padStart(9),
        String(row.realSamplesOverThreshold).padStart(7),
        String(row.counterfactualSamplesOverThreshold).padStart(7),
        String(row.crossingsAvoidedArithmetically).padStart(7),
        String(row.pluginPrunes).padStart(7),
        String(row.tokensReclaimed).padStart(9),
      ].join(' ')
    }
    console.log(['sessionId'.padEnd(30), 'peakReal'.padStart(9), 'window'.padStart(8), 'thresh'.padStart(9), 'real>thr'.padStart(7), 'cf>thr'.padStart(7), 'avoided'.padStart(7), 'prunes'.padStart(7), 'tokens'.padStart(9)].join(' '))
    for (const row of reports) console.log(fmt(row))
  }
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

if (process.argv[1]?.endsWith('a2-counterfactual.mjs')) main()
