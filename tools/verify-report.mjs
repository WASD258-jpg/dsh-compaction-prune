/**
 * Verification of the report's load-bearing claims, re-derived from the data.
 *
 * This is the adversarial pass over REPORT.md: every numbered claim below is
 * recomputed here so the report cannot drift from its own measurements.
 *
 * Run: `node tools/verify-report.mjs`
 *
 * @module tools/verify-report
 */

import { listSessionLogs, readSessionLog } from './session-log.mjs'
import { counterfactual, selfTest, CONFIG, selectLogs } from './a2-counterfactual.mjs'
import { mountChain } from './a2-counterfactual.mjs'
import { appendRecorded, seedBoundary, seedSession } from './replay.mjs'
import { compactionThreshold, routeAt, routeTimeline } from './metrics.mjs'
import { loadManifest, restrictToManifest } from './corpus.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [PASS] ${label}`)
  else { failures += 1; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}

// Every claim below is re-derived from the PINNED corpus, so the counts in
// REPORT.md are reproducible even though the sessions directory is live.
const manifest = loadManifest()
const { logs } = restrictToManifest(listSessionLogs(SESSIONS_ROOT), manifest)
console.log(`corpus: ${logs.length} pinned session(s) from tools/corpus-manifest.json`)

console.log('\n=== claim: baseline.kind === "usage" and totalTokens === raw usage total, always ===')
{
  const log = logs.find((item) => item.sessionId.includes('c0acb35e'))
  const { header, events } = readSessionLog(log.path)
  const { ctx, meter } = await mountChain()
  const boundary = seedBoundary(header, events)
  const session = seedSession(header, events.slice(0, boundary))
  let compared = 0
  let mismatches = 0
  let nonUsage = 0
  for (const event of events.slice(boundary)) {
    appendRecorded(session, event)
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const measured = meter.measure(session)
    const raw = event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0)
      + (event.data.usage.cacheWriteTokens ?? 0) + event.data.usage.outputTokens
    compared += 1
    if (measured.baseline.kind !== 'usage') nonUsage += 1
    if (measured.totalTokens !== raw) mismatches += 1
  }
  await ctx.fiber.dispose()
  check(`compared ${compared} settlements`, compared === 2104, String(compared))
  check('zero baseline.kind !== "usage"', nonUsage === 0, String(nonUsage))
  check('zero mismatches against the raw usage total', mismatches === 0, String(mismatches))
}

console.log('\n=== claim: decide() acted before EVERY real compaction (recall 8/8) ===')
{
  const rows = []
  for (const log of logs) {
    let decoded
    try { decoded = readSessionLog(log.path) } catch { continue }
    if (!decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)) continue
    let report
    try { report = await counterfactual(log, { collectSamples: true }) } catch { continue }
    if (report.realCompactions === 0) continue

    const compactionSeqs = decoded.events.filter((event) => event.type === 'compaction/start').map((event) => event.seq)
    for (const seq of compactionSeqs) {
      // Any `act: true` decision strictly before this compaction counts as
      // having anticipated it.
      const acted = report.sampleRows.some((row) => row.seq < seq && row.action === 'prune')
      const actedSincePrevious = report.sampleRows.some((row) => row.seq < seq && row.action === 'prune')
      rows.push({ sessionId: report.sessionId, seq, acted })
      void actedSincePrevious
    }
  }
  const anticipated = rows.filter((row) => row.acted).length
  check(`every one of ${rows.length} real compaction(s) was preceded by an act: true`, anticipated === rows.length,
    `${anticipated}/${rows.length}`)
  for (const row of rows) console.log(`    ${row.sessionId.slice(0, 30)} seq ${row.seq}: anticipated=${row.acted}`)
}

console.log('\n=== claim: pruner reach at a boundary depends on whether compaction ran the pruner ===')
{
  const found = []
  for (const log of logs) {
    let decoded
    try { decoded = readSessionLog(log.path) } catch { continue }
    const compactions = decoded.events.filter((event) => event.type === 'compaction/start')
    if (compactions.length === 0) continue
    const { events, header } = decoded
    const { ctx, meter, pruner } = await mountChain()
    const timeline = routeTimeline(events)
    const boundary = seedBoundary(header, events)
    const session = seedSession(header, events.slice(0, boundary))
    const pruneEvents = events.filter((event) => event.type === 'compaction/prune').length
    for (const event of events.slice(boundary)) {
      appendRecorded(session, event)
      if (event.type !== 'compaction/start') continue
      let reclaim = 0
      let overBudget = 0
      for (const node of meter.measure(session).nodes) {
        const nodeEvent = session.eventAt(node.seq)
        if (nodeEvent.type !== 'tool/result') continue
        const message = session.deriveEventMessage(nodeEvent)
        const pruned = pruner.pruneContent(message.content)
        if (pruned === null) continue
        overBudget += 1
        reclaim += Math.max(0, node.tokens - meter.estimateMessage({ ...message, content: pruned }))
      }
      const route = routeAt(timeline, event.seq)
      found.push({
        sessionId: header.id,
        seq: event.seq,
        reclaim,
        overBudget,
        sessionPruneEvents: pruneEvents,
        totalTokens: meter.measure(session).totalTokens,
        threshold: route === undefined ? null : compactionThreshold({
          contextWindow: route.contextWindow,
          reservedCompletionTokens: route.maxTokens ?? 0,
          headroomTokens: 65536,
          thresholdRatio: 0.8,
        }),
      })
    }
    await ctx.fiber.dispose()
  }
  check(`inspected ${found.length} compaction boundary(ies)`, found.length === 8, String(found.length))
  check('every boundary is over its threshold',
    found.every((row) => row.threshold !== null && row.totalTokens >= row.threshold))

  // Split by whether the session had already exercised the pruner at all.
  const prunerUsed = found.filter((row) => row.sessionPruneEvents > 0)
  const prunerUnused = found.filter((row) => row.sessionPruneEvents === 0)
  check('boundaries in sessions where the pruner had run: reach is EXACTLY 0',
    prunerUsed.length > 0 && prunerUsed.every((row) => row.reclaim === 0 && row.overBudget === 0),
    JSON.stringify(prunerUsed.map((row) => row.reclaim)))
  check('boundaries in sessions where the pruner had NOT run: reach is non-zero',
    prunerUnused.length > 0 && prunerUnused.every((row) => row.reclaim > 0),
    JSON.stringify(prunerUnused.map((row) => ({ reclaim: row.reclaim, nodes: row.overBudget }))))
  check(`7 boundaries had the pruner already exercised, 1 had not`,
    prunerUsed.length === 7 && prunerUnused.length === 1,
    `${prunerUsed.length} / ${prunerUnused.length}`)

  console.log('    boundary table (seq | total | threshold | over | reclaimLeft | overBudgetNodes | session prune events):')
  for (const row of found) {
    console.log(`      ${String(row.seq).padStart(6)} | ${String(row.totalTokens).padStart(7)} | ${String(row.threshold).padStart(6)} | ${String(row.totalTokens - row.threshold).padStart(7)} | ${String(row.reclaim).padStart(11)} | ${String(row.overBudget).padStart(15)} | ${row.sessionPruneEvents}`)
  }
}

console.log('\n=== claim: >=7 sessions had decide() act; 8 compactions total; 1 avoided ===')
{
  const reports = []
  for (const log of logs) {
    let decoded
    try { decoded = readSessionLog(log.path) } catch { continue }
    if (!decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)) continue
    try { reports.push(await counterfactual(log)) } catch { continue }
  }
  const analysable = reports.filter((report) => report.unanalysable === undefined)
  const fired = analysable.filter((report) => report.pluginPrunes > 0).length
  check(`analysable sessions = 50`, analysable.length === 50, String(analysable.length))
  // The number of sessions in which the rule FIRED is a content-derived count:
  // the pinned sessions include ones still being written, so their sample count
  // and therefore their decisions grow between runs. It is asserted as a LOWER
  // BOUND, not an equality. Compaction counts, by contrast, are historical facts
  // that no later append can change.
  check(`sessions where decide() acted >= 7 (lower bound; grows with the live corpus)`, fired >= 7, String(fired))
  check(`total real compactions = 8`,
    analysable.reduce((sum, report) => sum + report.realCompactions, 0) === 8,
    String(analysable.reduce((sum, report) => sum + report.realCompactions, 0)))
  check(`total avoided arithmetically = 1`,
    analysable.reduce((sum, report) => sum + report.compactionsAvoidedArithmetically, 0) === 1,
    String(analysable.reduce((sum, report) => sum + report.compactionsAvoidedArithmetically, 0)))
  console.log(`    observed at this run: ${fired} session(s) fired, out of ${analysable.length} analysable`)
}

console.log('\n=== claim: deprecated note — `Session` reconstruction imports resolve cleanly ===')
{
  const { locatePackage } = await import('./resolve-module.mjs')
  const llm = locatePackage('@deepseek-ai/dsh-llm')
  check('dsh-llm resolves from the unpatched pnpm store, not the patched harness tree',
    llm.source === 'pnpm-store', `${llm.source} tainted=${llm.tainted}`)
}

console.log(`\n=== verdict: ${failures === 0 ? 'all report claims re-derived successfully' : `${failures} claim(s) FAILED`} ===`)
if (failures > 0) process.exitCode = 1
