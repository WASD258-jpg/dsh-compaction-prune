// Local mirror of the CI "Internal links resolve" check.
// Run before pushing so a link defect is found here rather than on the runner.

import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? process.cwd()

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** Remove fenced blocks and inline code, so example links are not checked. */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

const broken = []
for (const file of walk(root)) {
  const prose = stripCode(fs.readFileSync(file, 'utf8'))
  for (const m of prose.matchAll(/\]\(([^)#h][^)]*\.(?:md|mjs))\)/g)) {
    const target = path.join(path.dirname(file), m[1])
    if (!fs.existsSync(target)) {
      broken.push(`${path.relative(root, file)} -> ${m[1]}`)
    }
  }
}

console.log('Internal link check')
console.log('===================')
console.log(`root: ${root}`)
console.log('')

// Self-test: prove the checker still catches a real break and still ignores an
// example inside a code fence. A checker that passes unconditionally is worse
// than none, because it manufactures confidence.
const SAMPLE = '```\n[example](placeholder.md)\n```\n\n[real](does-not-exist.md)\n'
const sampleFound = [...stripCode(SAMPLE).matchAll(/\]\(([^)#h][^)]*\.(?:md|mjs))\)/g)].map(m => m[1])
const catchesReal = sampleFound.includes('does-not-exist.md')
const ignoresExample = !sampleFound.includes('placeholder.md')
console.log(`self-test, catches a real break: ${catchesReal ? 'yes' : 'NO'}`)
console.log(`self-test, ignores fenced example: ${ignoresExample ? 'yes' : 'NO'}`)
console.log('')

if (!catchesReal || !ignoresExample) {
  console.error('the checker itself is broken — refusing to report on the repository')
  process.exit(2)
}

if (broken.length) {
  console.error(`BROKEN links (${broken.length}):`)
  for (const b of broken) console.error(`  ${b}`)
  process.exit(1)
}

console.log('all internal links resolve')
