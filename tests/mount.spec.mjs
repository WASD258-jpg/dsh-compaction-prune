// Verify the service-class form: config validation at construction, mount
// behaviour with and without the dependency chain, and rejection of bad input.
//
// The function-plugin form previously accepted an out-of-range config because a
// bare ctx.plugin() passes no config to apply(). A service class receives the
// config in its constructor, so validation cannot be bypassed.

import { Context } from '@deepseek-ai/cordis'
import CompactionPrune, { DEFAULTS, validateConfig } from '../src/index.js'

const CHAIN = [
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
]

async function mountChain(ctx) {
  for (const spec of CHAIN) {
    const m = await import(spec)
    await ctx.plugin(m.default ?? m, {})
    await new Promise(r => setTimeout(r, 50))
  }
}

console.log('=== 1. Export shape ===')
console.log(`  default: ${typeof CompactionPrune}`)
console.log(`  static inject: ${JSON.stringify(CompactionPrune.inject)}`)
console.log(`  static Config: ${typeof CompactionPrune.Config}`)

console.log('\n=== 2. Mount with defaults, full chain ===')
{
  const ctx = new Context()
  await mountChain(ctx)
  try {
    await ctx.plugin(CompactionPrune, {})
    const svc = ctx.get('compactionPrune')
    console.log(`  [PASS] mounted; service reachable: ${svc !== undefined}`)
    console.log(`  resolved config: ${JSON.stringify(svc.config)}`)
    console.log(`  stats: ${JSON.stringify(svc.stats)}`)
  } catch (e) {
    console.log(`  [FAIL] ${e.message.split('\n')[0]}`)
  }
}

console.log('\n=== 3. Mount with explicit config ===')
{
  const ctx = new Context()
  await mountChain(ctx)
  try {
    await ctx.plugin(CompactionPrune, { mode: 'prune', triggerRatio: 0.4, cooldownMs: 1000 })
    const svc = ctx.get('compactionPrune')
    console.log(`  [PASS] config = ${JSON.stringify(svc.config)}`)
    console.log(`  mode honoured: ${svc.config.mode === 'prune'}`)
  } catch (e) {
    console.log(`  [FAIL] ${e.message.split('\n')[0]}`)
  }
}

console.log('\n=== 4. Out-of-range config must be REJECTED at mount ===')
{
  const ctx = new Context()
  await mountChain(ctx)
  try {
    await ctx.plugin(CompactionPrune, { triggerRatio: 99 })
    console.log('  [PROBLEM] out-of-range config accepted')
  } catch (e) {
    console.log(`  [ok] rejected: ${e.message.split('\n')[0].slice(0, 70)}`)
  }
}

console.log('\n=== 5. Unknown key must be REJECTED at mount ===')
{
  const ctx = new Context()
  await mountChain(ctx)
  try {
    await ctx.plugin(CompactionPrune, { triggerRatios: 0.5 })
    console.log('  [PROBLEM] misspelled key accepted')
  } catch (e) {
    console.log(`  [ok] rejected: ${e.message.split('\n')[0].slice(0, 70)}`)
  }
}

console.log('\n=== 6. Mount WITHOUT the pruner (optional inject) ===')
{
  const ctx = new Context()
  try {
    await ctx.plugin(CompactionPrune, {})
    const svc = ctx.get('compactionPrune')
    console.log(`  [PASS] loads without the chain; service present: ${svc !== undefined}`)
    console.log('  -> a composition that does not use compaction is not broken by this plugin')
  } catch (e) {
    console.log(`  [FAIL] ${e.message.split('\n')[0]}`)
  }
}

console.log('\n=== 7. validateConfig directly ===')
for (const [label, cfg] of [
  ['undefined -> defaults', undefined],
  ['empty -> defaults', {}],
  ['valid', { mode: 'off' }],
]) {
  try {
    console.log(`  [ok] ${label} -> ${JSON.stringify(validateConfig(cfg))}`)
  } catch (e) {
    console.log(`  [FAIL] ${label} -> ${e.message}`)
  }
}
for (const [label, cfg] of [
  ['array', []],
  ['null-ish string', 'nope'],
  ['bad mode', { mode: 'destroy' }],
]) {
  try {
    validateConfig(cfg)
    console.log(`  [PROBLEM] ${label} accepted`)
  } catch (e) {
    console.log(`  [ok] ${label} rejected`)
  }
}
