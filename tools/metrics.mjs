/**
 * Pure measurement helpers shared by every tool in this directory.
 *
 * Everything here is derived from code the harness actually runs, not from
 * documentation: the constants and formulas carry a source reference so a
 * reader can re-verify each one against the installed package.
 *
 * @module tools/metrics
 */

/**
 * Prompt-side pressure of one request: input plus cache traffic, no output.
 *
 * Source: `@deepseek-ai/dsh-token-meter`, `pressureFrom` —
 * `usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)`.
 *
 * @param usage - the `data.usage` of an `assistant/message` event.
 * @returns prompt-side pressure in tokens.
 */
export function pressureOf(usage) {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** compaction-basic's shipped defaults. Source: `resolveConfig` in its `lib/index.js`. */
export const COMPACTION_DEFAULTS = Object.freeze({
  /** `DEFAULT_THRESHOLD_RATIO`. */
  thresholdRatio: 0.8,
  /** `headroomTokens` default. */
  headroomTokens: 65536,
})

/**
 * Resolve compaction-basic's pressure threshold exactly as the service does.
 *
 * Source: `resolveCompactSpec` in `@deepseek-ai/dsh-compaction-basic`:
 *   messageBudget  = contextWindow - reservedCompletionTokens
 *   pressureBudget = messageBudget - headroomTokens
 *   thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudget))
 *
 * A non-positive `pressureBudget` is a configuration error in the harness (it
 * throws `TargetPressureConfigError`), so a non-positive result is reported as
 * `null` — "compaction cannot run on this route" — rather than as a threshold.
 *
 * @param input - resolved window, output reservation, headroom, and ratio.
 * @returns the threshold in tokens, or null when no pressure budget exists.
 */
export function compactionThreshold({ contextWindow, reservedCompletionTokens, headroomTokens, thresholdRatio }) {
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  const pressureBudgetTokens = messageBudgetTokens - headroomTokens
  if (messageBudgetTokens <= 0 || pressureBudgetTokens <= 0) return null
  return Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudgetTokens))
}

/**
 * Resolve `reservedCompletionTokens` the way compaction-basic does.
 *
 * Source: `reservedCompletionTokens(agent, defaultMaxTokens)` —
 * `session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0`.
 * `defaultMaxTokens` comes from the adapter's resolved model info; the recorded
 * logs do not carry it, so it is reported as an explicit assumption instead of
 * being invented per sample.
 *
 * @param headerMaxTokens - `config.maxTokens` on the effective request header.
 * @param adapterDefault - adapter default, when known.
 * @returns the reservation in tokens.
 */
export function reservedCompletionTokens(headerMaxTokens, adapterDefault) {
  return headerMaxTokens ?? adapterDefault ?? 0
}

/**
 * Build the route-and-window timeline from `request/header` and `request/context`.
 *
 * A session can be routed to more than one model, and each route declares its
 * own window, so the window in force at a given log position is the one
 * belonging to the header most recently folded before it.
 *
 * @param events - a decoded event list, in log order.
 * @returns entries of `{ seq, time, provider, model, maxTokens, contextWindow }`.
 */
export function routeTimeline(events) {
  const windows = new Map()
  for (const event of events) {
    if (event.type !== 'request/context') continue
    windows.set(`${event.data.provider}\u0000${event.data.model}`, event.data.contextWindow)
  }
  const timeline = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = event.data.header?.config
    if (config?.provider === undefined || config?.model === undefined) continue
    timeline.push({
      seq: event.seq,
      time: event.time,
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      contextWindow: windows.get(`${config.provider}\u0000${config.model}`),
    })
  }
  return timeline
}

/**
 * The routed request envelope in force at one log position.
 *
 * @param timeline - a {@link routeTimeline} result.
 * @param seq - the log position to resolve.
 * @returns the effective route entry, or undefined before the first header.
 */
export function routeAt(timeline, seq) {
  let current
  for (const entry of timeline) {
    if (entry.seq > seq) break
    current = entry
  }
  return current
}

/**
 * Count surface nodes that are `tool/result` events and measure their text.
 *
 * This is the population `estimateRemovable()` in the plugin considers: only
 * `tool/result` nodes, only `type: 'text'` blocks, minus a per-node threshold.
 *
 * @param nodes - surface node seqs.
 * @param eventAt - `(seq) => event`.
 * @param deriveMessage - `(event) => message | null` (the harness's own derivation).
 * @param thresholdChars - the pruner's per-node character threshold.
 * @returns `{ candidates, charsRemovable, perNode }`.
 */
export function estimateRemovable(nodes, eventAt, deriveMessage, thresholdChars) {
  const perNode = []
  let removable = 0
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = deriveMessage(event)
    if (message === null || !Array.isArray(message.content)) continue
    let chars = 0
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    }
    perNode.push({ seq, chars, over: Math.max(0, chars - thresholdChars) })
    if (chars > thresholdChars) removable += chars - thresholdChars
  }
  return { candidates: perNode.length, charsRemovable: removable, perNode }
}
