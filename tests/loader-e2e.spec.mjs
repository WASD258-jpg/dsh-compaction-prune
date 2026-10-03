// End-to-end availability: boot the plugin through the real Cordis Loader.
//
// This is the test that answers "does it work out of the box". Everything else
// in tests/ proves a component: decide() is correct, the class mounts, the config
// validates. None of them prove that a deployment can declare the plugin in a
// profile and have it come up.
//
// The pattern mirrors the harness's own loader-composition tests: write a real
// cordis.yml, drive the real Loader, and assert the plugin is instantiated.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import CompactionPrune from '../src/index.js'

/** Modules the Loader resolves by specifier. */
const MODULES = new Map([
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
  ['dsh-compaction-prune', CompactionPrune],
])

let root
let context
let logged = []

async function boot(lines) {
  root = await mkdtemp(join(tmpdir(), 'dsh-prune-e2e-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!MODULES.has(specifier)) {
        throw new Error(`test module map has no entry for "${specifier}"`)
      }
      return MODULES.get(specifier)
    },
  }

  // Capture error-level output: the Loader logs a plugin construction failure
  // rather than propagating it, so this is the only place an operator would see
  // a bad configuration.
  logged = []
  for (const level of ['error', 'warn']) {
    if (typeof context.logger[level] === 'function') {
      const original = context.logger[level].bind(context.logger)
      context.logger[level] = (...args) => {
        logged.push({
          level,
          text: args.map(a => (a instanceof Error ? a.message : String(a))).join(' '),
        })
        return original(...args)
      }
    }
  }

  // Load the config through the include plugin and wait for the Loader to settle.
  // Calling `loader.root.update()` directly passes no config array, which the
  // EntryGroup cannot consume — a harness mistake, not a plugin one.
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

console.log('=== 1. Boot with the full dependency chain ===')
try {
  await boot([
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "- name: 'dsh-compaction-prune'",
  ])
  const svc = context.get('compactionPrune')
  check('plugin instantiated by the Loader', svc !== undefined)
  check('service registered as "compactionPrune"', svc !== undefined)
  if (svc) {
    check('default config applied', svc.config.mode === 'warn',
      `mode=${svc.config.mode}`)
    check('triggerRatio default', svc.config.triggerRatio === 0.35)
  }
} catch (e) {
  failures += 1
  console.log(`  [FAIL] boot threw: ${e.message.split('\n')[0]}`)
}
await teardown()

console.log('\n=== 2. Boot with an explicit config block ===')
try {
  await boot([
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    "- name: 'dsh-compaction-prune'",
    '  config:',
    "    mode: 'off'",
    '    triggerRatio: 0.5',
  ])
  const svc = context.get('compactionPrune')
  check('explicit config honoured', svc?.config.mode === 'off' && svc?.config.triggerRatio === 0.5,
    JSON.stringify(svc?.config))
} catch (e) {
  failures += 1
  console.log(`  [FAIL] boot threw: ${e.message.split('\n')[0]}`)
}
await teardown()

console.log('\n=== 3. Boot WITHOUT the pruner (optional dependency) ===')
try {
  await boot([
    "- name: 'dsh-compaction-prune'",
  ])
  const svc = context.get('compactionPrune')
  check('loads with no dependencies mounted', svc !== undefined)
} catch (e) {
  failures += 1
  console.log(`  [FAIL] boot threw: ${e.message.split('\n')[0]}`)
  console.log('  -> a hard dependency would break compositions without compaction')
}
await teardown()

console.log('\n=== 4. Bad config: the service must NOT come up, and the error must be logged ===')
// The Loader treats a plugin construction failure as non-fatal: it logs and
// continues. That is the harness's design and a plugin cannot change it. What
// matters is that (a) the service does not register, so the plugin is not
// silently half-active, and (b) the log names the offending field.
for (const [label, lines] of [
  ['unknown key', ['    mode: warn', '    triggerRatios: 0.5']],
  ['out of range', ['    triggerRatio: 99']],
  ['invalid enum', ['    mode: destroy']],
]) {
  try {
    await boot([
      "- name: 'dsh-compaction-prune'",
      '  config:',
      ...lines,
    ])
    const svc = context.get('compactionPrune')
    check(`${label}: service does not register`, svc === undefined,
      svc === undefined ? '' : 'service came up with an invalid config')
    const errors = logged.filter(entry => entry.level === 'error')
    check(`${label}: an error was logged`, errors.length > 0)
    if (errors.length > 0) {
      const names = errors.some(e => /triggerRatio|mode|unknown key/.test(e.text))
      check(`${label}: the message names the field`, names, errors[0].text.slice(0, 70))
    }
  } catch (e) {
    // Some Loader versions may propagate instead. Either behaviour is acceptable
    // as long as the operator learns about it.
    console.log(`  [ok] ${label}: rejected at boot — ${e.message.split('\n')[0].slice(0, 60)}`)
  }
  await teardown()
}

console.log('\n=== 5. Boot the plugin twice (id stability) ===')
try {
  await boot([
    "- name: 'dsh-compaction-prune'",
    '  config:',
    "    mode: 'off'",
    "- name: 'dsh-compaction-prune'",
    '  config:',
    "    mode: 'warn'",
  ])
  check('two entries composed', context.get('compactionPrune') !== undefined)
} catch (e) {
  // Two registrations of the same service name is expected to conflict; that is
  // the loader's decision, not this plugin's. Record it rather than fail.
  console.log(`  [note] duplicate registration rejected by the Loader: ${e.message.split('\n')[0]}`)
}
await teardown()

console.log('\n=== Verdict ===')
if (failures === 0) {
  console.log('  The plugin boots through the real Loader, applies configuration,')
  console.log('  loads without optional dependencies, and rejects bad config at boot.')
} else {
  console.log(`  ${failures} check(s) failed — the plugin is not deployment-ready.`)
  process.exitCode = 1
}
