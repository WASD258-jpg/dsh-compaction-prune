/**
 * Decompose the token pressure at a session's real compaction boundaries.
 *
 * The counterfactual says pruning cannot close the gap. This shows WHY, from the
 * meter's own per-node pricing:
 *
 *   - `totalTokens` is what compaction compares, and it is dominated by the
 *     provider's reported input tokens, not by the surface the meter prices;
 *   - the plugin can only reclaim text from `tool/result` surface nodes;
 *   - `theoreticalReclaim` is the MAXIMUM any pruner could take at that instant,
 *     shrinking every over-threshold node to exactly its budget.
 *
 * Run: `node tools/decompose.mjs [sessionIdPrefix]`
 *
 * @module tools/decompose
 */

import { readSessionLog, listSessionLogs } from './session-log.mjs'
import { appendRecorded, seedBoundary, seedSession } from './replay.mjs'
import { mountChain } from './a2-counterfactual.mjs'
import { compactionThreshold, routeAt, routeTimeline } from './metrics.mjs'
import { SESSIONS_ROOT } from './corpus.mjs'

// SESSIONS_ROOT comes from ./corpus.mjs, which resolves it from DSH_SESSIONS_ROOT or DSH_HOME.

/** The category a surface node's event belongs to, for the breakdown. */
function kindOf(event) {
  switch (event.type) {
    case 'system/message': return 'system'
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/result': return 'toolResult'
    default: return event.type
  }
}

const filter = process.argv[2] ?? 'c0acb35e'
const log = listSessionLogs(SESSIONS_ROOT).find((item) => item.sessionId.includes(filter))
if (log === undefined) throw new Error(`no session matches "${filter}"`)

const { header, events } = readSessionLog(log.path)
const { ctx, meter, pruner } = await mountChain()

const timeline = routeTimeline(events)
const boundary = seedBoundary(header, events)
const session = seedSession(header, events.slice(0, boundary))

console.log(`session ${log.sessionId}`)
console.log(`events ${events.length}, seed boundary ${boundary}, route entries ${timeline.length}`)

const boundaries = new Set(events.filter((event) => event.type === 'compaction/start').map((event) => event.seq))
const marks = []

for (const event of events.slice(boundary)) {
  appendRecorded(session, event)
  if (!boundaries.has(event.seq)) continue

  const measured = meter.measure(session)
  const route = routeAt(timeline, event.seq)
  const byKind = new Map()
  let toolResultTokens = 0
  let toolResultChars = 0
  let theoreticalReclaim = 0
  let overThresholdNodes = 0

  for (const node of measured.nodes) {
    const nodeEvent = session.eventAt(node.seq)
    const kind = kindOf(nodeEvent)
    byKind.set(kind, (byKind.get(kind) ?? 0) + node.tokens)
    if (kind !== 'toolResult') continue
    toolResultTokens += node.tokens
    const message = session.deriveEventMessage(nodeEvent)
    let chars = 0
    for (const block of message.content ?? []) if (block.type === 'text') chars += block.text.length
    toolResultChars += chars
    const pruned = pruner.pruneContent(message.content)
    if (pruned === null) continue
    overThresholdNodes += 1
    theoreticalReclaim += Math.max(0, node.tokens - meter.estimateMessage({ ...message, content: pruned }))
  }

  marks.push({
    seq: event.seq,
    turn: event.data.turn,
    totalTokens: measured.totalTokens,
    baselineKind: measured.baseline.kind,
    baselineTokens: measured.baseline.tokens,
    surfaceTokens: measured.surfaceTokens,
    threshold: route === undefined ? null : compactionThreshold({
      contextWindow: route.contextWindow,
      reservedCompletionTokens: route.maxTokens ?? 0,
      headroomTokens: 65536,
      thresholdRatio: 0.8,
    }),
    byKind: Object.fromEntries([...byKind].sort((left, right) => right[1] - left[1])),
    toolResultTokens,
    toolResultChars,
    overThresholdNodes,
    theoreticalReclaim,
  })
}

await ctx.fiber.dispose()

console.log('\n=== pressure decomposition at each real compaction ===')
for (const mark of marks) {
  const over = mark.threshold === null ? null : mark.totalTokens - mark.threshold
  console.log(`\n--- compaction at seq ${mark.seq} (turn ${mark.turn}) ---`)
  console.log(`  totalTokens (what compaction compares)     ${mark.totalTokens}`)
  console.log(`    = baseline (${mark.baselineKind})          ${mark.baselineTokens}`)
  console.log(`    + surface delta                          ${mark.totalTokens - mark.baselineTokens}`)
  console.log(`  compaction threshold                       ${mark.threshold}`)
  console.log(`  over the threshold by                      ${over}`)
  console.log(`  surface node tokens (meter's own sum)      ${mark.surfaceTokens}`)
  console.log(`  priced nodes by kind                       ${JSON.stringify(mark.byKind)}`)
  console.log(`  tool/result share of surface               ${(100 * mark.toolResultTokens / mark.surfaceTokens).toFixed(2)}%`)
  console.log(`  tool/result tokens                         ${mark.toolResultTokens} (${mark.toolResultChars} chars)`)
  console.log(`  nodes over the 8192-char budget            ${mark.overThresholdNodes}`)
  console.log(`  MAX any pruner could reclaim here          ${mark.theoreticalReclaim}`)
  console.log(`  shortfall (over-threshold - max reclaim)   ${over - mark.theoreticalReclaim}`)
}
