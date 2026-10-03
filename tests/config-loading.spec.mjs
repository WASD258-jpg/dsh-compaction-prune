// Does Cordis validate a function plugin's `export const Config`?
//
// The mount test showed an out-of-range config being accepted. That may mean the
// schema is never applied — or that a bare `ctx.plugin()` bypasses the Loader's
// configuration path, which only a real Loader exercises.
//
// Both are plausible. Distinguish them before changing the code.

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.js'

console.log('=== Hypothesis A: apply() receives the raw config unchanged ===')
{
  const ctx = new Context()
  let seen
  const spy = {
    ...plugin,
    apply(c, config) {
      seen = config
      return plugin.apply(c, config)
    },
  }
  try {
    await ctx.plugin(spy, { triggerRatio: 99, totallyUnknownKey: true })
    console.log('  apply() received:', JSON.stringify(seen))
    console.log('  -> if this equals the input verbatim, Cordis did NOT validate')
  } catch (e) {
    console.log(`  mount threw: ${e.message.split('\n')[0]}`)
  }
}

console.log('\n=== Hypothesis B: does Cordis know about the exported Config? ===')
console.log(`  plugin.Config is ${typeof plugin.Config}`)
console.log(`  plugin.name is ${typeof plugin.name} ("${plugin.name}")`)
console.log(`  plugin.inject is ${typeof plugin.inject}`)
const keys = Object.keys(plugin)
console.log(`  module exports: ${keys.join(', ')}`)

console.log('\n=== What the harness itself does ===')
console.log('  Official function plugins (e.g. command-compact) export name/inject/apply')
console.log('  and NO Config — their configuration lives in the closure.')
console.log('  Official SERVICE plugins (a class) declare `static Config` — Cordis reads it')
console.log('  when constructing the service.')
console.log('')
console.log('  Our plugin is function-form with an exported Config. Whether the Loader')
console.log('  applies it is exactly what this test must answer.')

console.log('\n=== Conclusion ===')
console.log('  Regardless of what Cordis does, apply() MUST validate explicitly:')
console.log('    - if the Loader validates, explicit validation is redundant but harmless')
console.log('    - if it does not, explicit validation is the only thing standing between')
console.log('      a typo and silent misconfiguration')
console.log('')
console.log('  apply() already calls validateConfig(). Confirm it actually throws:')
{
  const ctx = new Context()
  try {
    await ctx.plugin(plugin, { triggerRatio: 99 })
    console.log('    [PROBLEM] apply() accepted an out-of-range config')
  } catch (e) {
    console.log(`    [ok] apply() rejected it: ${e.message.split('\n')[0].slice(0, 60)}`)
  }
}
