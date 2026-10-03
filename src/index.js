/**
 * Proactive tool-result pruning, to reduce how often automatic compaction fires.
 *
 * WHY THIS EXISTS
 *
 * A session whose compaction fails repeatedly is a session in trouble. The corpus
 * analysed in dsh-compaction-guide shows a 17.6% compaction success rate, with
 * retries that never back off. No plugin can add that backoff: the compaction call
 * runs inside `compaction-basic`'s own `agent/pre-step` listener body, before its
 * `next()`, so no extension point can suppress an attempt.
 *
 * What a plugin *can* do is reduce the NUMBER of attempts. Tool results are
 * usually the largest part of a long agent session, and compaction already runs
 * the pruner before summarizing. Running it earlier — while there is still
 * headroom — means fewer threshold crossings, and therefore fewer chances to
 * fail.
 *
 * WHAT THIS IS NOT
 *
 * It is not a circuit breaker. It does not add backoff, does not stop a failing
 * compaction from retrying, and does not prevent the summarization request from
 * overflowing. It changes how often compaction is triggered, not what happens
 * when it fails. See README.md for the full statement of limits.
 *
 * WHY THE WINDOW IS CACHED
 *
 * The trigger ratio needs the model's context window, which comes from
 * `ctx.llm.resolveModelInfo()` — an ASYNC call. `session/event` is a synchronous
 * hook, so the window cannot be resolved there. It is instead resolved once per
 * route, cached, and the plugin stays inactive until it has a value. This is
 * deliberate: acting on a guessed window would be worse than not acting.
 *
 * WHY A SERVICE CLASS RATHER THAN A FUNCTION PLUGIN
 *
 * Cordis reads a plugin's configuration from `static Config` on a service class.
 * The function-plugin form exports `name`/`inject`/`apply` and receives no
 * validated configuration — the shipped function plugins that need settings keep
 * them in a closure instead. This plugin needs deployer-tunable settings, so it
 * is a service class.
 *
 * @module dsh-compaction-prune
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Defaults are conservative: pruning too eagerly destroys context the agent may
 * still need, and pruning too rarely has no effect. */
export const DEFAULTS = Object.freeze({
  /**
   * Fraction of the context window at which to prune. Compaction typically fires
   * near 0.5–0.8 of the window; 0.35 leaves clear separation so this plugin acts
   * strictly before compaction's own decision.
   */
  triggerRatio: 0.35,
  /**
   * Minimum characters a prune must be able to remove to be worthwhile. A prune
   * that reclaims almost nothing costs a surface rewrite for no benefit.
   */
  minimumCharsRemoved: 2048,
  /** Minimum time between prunes, so a burst of tool results cannot cause one
   * surface rewrite per event. */
  cooldownMs: 60_000,
  /**
   * `off` — do nothing. `warn` — evaluate and log what a prune would do, without
   * mutating the session. `prune` — perform it.
   *
   * Defaults to `warn`: this plugin mutates durable session state, so a deployer
   * should observe its decisions on real traffic first.
   */
  mode: 'warn',
})

/** The public configuration key set. Used to reject unknown keys explicitly. */
export const CONFIG_KEYS = Object.freeze([
  'triggerRatio',
  'minimumCharsRemoved',
  'cooldownMs',
  'mode',
])

/**
 * Configuration schema.
 *
 * schemastery's `z.object()` accepts unknown keys silently, so the schema alone
 * would let a misspelled `triggerRatio` through with no error and no pruning.
 * `validateConfig()` rejects unknown keys explicitly — the same approach the
 * harness's own `compaction-basic` takes, rather than relying on the schema for
 * a check it does not perform.
 */
export const Config = z.object({
  triggerRatio: z.number().min(0.05).max(0.95).default(DEFAULTS.triggerRatio),
  minimumCharsRemoved: z.number().step(1).min(0).default(DEFAULTS.minimumCharsRemoved),
  cooldownMs: z.number().step(1).min(0).default(DEFAULTS.cooldownMs),
  mode: z.union([
    z.const('off'),
    z.const('warn'),
    z.const('prune'),
  ]).default(DEFAULTS.mode),
})

/**
 * Reject unknown configuration keys, then apply the schema.
 *
 * @param raw - untrusted configuration.
 * @returns the validated configuration.
 * @throws when a key is not part of the public set, or the schema rejects a value.
 */
export function validateConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('CompactionPruneConfig: configuration must be an object')
  }
  const allowed = new Set(CONFIG_KEYS)
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw new Error(
        `CompactionPruneConfig: unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`,
      )
    }
  }
  return Config(config)
}

/**
 * Decide whether a prune is warranted.
 *
 * Split from the side effect so the decision is testable without a live session,
 * and so `warn` mode reports exactly what `prune` mode would have done.
 *
 * Every branch that lacks information returns `act: false`. This plugin observes
 * a session that may already be in trouble; adding a new failure mode on top of
 * that would be worse than doing nothing.
 *
 * @param input - measurement, config, and per-session state.
 * @returns the decision and the reason for it.
 */
export function decide({ totalTokens, contextWindow, charsRemovable, config, lastPruneAt, now }) {
  if (config.mode === 'off') return { act: false, reason: 'mode is off' }

  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    // No resolved window: fail closed. The harness falls back to 262144 for
    // unknown models, but inheriting that guess would make this plugin act on a
    // number it cannot justify.
    return { act: false, reason: 'context window unresolved' }
  }
  if (!Number.isFinite(totalTokens) || totalTokens < 0) {
    return { act: false, reason: 'token measurement unavailable' }
  }

  const triggerTokens = Math.floor(contextWindow * config.triggerRatio)
  if (totalTokens < triggerTokens) {
    return { act: false, reason: `below trigger (${totalTokens} < ${triggerTokens})` }
  }

  if (lastPruneAt !== undefined && now - lastPruneAt < config.cooldownMs) {
    return { act: false, reason: `cooling down (${now - lastPruneAt}ms of ${config.cooldownMs}ms)` }
  }

  if (!Number.isFinite(charsRemovable) || charsRemovable < config.minimumCharsRemoved) {
    return {
      act: false,
      reason: `not worthwhile (${charsRemovable ?? 'unknown'} < ${config.minimumCharsRemoved} chars)`,
    }
  }

  return {
    act: true,
    reason: `${totalTokens} >= ${triggerTokens}, ${charsRemovable} chars removable`,
    triggerTokens,
  }
}

/**
 * Estimate how many characters a prune would remove, without mutating anything.
 *
 * Mirrors the pruner's own `thresholdChars` test so the decision and the action
 * agree. It is an ESTIMATE: the pruner recomputes exactly when it runs and may
 * remove slightly less.
 *
 * @param session - session whose surface to inspect.
 * @param pruner - the mounted pruner, read for its resolved config.
 * @returns removable character count, floored at 0.
 */
export function estimateRemovable(session, pruner) {
  const thresholdChars = pruner?.config?.thresholdChars
  if (!Number.isFinite(thresholdChars)) return 0

  let removable = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)
    if (message === null || !Array.isArray(message.content)) continue
    let chars = 0
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length
    }
    if (chars > thresholdChars) removable += chars - thresholdChars
  }
  return removable
}

/**
 * Proactive pruning service.
 *
 * A service class, so Cordis reads `Config` and passes the validated
 * configuration to the constructor. The service itself exposes only diagnostics
 * — its work happens on the `session/event` hook it installs.
 */
export class CompactionPrune extends Service {
  /**
   * No `static inject`: this plugin must load in a composition that has no
   * compaction at all, and Cordis's `inject` declares a hard dependency — a
   * missing service would prevent the plugin from loading. Optional access goes
   * through `ctx.get()` in the observer instead, which returns `undefined` for an
   * unmounted service.
   */
  static Config = Config

  /** Validated configuration, frozen after construction. */
  config

  /**
   * State is held in ordinary (non-private) fields.
   *
   * `Service` instances are reached through Cordis's property proxy, which does
   * not forward `#private` slots — a private field read through the proxy throws
   * "Cannot read private member ... from an object whose class did not declare
   * it". These fields are implementation detail by convention, marked with a
   * leading underscore rather than enforced by the language.
   */
  _windowByRoute = new Map()

  /** Routes currently being resolved, so concurrent events do not duplicate work. */
  _pending = new Set()

  /** Per-session timestamp of the last prune. Weak so ended sessions are collectable. */
  _lastPrune = new WeakMap()

  /** Sessions already warned about an unresolvable window, to avoid log spam. */
  _warnedNoWindow = new WeakSet()

  /** Counters for diagnostics. */
  _stats = { evaluated: 0, acted: 0, skipped: 0 }

  /**
   * @param ctx - the plugin context.
   * @param config - validated configuration from {@link Config}.
   */
  constructor(ctx, config) {
    super(ctx, 'compactionPrune')
    // Validate again here. The Loader validates through `Config`, but a bare
    // `ctx.plugin(Service, rawConfig)` does not, and an unvalidated config must
    // not silently produce a plugin that never acts.
    this.config = Object.freeze({ ...DEFAULTS, ...validateConfig(config) })
    this._install()
  }

  /** Current counters, for diagnostics. */
  get stats() {
    return { ...this._stats, routes: this._windowByRoute.size }
  }

  /** Install the session observer. */
  _install() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => {
      try {
        this._observe(session, event)
      } catch (error) {
        // An observer must never become a new way for a session to fail. The turn
        // already has whatever failure it has; replacing it would be worse than
        // silence. Log at debug so a healthy deployment stays quiet.
        ctx.logger.debug('compaction-prune: observer error: %s', error?.message ?? error)
      }
    })
  }

  /**
   * Resolve and cache the context window for a route.
   *
   * Fire-and-forget by design: `resolveModelInfo` is async and `session/event` is
   * synchronous, so the plugin acts on the NEXT event once a value exists rather
   * than blocking this one.
   *
   * @param route - `provider\0model`, or undefined when the header is absent.
   */
  _ensureWindow(route) {
    if (route === undefined || this._windowByRoute.has(route) || this._pending.has(route)) return
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    this._pending.add(route)
    const [provider, model] = route.split('\u0000')
    Promise.resolve(llm.resolveModelInfo(provider, model))
      .then((info) => {
        const window = info?.context?.contextWindow
        this._windowByRoute.set(route, Number.isInteger(window) && window > 0 ? window : null)
      })
      .catch(() => this._windowByRoute.set(route, null))
      .finally(() => this._pending.delete(route))
  }

  /**
   * Evaluate one session event and act if warranted.
   *
   * @param session - the session that emitted the event.
   * @param event - the emitted event.
   */
  _observe(session, event) {
    if (this.config.mode === 'off') return
    if (event.type !== 'tool/result' && event.type !== 'assistant/message') return

    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return

    const callConfig = session.requestHeader()?.config
    const route = callConfig?.provider !== undefined && callConfig?.model !== undefined
      ? `${callConfig.provider}\u0000${callConfig.model}`
      : undefined
    this._ensureWindow(route)

    const contextWindow = route === undefined ? undefined : this._windowByRoute.get(route)
    if (contextWindow === null && !this._warnedNoWindow.has(session)) {
      this._warnedNoWindow.add(session)
      this.ctx.logger.debug(
        'compaction-prune: no context window for %s; staying inactive for this session',
        route ?? '(no route)',
      )
    }

    let measurement
    try {
      measurement = meter.measure(session)
    } catch (error) {
      this.ctx.logger.debug('compaction-prune: measurement failed: %s', error?.message ?? error)
      return
    }

    const pruner = this.ctx.get('toolResultPruner')
    const charsRemovable = pruner === undefined ? 0 : estimateRemovable(session, pruner)

    const decision = decide({
      totalTokens: measurement.totalTokens,
      contextWindow: contextWindow ?? undefined,
      charsRemovable,
      config: this.config,
      lastPruneAt: this._lastPrune.get(session),
      now: Date.now(),
    })

    this._stats.evaluated += 1

    if (!decision.act) {
      this._stats.skipped += 1
      this.ctx.logger.debug('compaction-prune: skipped — %s', decision.reason)
      return
    }

    if (this.config.mode === 'warn') {
      this._stats.acted += 1
      this._lastPrune.set(session, Date.now())
      this.ctx.logger.info('compaction-prune: would prune — %s', decision.reason)
      return
    }

    try {
      const result = pruner.pruneSession(session)
      this._lastPrune.set(session, Date.now())
      this._stats.acted += 1
      this.ctx.logger.info(
        'compaction-prune: pruned %d node(s), %d chars removed — %s',
        result.pruned.length,
        result.charsRemoved,
        decision.reason,
      )
    } catch (error) {
      // The pruner rejects a replacement that is not smaller, among other checks.
      // A failed proactive prune must never surface as a session failure.
      this.ctx.logger.warn('compaction-prune: prune failed: %s', error?.message ?? error)
    }
  }
}

export default CompactionPrune


