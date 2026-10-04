/**
 * Determine HOW each real compaction was triggered, and whether the pruner had
 * already run by the time its boundary event was recorded.
 *
 * `compaction-basic` prunes the whole surface as an early step of its PRESSURE
 * path, then decides. So if a boundary still shows over-budget tool results, that
 * compaction did not come from the pressure path — it came from a path that
 * skips the pruner (e.g. a manual compaction). This distinction decides whether
 * the counterfactual's "avoided" verdict is even applicable.
 *
 * Run: `node tools/trigger-audit.mjs`
 *
 * @module tools/trigger-audit
 */

import { readSessionLog, listSessionLogs } from './session-log.mjs'
import { mountChain } from './a2-counterfactual.mjs'
import { appendRecorded, seedBoundary, seedSession } from './replay.mjs'
import { compactionThreshold, routeAt, routeTimeline } from './metrics.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.

/** Measure the surface's remaining pruner reach right now. */
function reach(meter, pruner, session) {
  let reclaim = 0
  let overBudget = 0
  for (const node of meter.measure(session).nodes) {
    const event = session.eventAt(node.seq)
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    const pruned = pruner.pruneContent(message.content)
    if (pruned === null) continue
    overBudget += 1
    reclaim += Math.max(0, node.tokens - meter.estimateMessage({ ...message, content: pruned }))
  }
  return { reclaim, overBudget }
}

for (const log of listSessionLogs(SESSIONS_ROOT)) {
  let decoded
  try { decoded = readSessionLog(log.path) } catch { continue }
  const { header, events } = decoded
  const compactionSeqs = events.filter((event) => event.type === 'compaction/start').map((event) => event.seq)
  if (compactionSeqs.length === 0) continue

  const timeline = routeTimeline(events)
  const { ctx, meter, pruner } = await mountChain()
  const boundary = seedBoundary(header, events)
  const session = seedSession(header, events.slice(0, boundary))

  console.log(`\n=== ${header.id} — ${compactionSeqs.length} compaction(s) ===`)

  const targets = new Set()
  for (const seq of compactionSeqs) {
    targets.add(seq)
    // The settlement immediately preceding each boundary.
    let previous
    for (const event of events) {
      if (event.seq >= seq) break
      if (event.type === 'assistant/message' && event.data.usage !== undefined) previous = event.seq
    }
    if (previous !== undefined) targets.add(previous)
  }

  for (const event of events.slice(boundary)) {
    appendRecorded(session, event)
    if (!targets.has(event.seq)) continue

    const route = routeAt(timeline, event.seq)
    const threshold = route === undefined ? null : compactionThreshold({
      contextWindow: route.contextWindow,
      reservedCompletionTokens: route.maxTokens ?? 0,
      headroomTokens: 65536,
      thresholdRatio: 0.8,
    })
    const measured = meter.measure(session)
    const now = reach(meter, pruner, session)
    const over = threshold === null ? null : measured.totalTokens - threshold
    const label = event.type === 'compaction/start' ? 'COMPACTION/START' : `settlement (${event.type})`

    console.log(`  seq ${String(event.seq).padStart(6)} ${label.padEnd(26)} total=${String(measured.totalTokens).padStart(7)} threshold=${String(threshold).padStart(6)} over=${String(over).padStart(7)} thresholdCrossed=${over !== null && over >= 0} reclaimLeft=${String(now.reclaim).padStart(6)} overBudgetNodes=${now.overBudget} surfaceNodes=${session.surface.nodes.length}`)
  }

  // Which compaction paths recorded a marker that identifies the trigger?
  const markers = events.filter((event) => /^compaction\//.test(event.type))
  const byCompactionId = new Map()
  for (const event of markers) {
    const id = event.data?.compactionId ?? '(none)'
    byCompactionId.set(id, (byCompactionId.get(id) ?? []).concat([event.type]))
  }
  console.log('  compaction id -> event sequence:')
  for (const [id, types] of byCompactionId) console.log(`    ${String(id).slice(0, 12)} : ${types.join(' -> ')}`)

  await ctx.fiber.dispose()
}
