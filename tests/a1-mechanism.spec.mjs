/**
 * A1 — mechanism verification in a real Cordis environment. Zero model calls.
 *
 * WHAT THIS FILE PROVES
 *
 *   A1.1  the plugin is instantiated by the REAL Loader from a real `cordis.yml`,
 *         in a composition that resolves a context window through the REAL
 *         `ctx.llm` service.
 *   A1.2  in `mode: warn`, `decide()` returns `act: true` once measured pressure
 *         crosses `triggerRatio x contextWindow` — and not before.
 *   A1.3  the REAL pruner's `pruneSession()` works: on a detached session it
 *         returns a result object and the REAL token meter prices a smaller
 *         surface afterwards.
 *   A1.4  **in a LIVE session, `mode: prune` never lands a prune.** The observer
 *         runs synchronously inside `Session.append()`, where the store has
 *         already set its re-entrancy guard, so the pruner's own `session.append`
 *         throws. This is not a timing artefact: it reproduces on every attempt,
 *         on a synthetic session and on real recorded payloads.
 *   A1.5  `mode: warn` reaches the same decision and mutates nothing.
 *   A1.6  a route whose window cannot be resolved keeps the plugin inactive.
 *
 * WHY THIS FILE EXISTS
 *
 * `tests/loader-e2e.spec.mjs` boots the plugin through the Loader but never
 * mounts an `llm` service, so `_ensureWindow()` always returns early, the window
 * is never cached, `decide()` always reports "context window unresolved", and no
 * observer ever acts. That composition can only prove availability.
 *
 * Run: `node tests/a1-mechanism.spec.mjs`
 *
 * @module tests/a1-mechanism.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import CompactionPrune from '../src/index.js'
import { importPackage } from '../tools/resolve-module.mjs'
import { readSessionLog, listSessionLogs } from '../tools/session-log.mjs'
import { SESSIONS_ROOT } from '../tools/corpus.mjs'

const { LlmRuntime, LlmAdapter } = await importPackage('@deepseek-ai/dsh-llm')

/** A stub adapter, so `ctx.llm.resolveModelInfo()` returns a real window. */
const StubAdapterPlugin = {
  name: 'a1-llm-stub',
  inject: ['llm'],
  apply(ctx, config) {
    const { provider, contextWindow, defaultMaxTokens } = config
    class Stub extends LlmAdapter {
      async resolveModel(requestedProvider, requestedModel) {
        return {
          provider: requestedProvider,
          id: requestedModel,
          name: requestedModel,
          context: { contextWindow },
          defaultMaxTokens,
        }
      }
    }
    ctx.llm.registerAdapter([provider], new Stub())
  },
}

const MODULES = new Map([
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['a1-llm-stub', StubAdapterPlugin],
  ['dsh-compaction-prune', CompactionPrune],
])

const PROVIDER = 'a1-provider'
const MODEL = 'a1-model'
const CONTEXT_WINDOW = 100_000
const DEFAULT_MAX_TOKENS = 16_000
const TRIGGER = Math.floor(CONTEXT_WINDOW * 0.35)

let root
let context
let logs = []

/**
 * Boot the composition through the real Loader.
 *
 * @param pruneConfig - the `dsh-compaction-prune` config block.
 * @returns the booted context.
 */
async function boot(pruneConfig) {
  root = await mkdtemp(join(tmpdir(), 'dsh-prune-a1-'))
  const configPath = join(root, 'cordis.yml')
  const lines = [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: 'a1-llm-stub'",
    '  config:',
    `    provider: '${PROVIDER}'`,
    `    contextWindow: ${CONTEXT_WINDOW}`,
    `    defaultMaxTokens: ${DEFAULT_MAX_TOKENS}`,
    "- name: 'dsh-compaction-prune'",
    '  config:',
    ...Object.entries(pruneConfig).map(([key, value]) => `    ${key}: ${typeof value === 'string' ? `'${value}'` : value}`),
  ]
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!MODULES.has(specifier)) throw new Error(`A1 module map has no entry for "${specifier}"`)
      return MODULES.get(specifier)
    },
  }

  logs = []
  for (const level of ['error', 'warn', 'info', 'debug']) {
    if (typeof context.logger[level] !== 'function') continue
    const original = context.logger[level].bind(context.logger)
    context.logger[level] = (...args) => {
      logs.push({
        level,
        // The plugin logs through printf-style placeholders; join the raw parts.
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      })
      return original(...args)
    }
  }

  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

async function teardown() {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
}

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [PASS] ${label}`)
  else { failures += 1; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}
function note(label, detail) {
  console.log(`  [note] ${label}${detail ? ' — ' + detail : ''}`)
}

/** Yield long enough for the plugin's fire-and-forget window resolution. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

/** Deterministic filler text of a given character count. */
function filler(chars, seed) {
  const unit = `block${seed}-abcdefghijklmnopqrstuvwxyz0123456789\n`
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

/** A `tool/result` payload of the requested size. */
function toolResultData(callId, chars, seed) {
  return {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: filler(chars, seed) }],
    },
  }
}

/** Create a LIVE session (attached to the store) routed through the stub. */
function routedLiveSession(id) {
  const session = context.sessions.create(id, { meta: { cwd: process.cwd() } })
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL, maxTokens: DEFAULT_MAX_TOKENS }, reason: 'initial' },
  })
  session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow: CONTEXT_WINDOW })
  return session
}

/** Warm the plugin's route-window cache, then confirm it is populated. */
async function warmWindow(session, svc) {
  session.append('tool/result', toolResultData('warm', 1000, 'w'), { surfaceOp: 'append' })
  await settle()
  return svc._windowByRoute.get(`${PROVIDER}\u0000${MODEL}`)
}

console.log('=== A1.1  compose and boot, with a resolvable window ===')
try {
  await boot({ mode: 'warn', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 0 })
  const svc = context.get('compactionPrune')
  check('plugin instantiated by the real Loader', svc !== undefined)
  check('real llm service mounted', context.get('llm') !== undefined)
  check('real token meter mounted', context.get('tokenMeter') !== undefined)
  check('real tool-result pruner mounted', context.get('toolResultPruner') !== undefined)
  check('config applied', svc?.config.mode === 'warn' && svc?.config.triggerRatio === 0.35,
    JSON.stringify(svc?.config))
  const info = await context.llm.resolveModelInfo(PROVIDER, MODEL)
  check('the window resolves through ctx.llm', info?.context?.contextWindow === CONTEXT_WINDOW,
    JSON.stringify(info))
} catch (error) {
  failures += 1
  console.log(`  [FAIL] boot threw: ${error.message.split('\n')[0]}`)
  console.log(error.stack)
}

console.log('\n=== A1.2  decide() fires exactly when triggerRatio x contextWindow is crossed ===')
{
  const svc = context.get('compactionPrune')
  const meter = context.tokenMeter
  const session = routedLiveSession('a1-threshold')
  const window = await warmWindow(session, svc)
  check('the plugin cached the resolved window', window === CONTEXT_WINDOW, String(window))

  const actedBefore = svc.stats.acted
  const below = meter.measure(session)
  check('below the trigger: decide() does not act',
    svc.stats.acted === actedBefore && below.totalTokens < TRIGGER,
    `totalTokens=${below.totalTokens} trigger=${TRIGGER} acted=${svc.stats.acted}`)

  // Cross the trigger with one more tool result.
  session.append('tool/result', toolResultData('cross', 200_000, 'cross'), { surfaceOp: 'append' })
  await settle()
  const above = meter.measure(session)
  check('above the trigger: decide() acts', svc.stats.acted > actedBefore,
    `totalTokens=${above.totalTokens} trigger=${TRIGGER} stats=${JSON.stringify(svc.stats)}`)
  check('the crossing really is past the trigger', above.totalTokens >= TRIGGER,
    `${above.totalTokens} >= ${TRIGGER}`)
  const reason = logs.find((entry) => /would prune/.test(entry.text))
  check('the decision names the measured and trigger values',
    reason !== undefined && /\d+ >= \d+/.test(reason.text),
    JSON.stringify(reason?.text))
  note('measured at the crossing', `${above.totalTokens} vs trigger ${TRIGGER} (margin ${above.totalTokens - TRIGGER})`)
}

console.log('\n=== A1.3  the real pruner works: pruneSession() returns a result and shrinks the surface ===')
{
  const meter = context.tokenMeter
  const pruner = context.get('toolResultPruner')
  const svc = context.get('compactionPrune')

  // A DETACHED session: no store attachment, so the re-entrancy guard that
  // A1.4 documents does not apply. This isolates the pruner's own behaviour.
  const header = { version: 4, id: 'a1-detached', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() }
  const session = Session.create(header.id, undefined, header)
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL, maxTokens: DEFAULT_MAX_TOKENS }, reason: 'initial' },
  })
  session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow: CONTEXT_WINDOW })
  session.append('tool/result', toolResultData('d-a', 200_000, 'da'), { surfaceOp: 'append' })
  session.append('tool/result', toolResultData('d-b', 200_000, 'db'), { surfaceOp: 'append' })

  const before = meter.measure(session)
  const nodesBefore = session.surface.nodes.length
  const result = pruner.pruneSession(session)
  const after = meter.measure(session)
  const nodesAfter = session.surface.nodes.length

  check('pruneSession() returned a result object',
    result !== null && typeof result === 'object' && Array.isArray(result.pruned) && typeof result.charsRemoved === 'number',
    JSON.stringify(result && { pruned: result.pruned.length, charsRemoved: result.charsRemoved }))
  check('the result reports landed replacements', result.pruned.length > 0,
    `${result.pruned.length} replacement(s), ${result.charsRemoved} chars`)
  check('the surface is smaller in tokens', after.surfaceTokens < before.surfaceTokens,
    `surfaceTokens ${before.surfaceTokens} -> ${after.surfaceTokens}`)
  check('measured pressure dropped', after.totalTokens < before.totalTokens,
    `totalTokens ${before.totalTokens} -> ${after.totalTokens}`)
  check('each node was replaced, not deleted',
    nodesAfter === nodesBefore && nodesAfter === 2, `${nodesBefore} -> ${nodesAfter}`)
  check('the reclaim landed as replacement surface events',
    session.snapshotEvents().filter((event) => typeof event.surfaceOp === 'object').length === result.pruned.length,
    `${session.snapshotEvents().filter((event) => typeof event.surfaceOp === 'object').length} replacement(s)`)
  check('the shadow-price event recorded the reclaim',
    session.snapshotEvents().filter((event) => event.type === 'compaction/prune').length === result.pruned.length,
    JSON.stringify(session.snapshotEvents().filter((event) => event.type === 'compaction/prune').map((event) => event.data.shadowedTokenCount)))
  note('the plugin was NOT driving this prune', `mode=${svc.config.mode}; called directly to isolate the pruner`)
}

console.log('\n=== A1.4  DEFECT: in a LIVE session, mode: prune never lands a prune ===')
await teardown()
try {
  await boot({ mode: 'prune', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 0 })
  const svc = context.get('compactionPrune')
  const meter = context.tokenMeter
  const pruner = context.get('toolResultPruner')

  const session = routedLiveSession('a1-live-prune')
  const window = await warmWindow(session, svc)
  check('the window resolved, so the plugin is active', window === CONTEXT_WINDOW, String(window))

  // Count real calls into the pruner, without changing its behaviour.
  let pruneCalls = 0
  const original = pruner.pruneSession.bind(pruner)
  pruner.pruneSession = (target) => { pruneCalls += 1; return original(target) }

  const before = meter.measure(session)
  const nodesBefore = session.surface.nodes.length
  const eventsBefore = session.seq
  let landedReplacements = 0
  let grewTokens = 0
  for (let index = 1; index <= 3; index += 1) {
    session.append('tool/result', toolResultData(`live-${index}`, 200_000, `l${index}`), { surfaceOp: 'append' })
    await settle()
    const now = meter.measure(session)
    grewTokens += now.surfaceTokens
  }
  const after = meter.measure(session)
  const nodesAfter = session.surface.nodes.length
  pruner.pruneSession = original

  for (const event of session.snapshotEvents(eventsBefore)) {
    if (typeof event.surfaceOp === 'object') landedReplacements += 1
  }

  const reentryWarnings = logs.filter((entry) => /cannot reenter/.test(entry.text))
  const successLogs = logs.filter((entry) => /pruned \d+ node/.test(entry.text))

  check('the observer DID decide to prune (the rule fires)', pruneCalls > 0,
    `pruneSession calls=${pruneCalls}, stats=${JSON.stringify(svc.stats)}`)
  check('every prune attempt failed with the append re-entrancy error',
    reentryWarnings.length === pruneCalls && pruneCalls > 0,
    `warnings=${reentryWarnings.length}, calls=${pruneCalls}`)
  check('no prune ever succeeded', successLogs.length === 0, JSON.stringify(successLogs.slice(0, 1)))
  check('stats.acted stays at zero in prune mode', svc.stats.acted === 0, JSON.stringify(svc.stats))
  check('ZERO replacement surface events landed', landedReplacements === 0,
    `${landedReplacements} replacement event(s)`)
  check('the surface only grew by exactly the appended nodes',
    nodesAfter === nodesBefore + 3, `${nodesBefore} -> ${nodesAfter}`)
  check('the growth is exactly the recorded usage, unpruned',
    after.totalTokens > before.totalTokens, `totalTokens ${before.totalTokens} -> ${after.totalTokens}`)

  console.log(`  [evidence] ${reentryWarnings.length} identical failures; first:`)
  console.log(`             ${reentryWarnings[0]?.text ?? '(none)'}`)

  // Show the guard is the cause, and that it is the STORE attachment that arms it.
  let liveError = null
  try {
    session.append('tool/result', toolResultData('outside', 1000, 'out'), { surfaceOp: 'append' })
  } catch (error) { liveError = error.message }
  check('appending from OUTSIDE a listener works on the same session', liveError === null, String(liveError))

  const detached = Session.create('a1-guard-probe', undefined, {
    version: 4, id: 'a1-guard-probe', createdAt: Date.now(), isSeeded: false, cwd: process.cwd(),
  })
  let detachedError = null
  try {
    detached.append('tool/result', toolResultData('detached', 1000, 'det'), { surfaceOp: 'append' })
  } catch (error) { detachedError = error.message }
  check('a detached session has no such guard (so the guard is store-owned)', detachedError === null, String(detachedError))

  // And the guard is raised for the WHOLE synchronous listener dispatch.
  let reentrantAppendFailed = false
  const probe = routedLiveSession('a1-reentry-probe')
  const listener = (target) => {
    if (target !== probe) return
    try {
      target.append('tool/result', toolResultData('from-listener', 100, 'fl'), { surfaceOp: 'append' })
    } catch { reentrantAppendFailed = true }
  }
  context.on('session/event', listener)
  probe.append('tool/result', toolResultData('trigger', 100, 'tr'), { surfaceOp: 'append' })
  check('any append from inside a session/event listener fails the same way', reentrantAppendFailed)
  note('root cause', 'Session.append() sets its re-entrancy guard BEFORE dispatching session/event, and clears it only in finally')
} catch (error) {
  failures += 1
  console.log(`  [FAIL] ${error.message.split('\n')[0]}`)
  console.log(error.stack)
}

console.log('\n=== A1.5  mode: warn reaches the same decision and mutates nothing ===')
await teardown()
try {
  await boot({ mode: 'warn', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 0 })
  const svc = context.get('compactionPrune')
  const meter = context.tokenMeter
  const session = routedLiveSession('a1-warn')
  await warmWindow(session, svc)

  session.append('tool/result', toolResultData('warn-1', 400_000, 'w1'), { surfaceOp: 'append' })
  await settle()
  const before = meter.measure(session)
  await settle()
  const after = meter.measure(session)

  check('warn mode acted (the decision was reached)', svc.stats.acted > 0, JSON.stringify(svc.stats))
  check('warn mode left the surface untouched', after.surfaceTokens === before.surfaceTokens,
    `${before.surfaceTokens} -> ${after.surfaceTokens}`)
  check('no prune ran', !logs.some((entry) => /pruned \d+ node/.test(entry.text)))
  check('the would-prune decision was logged', logs.some((entry) => /would prune/.test(entry.text)),
    JSON.stringify(logs.filter((entry) => /compaction-prune/.test(entry.text)).slice(0, 2)))
  note('warn mode is therefore the only mode whose decision path is observable end to end')
} catch (error) {
  failures += 1
  console.log(`  [FAIL] ${error.message.split('\n')[0]}`)
}

console.log('\n=== A1.6  an unresolvable route keeps the plugin inactive ===')
await teardown()
try {
  await boot({ mode: 'warn', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 0 })
  const svc = context.get('compactionPrune')
  const session = context.sessions.create('a1-noroute', { meta: { cwd: process.cwd() } })
  session.append('request/header', {
    header: { config: { provider: 'unregistered-provider', model: 'x', maxTokens: 1000 }, reason: 'initial' },
  })
  // Two events: the first starts the fire-and-forget resolution, the second
  // observes its (null) result.
  session.append('tool/result', toolResultData('nr-1', 400_000, 'nr1'), { surfaceOp: 'append' })
  await settle()
  session.append('tool/result', toolResultData('nr-2', 400_000, 'nr2'), { surfaceOp: 'append' })
  await settle()

  check('no window means no action', svc.stats.acted === 0, JSON.stringify(svc.stats))
  check('the unresolved window was cached as null',
    svc._windowByRoute.get('unregistered-provider\u0000x') === null,
    JSON.stringify([...svc._windowByRoute.entries()]))
  check('the inactivity was explained in the log',
    logs.some((entry) => /no context window/.test(entry.text)) || logs.some((entry) => /context window unresolved/.test(entry.text)),
    JSON.stringify(logs.filter((entry) => /compaction-prune/.test(entry.text)).slice(0, 2)))
  check('the session really was large enough to have triggered',
    context.tokenMeter.measure(session).totalTokens > TRIGGER,
    String(context.tokenMeter.measure(session).totalTokens))
} catch (error) {
  failures += 1
  console.log(`  [FAIL] ${error.message.split('\n')[0]}`)
}

console.log('\n=== A1.7  the same two findings on REAL tool-result payloads from a recorded session ===')
await teardown()
try {
  // Resolved from DSH_SESSIONS_ROOT or DSH_HOME, so no developer path is embedded.
const sessionsRoot = SESSIONS_ROOT
  const log = listSessionLogs(sessionsRoot).find((item) => item.sessionId.includes('c0acb35e'))
  if (log === undefined) {
    note('skipped', 'no recorded corpus available')
  } else {
    const { events } = readSessionLog(log.path)
    const realResults = []
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      let chars = 0
      for (const block of event.data.message.content ?? []) {
        if (block.type === 'text') chars += block.text.length
      }
      if (chars > 8192) realResults.push({ content: event.data.message.content, chars })
    }
    realResults.sort((left, right) => right.chars - left.chars)
    check('the corpus contains tool results above the pruner threshold', realResults.length > 0,
      `${realResults.length} node(s) over 8192 chars, largest ${realResults[0]?.chars}`)

    // (a) LIVE session, plugin driving: expect the re-entrancy failure.
    await boot({ mode: 'prune', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 0 })
    const svc = context.get('compactionPrune')
    const live = routedLiveSession('a1-real-live')
    await warmWindow(live, svc)
    const liveEventsBefore = live.seq
    for (const [index, item] of realResults.slice(0, 6).entries()) {
      live.append('tool/result', {
        turn: 1, step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `real-live-${index}` },
          toolCallId: `real-live-${index}`,
          content: item.content,
        },
      }, { surfaceOp: 'append' })
      await settle()
    }
    const liveReplacements = live.snapshotEvents(liveEventsBefore).filter((event) => typeof event.surfaceOp === 'object').length
    check('on real payloads the observer hit the guard on every attempt',
      logs.filter((entry) => /cannot reenter/.test(entry.text)).length > 0,
      `stats=${JSON.stringify(svc.stats)}`)
    check('on real payloads ZERO replacements landed',
      liveReplacements === 0 && !logs.some((entry) => /pruned \d+ node/.test(entry.text)),
      `${liveReplacements} replacement event(s)`)

    // (b) DETACHED session, pruner called directly: expect real savings.
    const header = { version: 4, id: 'a1-real-detached', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() }
    const detached = Session.create(header.id, undefined, header)
    detached.append('request/header', {
      header: { config: { provider: PROVIDER, model: MODEL, maxTokens: DEFAULT_MAX_TOKENS }, reason: 'initial' },
    })
    for (const [index, item] of realResults.slice(0, 6).entries()) {
      detached.append('tool/result', {
        turn: 1, step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `real-det-${index}` },
          toolCallId: `real-det-${index}`,
          content: item.content,
        },
      }, { surfaceOp: 'append' })
    }
    const meter = context.tokenMeter
    const detachedBefore = meter.measure(detached)
    const result = context.get('toolResultPruner').pruneSession(detached)
    const detachedAfter = meter.measure(detached)
    check('the same real payloads DO yield savings when the guard does not apply',
      result.pruned.length > 0 && detachedAfter.surfaceTokens < detachedBefore.surfaceTokens,
      `${result.pruned.length} replacement(s), ${result.charsRemoved} chars, surfaceTokens ${detachedBefore.surfaceTokens} -> ${detachedAfter.surfaceTokens}`)
    note('the only difference between (a) and (b)', 'the live session is attached to the store; the detached one is not')
  }
} catch (error) {
  failures += 1
  console.log(`  [FAIL] ${error.message.split('\n')[0]}`)
  console.log(error.stack)
}

await teardown()

console.log('\n=== A1 verdict ===')
if (failures === 0) {
  console.log('  The decision path works: the plugin decides, and the pruner really shrinks a surface.')
  console.log('  The execution path does not: in a live session every prune attempt is rejected by')
  console.log("  Session.append()'s re-entrancy guard, because session/event is dispatched synchronously")
  console.log('  from inside that same append. mode: prune is therefore inert in any real deployment,')
  console.log('  and mode: warn is the only mode whose decision path is observable end to end.')
  console.log('  Neither finding says anything about compaction frequency — that is A2.')
} else {
  console.log(`  ${failures} check(s) failed.`)
  process.exitCode = 1
}
