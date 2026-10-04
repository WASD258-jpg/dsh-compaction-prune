/**
 * Reconnaissance over the recorded session corpus (CLI).
 *
 * Prints, per session, the peak prompt-side pressure implied by provider usage
 * and the two thresholds that matter:
 *   - the proactive prune trigger (`triggerRatio x contextWindow`) — the plugin's rule
 *   - the automatic compaction threshold — compaction-basic's resolved spec
 *
 * Read-only. Run: `node tools/recon.mjs [--json]`
 *
 * @module tools/recon
 */

import { readSessionLog, listSessionLogs } from './session-log.mjs'
import { compactionThreshold, pressureOf, routeAt, routeTimeline } from './metrics.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.
const TRIGGER_RATIO = 0.35

/** Every pressure sample in one session, with its route and both thresholds. */
export function samplesOf(events, triggerRatio = TRIGGER_RATIO) {
  const timeline = routeTimeline(events)
  const out = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    const route = routeAt(timeline, event.seq)
    if (route === undefined || route.contextWindow === undefined) continue
    out.push({
      seq: event.seq,
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      pressure: pressureOf(usage),
      usageTokens: pressureOf(usage) + usage.outputTokens,
      outputTokens: usage.outputTokens,
      contextWindow: route.contextWindow,
      route: `${route.provider}/${route.model}`,
      maxTokens: route.maxTokens,
      trigger: Math.floor(route.contextWindow * triggerRatio),
      threshold: compactionThreshold({
        contextWindow: route.contextWindow,
        reservedCompletionTokens: route.maxTokens ?? 0,
        headroomTokens: 65536,
        thresholdRatio: 0.8,
      }),
    })
  }
  return out
}

/** Survey every decodable v4 log. */
export function survey() {
  const rows = []
  for (const log of listSessionLogs(SESSIONS_ROOT)) {
    let decoded
    try {
      decoded = readSessionLog(log.path)
    } catch (error) {
      rows.push({ sessionId: log.sessionId, group: log.group, error: error.message })
      continue
    }
    const { events } = decoded
    const samples = samplesOf(events)
    if (samples.length === 0) continue
    const ranked = [...samples].sort((left, right) => right.pressure - left.pressure)
    const peak = ranked[0]
    const thresholded = samples.filter((sample) => sample.threshold !== null)
    rows.push({
      sessionId: log.sessionId,
      group: log.group,
      events: events.length,
      samples: samples.length,
      compactions: events.filter((event) => event.type === 'compaction/start').length,
      realPrunes: events.filter((event) => event.type === 'compaction/prune').length,
      peakPressure: peak.pressure,
      peakSeq: peak.seq,
      route: peak.route,
      contextWindow: peak.contextWindow,
      maxTokens: peak.maxTokens,
      trigger: peak.trigger,
      threshold: peak.threshold,
      peakOverTrigger: peak.pressure >= peak.trigger,
      peakOverThreshold: peak.threshold !== null && peak.pressure >= peak.threshold,
      samplesOverTrigger: samples.filter((sample) => sample.pressure >= sample.trigger).length,
      samplesOverThreshold: thresholded.filter((sample) => sample.pressure >= sample.threshold).length,
      minThreshold: thresholded.length === 0 ? null : Math.min(...thresholded.map((sample) => sample.threshold)),
      maxPressureOtherRoutes: ranked.filter((sample) => sample.route !== peak.route).at(0)?.pressure ?? null,
    })
  }
  return rows
}

function main() {
  const rows = survey()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return
  }
  const header = ['sessionId', 'cmps', 'prunes', 'samples', 'peakPressure', 'window', 'maxTok', 'trigger35%', 'threshold', 'peak>trig', 'peak>thr', 'n>trig', 'n>thr']
  const fmt = (row) => [
    row.sessionId.slice(0, 26).padEnd(26),
    String(row.compactions ?? '-').padStart(4),
    String(row.realPrunes ?? '-').padStart(6),
    String(row.samples ?? '-').padStart(7),
    String(row.peakPressure ?? '-').padStart(12),
    String(row.contextWindow ?? '-').padStart(8),
    String(row.maxTokens ?? '-').padStart(7),
    String(row.trigger ?? '-').padStart(10),
    String(row.threshold ?? '-').padStart(10),
    String(row.peakOverTrigger ?? '-').padStart(9),
    String(row.peakOverThreshold ?? '-').padStart(7),
    String(row.samplesOverTrigger ?? '-').padStart(7),
    String(row.samplesOverThreshold ?? '-').padStart(6),
  ].join(' ')

  const active = rows.filter((row) => (row.compactions ?? 0) > 0).sort((a, b) => b.compactions - a.compactions)
  const quiet = rows.filter((row) => (row.compactions ?? 0) === 0).sort((a, b) => (b.peakPressure ?? 0) - (a.peakPressure ?? 0))
  const broken = rows.filter((row) => row.error !== undefined)

  console.log('=== sessions WITH compaction activity ===')
  console.log(header.join(' '))
  for (const row of active) console.log(fmt(row))

  console.log('\n=== sessions WITHOUT compaction, by peak pressure ===')
  console.log(header.join(' '))
  for (const row of quiet) console.log(fmt(row))

  if (broken.length > 0) {
    console.log(`\n=== ${broken.length} undecodable log(s) ===`)
    for (const row of broken) console.log(`${row.sessionId}: ${row.error}`)
  }

  const usable = rows.filter((row) => row.samples !== undefined)
  console.log(`\ntotals: ${rows.length} v4 logs, ${usable.length} usable, ${active.length} with compaction`)
  console.log(`peak pressure across corpus: ${Math.max(...usable.map((row) => row.peakPressure))}`)
  console.log(`sessions whose peak crossed the 35% trigger: ${usable.filter((row) => row.peakOverTrigger).length}`)
  console.log(`sessions whose peak crossed the compaction threshold: ${usable.filter((row) => row.peakOverThreshold).length}`)
}

if (process.argv[1]?.endsWith('recon.mjs')) main()
