// Verify the corrected plugin: syntax, export shape, optional inject, and that
// decide() behaves as documented on every branch.

import * as plugin from '../src/index.js'

console.log('=== 1. Export shape ===')
console.log(`  name:   ${plugin.name}`)
console.log(`  inject: ${JSON.stringify(plugin.inject)}`)
console.log(`  Config: ${typeof plugin.Config}`)
console.log(`  apply:  ${typeof plugin.apply}`)
console.log(`  decide: ${typeof plugin.decide}`)
console.log(`  DEFAULTS: ${JSON.stringify(plugin.DEFAULTS)}`)

console.log('\n=== 2. Config validation ===')
const cases = [
  ['empty (all defaults)', {}],
  ['mode warn', { mode: 'warn' }],
  ['mode prune', { mode: 'prune' }],
  ['mode off', { mode: 'off' }],
  ['custom ratio', { triggerRatio: 0.5 }],
]
for (const [label, cfg] of cases) {
  try {
    const v = plugin.Config(cfg)
    console.log(`  [PASS] ${label} -> ${JSON.stringify(v)}`)
  } catch (e) {
    console.log(`  [FAIL] ${label} -> ${e.message}`)
  }
}

console.log('\n=== 3. Malformed config must be rejected ===')
const bad = [
  ['ratio too high', { triggerRatio: 1.5 }],
  ['unknown key', { nope: 1 }],
  ['misspelled key', { triggerRatios: 0.5 }],
  ['invalid mode', { mode: 'destroy' }],
  ['negative cooldown', { cooldownMs: -1 }],
]
let rejected = 0
for (const [label, cfg] of bad) {
  try {
    plugin.validateConfig(cfg)
    console.log(`  [WRONGLY ACCEPTED] ${label}`)
  } catch (e) {
    rejected += 1
    console.log(`  [correctly rejected] ${label} -> ${e.message.split('\n')[0].slice(0, 60)}`)
  }
}
console.log(`  rejected: ${rejected}/${bad.length}`)

console.log('\n=== 3b. Valid config must still be accepted ===')
for (const [label, cfg] of cases) {
  try {
    plugin.validateConfig(cfg)
    console.log(`  [ok] ${label}`)
  } catch (e) {
    console.log(`  [REGRESSION] ${label} -> ${e.message}`)
  }
}

console.log('\n=== 4. decide() on every branch ===')
const base = { config: { ...plugin.DEFAULTS, mode: 'prune' }, now: 1_000_000 }

const scenarios = [
  ['mode off', { ...base, config: { ...base.config, mode: 'off' }, totalTokens: 999_999, contextWindow: 1000, charsRemovable: 99_999 }],
  ['window unresolved', { ...base, contextWindow: undefined, totalTokens: 999_999, charsRemovable: 99_999 }],
  ['below trigger', { ...base, contextWindow: 100_000, totalTokens: 1000, charsRemovable: 99_999 }],
  ['cooling down', { ...base, contextWindow: 100_000, totalTokens: 90_000, charsRemovable: 99_999, lastPruneAt: 999_500 }],
  ['not worthwhile', { ...base, contextWindow: 100_000, totalTokens: 90_000, charsRemovable: 10 }],
  ['should act', { ...base, contextWindow: 100_000, totalTokens: 90_000, charsRemovable: 99_999 }],
]
for (const [label, input] of scenarios) {
  const d = plugin.decide(input)
  console.log(`  ${label.padEnd(20)} act=${String(d.act).padEnd(5)} ${d.reason}`)
}

console.log('\n=== 5. NEGATIVE: a wrong window must never cause an act ===')
// The exact failure this plugin must not have: inheriting the harness default
// (262144) for an unknown model would make it act on a number it cannot justify.
const noWindow = plugin.decide({ ...base, contextWindow: undefined, totalTokens: 500_000, charsRemovable: 99_999 })
console.log(`  act=${noWindow.act} (expected false) — ${noWindow.reason}`)
const zeroWindow = plugin.decide({ ...base, contextWindow: 0, totalTokens: 500_000, charsRemovable: 99_999 })
console.log(`  act=${zeroWindow.act} (expected false) — ${zeroWindow.reason}`)
