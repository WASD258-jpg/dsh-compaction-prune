/**
 * Adversarial follow-up: verify the three corrections raised by independent review.
 *
 * The reviewer's most consequential claim is that the FAILURE MODE changes shape
 * when the mounted pruner is the `dsh-purge`-patched one: instead of throwing,
 * `pruneSession()` returns an empty result, so the plugin logs a successful
 * "pruned 0 node(s), 0 chars removed", increments `stats.acted`, and arms its
 * cooldown — a silent fake success.
 *
 * This file checks that, plus two clause-level findings:
 *   - a failed prune never arms the cooldown, so every event retries;
 *   - `estimateRemovable()` measures UTF-16 length while the pruner measures
 *     code points, so `warn` mode can overstate recoverable characters.
 *
 * Run: `node tools/failure-modes.mjs`
 *
 * @module tools/failure-modes
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import CompactionPrune, { estimateRemovable } from '../src/index.js'
import { importPackage } from './resolve-module.mjs'

const { LlmRuntime, LlmAdapter } = await importPackage('@deepseek-ai/dsh-llm')

const PROVIDER = 'fm-provider'
const MODEL = 'fm-model'
const WINDOW = 100_000
const MAX_TOKENS = 16_000
const TRIGGER = Math.floor(WINDOW * 0.35)

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  [PASS] ${label}`)
  else { failures += 1; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}
const note = (label, detail) => console.log(`  [note] ${label}${detail ? ' — ' + detail : ''}`)

class Stub extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: WINDOW }, defaultMaxTokens: MAX_TOKENS }
  }
}

function filler(chars, seed) {
  const unit = `blk${seed}-abcdefghijklmnopqrstuvwxyz0123456789\n`
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

function toolResultData(callId, chars, seed) {
  return {
    turn: 1, step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: filler(chars, seed) }],
    },
  }
}

/**
 * Mount the real chain, optionally swapping in a patched pruner that reproduces
 * the `dsh-purge` edit (pruneContent returns null without touching anything).
 *
 * @param patchPruner - whether to substitute the patched implementation.
 * @returns the mounted context and the captured logs.
 */
async function mount(patchPruner) {
  const ctx = new Context()
  await ctx.plugin(SessionProjection, {})
  await ctx.plugin(SessionStore, {})
  await ctx.plugin(TokenMeter, {})
  await ctx.plugin(ToolResultPruner, {})
  await ctx.plugin(LlmRuntime, {})
  ctx.llm.registerAdapter([PROVIDER], new Stub())
  if (patchPruner) {
    // Mirror the harness edit exactly: the method returns null immediately.
    ctx.toolResultPruner.pruneContent = function patched() { return null }
  }
  await ctx.plugin(CompactionPrune, { mode: 'prune', triggerRatio: 0.35, minimumCharsRemoved: 2048, cooldownMs: 60_000 })
  const logs = []
  for (const level of ['warn', 'info', 'debug']) {
    const original = ctx.logger[level].bind(ctx.logger)
    ctx.logger[level] = (...args) => { logs.push({ level, text: args.map(String).join(' ') }); return original(...args) }
  }
  return { ctx, logs }
}

function routed(ctx, id) {
  const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
  session.append('request/header', {
    header: { config: { provider: PROVIDER, model: MODEL, maxTokens: MAX_TOKENS }, reason: 'initial' },
  })
  session.append('request/context', { provider: PROVIDER, model: MODEL, contextWindow: WINDOW })
  return session
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

console.log('=== correction 1: the patched (deployed) pruner turns the failure SILENT ===')
{
  const { ctx, logs } = await mount(true)
  const svc = ctx.get('compactionPrune')
  const session = routed(ctx, 'fm-patched')
  // Warm the window cache.
  session.append('tool/result', toolResultData('warm', 1000, 'w'), { surfaceOp: 'append' })
  await settle()

  const before = ctx.tokenMeter.measure(session)
  const eventsBefore = session.seq
  for (let index = 1; index <= 3; index += 1) {
    session.append('tool/result', toolResultData(`p-${index}`, 200_000, `p${index}`), { surfaceOp: 'append' })
    await settle()
  }
  const after = ctx.tokenMeter.measure(session)

  const guardErrors = logs.filter((entry) => /cannot reenter/.test(entry.text))
  const fakeSuccess = logs.filter((entry) => /pruned %d node\(s\), %d chars removed|pruned 0 node/.test(entry.text))
  const cooldownLogs = logs.filter((entry) => /cooling down/.test(entry.text))
  let landed = 0
  for (const event of session.snapshotEvents(eventsBefore)) if (typeof event.surfaceOp === 'object') landed += 1

  check('no re-entrancy error is raised (the pruner never appends)', guardErrors.length === 0,
    `${guardErrors.length} guard error(s)`)
  check('the plugin reports a SUCCESSFUL prune of nothing', fakeSuccess.length > 0,
    JSON.stringify(fakeSuccess.slice(0, 1)))
  check('stats.acted DOES increment (so A1\'s "acted stays 0" is unpatched-only)',
    svc.stats.acted > 0, JSON.stringify(svc.stats))
  check('the cooldown then arms, logging "cooling down"', cooldownLogs.length > 0,
    `${cooldownLogs.length} cooldown log(s)`)
  check('nothing actually landed on the surface', landed === 0, `${landed} replacement(s)`)
  check('the surface only grew', after.totalTokens > before.totalTokens,
    `${before.totalTokens} -> ${after.totalTokens}`)
  note('deployment reality', 'the symptom is silence plus a success-looking log line, not an exception')
  await ctx.fiber.dispose()
}

console.log('\n=== correction 2: a FAILED prune never arms the cooldown, so every event retries ===')
{
  const { ctx, logs } = await mount(false)
  const svc = ctx.get('compactionPrune')
  const session = routed(ctx, 'fm-retry')
  session.append('tool/result', toolResultData('warm', 1000, 'w'), { surfaceOp: 'append' })
  await settle()

  let drives = 0
  for (let index = 1; index <= 5; index += 1) {
    session.append('tool/result', toolResultData(`r-${index}`, 200_000, `r${index}`), { surfaceOp: 'append' })
    await settle()
    drives += 1
  }
  const guardErrors = logs.filter((entry) => /cannot reenter/.test(entry.text))
  const cooldownLogs = logs.filter((entry) => /cooling down/.test(entry.text))

  check('every drive past the trigger was retried (no cooldown suppression)',
    guardErrors.length >= 3, `${guardErrors.length} failure(s) over ${drives} drive(s), cooldownMs=60000`)
  check('"cooling down" is never logged on the failure path', cooldownLogs.length === 0,
    `${cooldownLogs.length} cooldown log(s)`)
  check('stats.acted stays 0 on the real failure path', svc.stats.acted === 0, JSON.stringify(svc.stats))
  note('consequence', '_lastPrune.set() sits AFTER pruneSession() returns, so a throw skips it')
  await ctx.fiber.dispose()
}

console.log('\n=== correction 3: estimateRemovable() measures UTF-16, the pruner measures code points ===')
{
  const { ctx } = await mount(false)
  const pruner = ctx.get('toolResultPruner')
  const header = { version: 4, id: 'fm-utf16', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() }
  const session = Session.create(header.id, undefined, header)
  // 4,600 astral code points, each 2 UTF-16 units => 9,200 .length, under the
  // 8,192 threshold by UTF-16 reading but over it by code-point reading? No:
  // the point is the OPPOSITE direction. See the assertions below.
  const astral = '\u{1F600}'.repeat(4600)
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'u1' },
      toolCallId: 'u1',
      content: [{ type: 'text', text: astral }],
    },
  }, { surfaceOp: 'append' })

  const utf16 = astral.length
  const codePoints = Array.from(astral).length
  const byPluginRule = Math.max(0, utf16 - pruner.config.thresholdChars)
  const prunerWouldPrune = pruner.pruneContent([{ type: 'text', text: astral }]) !== null
  const pluginEstimate = estimateRemovable(session, pruner)

  check('the two length measures differ by 2x on astral text', utf16 === 9200 && codePoints === 4600,
    `utf16=${utf16} codePoints=${codePoints}`)
  check('the plugin computes a positive removable count', byPluginRule > 0, String(byPluginRule))
  check('the plugin actually reports it through estimateRemovable()', pluginEstimate > 0, String(pluginEstimate))
  check('the PRUNER would refuse this node (it is within its code-point budget)',
    prunerWouldPrune === false, `prunerWouldPrune=${prunerWouldPrune}`)
  note('impact', `warn mode would claim ${pluginEstimate} removable chars on a node the pruner will not touch: an overstatement`)
  await ctx.fiber.dispose()
}

console.log('\n=== correction 4: a detached session dispatches NO session/event at all ===')
{
  const { ctx } = await mount(false)
  const svc = ctx.get('compactionPrune')
  const seen = []
  ctx.on('session/event', (_session, event) => seen.push(event.type))

  const header = { version: 4, id: 'fm-detached', createdAt: Date.now(), isSeeded: false, cwd: process.cwd() }
  const detached = Session.create(header.id, undefined, header)
  detached.append('tool/result', toolResultData('d-1', 300_000, 'd1'), { surfaceOp: 'append' })

  check('a detached append publishes no session/event', seen.length === 0, JSON.stringify(seen))
  check('so the plugin evaluates nothing for it', svc.stats.evaluated === 0, JSON.stringify(svc.stats))
  note('A1.3 clarification', 'the detached run isolates the PRUNER; the plugin cannot be observing it, because it receives no events')

  // The same append on an attached session does publish.
  const live = routed(ctx, 'fm-attached')
  seen.length = 0
  live.append('tool/result', toolResultData('l-1', 1000, 'l1'), { surfaceOp: 'append' })
  check('an attached append does publish', seen.includes('tool/result'), JSON.stringify(seen))
  await ctx.fiber.dispose()
}

console.log(`\n=== verdict: ${failures === 0 ? 'all four corrections reproduce' : `${failures} check(s) failed`} ===`)
if (failures > 0) process.exitCode = 1
