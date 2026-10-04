/**
 * Dump one session's token-pressure trajectory, aligned to its compaction points.
 *
 * Diagnostic companion to the counterfactual replay: shows how far the real curve
 * travelled, how many settlements sat above each threshold, and where the real
 * compaction boundaries fall relative to both.
 *
 * Run: `node tools/trace.mjs <sessionIdPrefix>`
 *
 * @module tools/trace
 */

import { readSessionLog, listSessionLogs } from './session-log.mjs'
import { compactionThreshold, routeAt, routeTimeline } from './metrics.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.
const TRIGGER_RATIO = 0.35

const target = process.argv[2]
if (target === undefined) throw new Error('usage: node tools/trace.mjs <sessionIdPrefix>')

const log = listSessionLogs(SESSIONS_ROOT).find((item) => item.sessionId.includes(target) || item.dir.includes(target))
if (log === undefined) throw new Error(`no session matches "${target}"`)

const { events } = readSessionLog(log.path)
const timeline = routeTimeline(events)
const compactions = events.filter((event) => event.type === 'compaction/start')
const prunes = events.filter((event) => event.type === 'compaction/prune')

console.log(`session: ${log.sessionId}`)
console.log(`path:    ${log.path}`)
console.log(`events:  ${events.length}, compactions: ${compactions.length}, prune events: ${prunes.length}`)

const samples = []
for (const event of events) {
  if (event.type !== 'assistant/message') continue
  const usage = event.data.usage
  if (usage === undefined) continue
  const route = routeAt(timeline, event.seq)
  if (route === undefined || route.contextWindow === undefined) continue
  samples.push({
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    totalTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens,
    pressure: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    contextWindow: route.contextWindow,
    route: `${route.provider}/${route.model}`,
    maxTokens: route.maxTokens,
    trigger: Math.floor(route.contextWindow * TRIGGER_RATIO),
    threshold: compactionThreshold({
      contextWindow: route.contextWindow,
      reservedCompletionTokens: route.maxTokens ?? 0,
      headroomTokens: 65536,
      thresholdRatio: 0.8,
    }),
  })
}

if (samples.length === 0) {
  console.log('no settlements with usage on a resolvable route')
  process.exit(0)
}

const first = samples[0]
console.log(`route: ${first.route}, window: ${first.contextWindow}, header maxTokens: ${first.maxTokens}`)
console.log(`plugin trigger (${TRIGGER_RATIO * 100}%): ${first.trigger}`)
console.log(`compaction threshold: ${first.threshold}`)
console.log(`samples: ${samples.length}`)
console.log(`above trigger: ${samples.filter((s) => s.totalTokens >= s.trigger).length}`)
console.log(`above compaction threshold: ${samples.filter((s) => s.threshold !== null && s.totalTokens >= s.threshold).length}`)

console.log('\n=== the last settlement before each compaction ===')
for (const compaction of compactions) {
  const before = samples.filter((sample) => sample.seq < compaction.seq).at(-1)
  if (before === undefined) continue
  console.log(`seq ${String(compaction.seq).padStart(6)} turn ${String(compaction.data.turn).padStart(4)} | last sample seq ${before.seq}: total ${before.totalTokens}, threshold ${before.threshold}, over by ${before.totalTokens - before.threshold}`)
}

console.log('\n=== trajectory around the first compaction (10 before, 4 after) ===')
const anchor = compactions[0]
if (anchor !== undefined) {
  for (const sample of samples.filter((item) => item.seq < anchor.seq).slice(-10)) {
    console.log(`  seq ${String(sample.seq).padStart(6)} t${String(sample.turn).padStart(3)}  total ${String(sample.totalTokens).padStart(7)}  threshold ${sample.threshold}  ${sample.totalTokens >= sample.threshold ? 'OVER' : ''}`)
  }
  console.log('  ---- compaction ----')
  for (const sample of samples.filter((item) => item.seq > anchor.seq).slice(0, 4)) {
    console.log(`  seq ${String(sample.seq).padStart(6)} t${String(sample.turn).padStart(3)}  total ${String(sample.totalTokens).padStart(7)}  threshold ${sample.threshold}`)
  }
}
