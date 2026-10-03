// Verify every bilingual document pair.
//
// A bilingual set drifts silently. Someone edits the English and forgets the
// Chinese; a heading is added on one side only; a language switcher points at a
// file that was renamed. None of these break a build, and all of them leave a
// reader in a document that no longer matches its counterpart.
//
// This checks the mechanical properties that can be checked without reading both
// languages:
//
//   1. every translated file has its counterpart
//   2. the switcher exists on line 1 and points both ways
//   3. heading structure matches in order and depth
//   4. citation markers match as sets
//   5. numbers match as sets
//
// Rules 3-5 cannot prove good translation. They catch the mechanical drift, which
// is the failure that actually happens.
//
// Usage:
//   node verify-refs/check-language-pairs.mjs [repo-root]

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? process.cwd())

/* ------------------------------------------------------------------ scanning */

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const allFiles = walk(root)
const rel = (f) => path.relative(root, f).split(path.sep).join('/')

/** Files that are part of a bilingual pair, keyed by their base name. */
const pairs = new Map()
for (const file of allFiles) {
  const r = rel(file)
  if (r.endsWith('.zh.md')) {
    const base = r.slice(0, -'.zh.md'.length)
    pairs.set(base, { ...(pairs.get(base) ?? {}), zh: file })
  } else {
    const base = r.slice(0, -'.md'.length)
    pairs.set(base, { ...(pairs.get(base) ?? {}), en: file })
  }
}

/** Documents exempt from translation, with the reason. */
const EXEMPT = new Map([
  ['TRANSLATING', 'this glossary is bilingual within one file'],
])

/* -------------------------------------------------------------------- checks */

const problems = []
const checked = []

/**
 * GitHub-style heading slug for an anchor.
 *
 * The order matters and is easy to get wrong: punctuation is REMOVED first, then
 * each remaining space becomes a hyphen. Spaces are not collapsed.
 *
 *   "2. Mechanism A — overflow recovery is unreachable"
 *     → lower-case, drop "." and "—"
 *     → "2 mechanism a  overflow recovery is unreachable"   (two spaces)
 *     → "2-mechanism-a--overflow-recovery-is-unreachable"   (two hyphens)
 *
 * An earlier version of this function collapsed runs of whitespace, which
 * produced single hyphens and reported eight correct links as broken. The links
 * were right; the checker was wrong.
 *
 * CJK characters are preserved — GitHub keeps them in the slug rather than
 * transliterating.
 */
function slug(heading) {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/`[^`]*`/g, '')
    .trim()
    .toLowerCase()
    // Remove punctuation but keep letters, numbers, spaces, hyphens, underscores.
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // Each space becomes one hyphen. Do not collapse.
    .replace(/ /g, '-')
}

/** All heading slugs in a document, for anchor resolution. */
function slugs(text) {
  const set = new Set()
  for (const line of text.split('\n')) {
    if (/^#{1,6} /.test(line)) set.add(slug(line))
  }
  return set
}

/**
 * Check that every intra-repo anchor link resolves, including across files.
 *
 * An anchor that does not resolve still renders as a clickable link, so a reader
 * lands at the top of the target file with no indication of what went wrong. This
 * is how `EVIDENCE.md#7-threats-to-validity` survived against a section that had
 * moved to `#8-threats-to-validity` — a broken reference that no existing check
 * caught, in both language versions.
 *
 * GitHub slug rules are approximated: lowercase, drop punctuation, spaces to
 * hyphens, CJK preserved. An anchor that resolves under this approximation may
 * still fail on GitHub in unusual headings, so a report here is a strong signal,
 * not proof; a MISSING section, however, is always a real defect.
 */
function checkAnchors(file, text) {
  const here = slugs(text)
  for (const m of text.matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
    const [, target, anchor] = m
    if (/^https?:/.test(target)) continue

    let found
    let where
    if (target === '') {
      found = here
      where = rel(file)
    } else {
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target))
      if (!fs.existsSync(resolved)) {
        problems.push(`${rel(file)}: anchor link target does not exist: ${target}`)
        continue
      }
      found = slugs(fs.readFileSync(resolved, 'utf8'))
      where = path.relative(root, resolved).split(path.sep).join('/')
    }

    if (!found.has(decodeURIComponent(anchor))) {
      problems.push(
        `${rel(file)}: anchor "#${anchor}" not found in ${where}\n` +
        `    available: ${[...found].slice(0, 6).join(' | ')}${found.size > 6 ? ' | …' : ''}`,
      )
    }
  }
}

function headings(text) {
  return text.split('\n')
    .filter(line => /^#{2,3} /.test(line))
    .map(line => line.replace(/`[^`]*`/g, 'CODE').trim())
}

function markers(text) {
  const set = new Set()
  for (const m of text.matchAll(/\[([SOP]\d+[ab]?)\]/g)) set.add(m[1])
  return set
}

function numbers(text) {
  const set = new Set()
  // Percentages, and integers of 3+ digits (which are the measurement values).
  // Small integers are skipped: they appear in list numbering and prose and would
  // produce constant false mismatches.
  for (const m of text.matchAll(/\b\d[\d,]*\d\b(?:\.\d+)?%?/g)) {
    const raw = m[0].replace(/,/g, '').replace(/%$/, '')
    if (raw.length >= 3) set.add(raw)
  }
  return set
}

for (const [base, entry] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
  if (EXEMPT.has(base)) {
    checked.push({ base, status: 'exempt' })
    continue
  }

  const hasEn = entry.en !== undefined
  const hasZh = entry.zh !== undefined

  if (hasZh && !hasEn) {
    problems.push(`${base}: has a Chinese version but no English original`)
    continue
  }
  if (!hasEn) continue

  // Anchor resolution applies to every Markdown file, not just paired ones, so it
  // runs here before the pairing checks.
  checkAnchors(entry.en, fs.readFileSync(entry.en, 'utf8'))
  if (hasZh) checkAnchors(entry.zh, fs.readFileSync(entry.zh, 'utf8'))

  if (!hasZh) {
    problems.push(`${base}: no Chinese version (expected ${base}.zh.md)`)
    continue
  }

  const enText = fs.readFileSync(entry.en, 'utf8')
  const zhText = fs.readFileSync(entry.zh, 'utf8')
  const enName = path.basename(entry.en)
  const zhName = path.basename(entry.zh)

  // 1. Switchers, on line 1, pointing both ways.
  const enFirst = enText.split('\n')[0]
  const zhFirst = zhText.split('\n')[0]
  if (!enFirst.includes(zhName)) {
    problems.push(`${base}: English line 1 does not link to ${zhName}\n    got: ${enFirst.slice(0, 80)}`)
  }
  if (!zhFirst.includes(enName)) {
    problems.push(`${base}: Chinese line 1 does not link to ${enName}\n    got: ${zhFirst.slice(0, 80)}`)
  }

  // 2. Heading structure: same count, same order of depth.
  const enH = headings(enText)
  const zhH = headings(zhText)
  if (enH.length !== zhH.length) {
    problems.push(`${base}: heading count differs — English ${enH.length}, Chinese ${zhH.length}`)
  } else {
    const enShape = enH.map(h => h.split(' ')[0]).join(' ')
    const zhShape = zhH.map(h => h.split(' ')[0]).join(' ')
    if (enShape !== zhShape) {
      problems.push(`${base}: heading depth sequence differs\n    en: ${enShape}\n    zh: ${zhShape}`)
    }
  }

  // 3. Citation markers must match as sets.
  const enM = markers(enText)
  const zhM = markers(zhText)
  const missingM = [...enM].filter(m => !zhM.has(m)).sort()
  const extraM = [...zhM].filter(m => !enM.has(m)).sort()
  if (missingM.length || extraM.length) {
    problems.push(
      `${base}: citation markers differ` +
      (missingM.length ? `\n    missing in Chinese: ${missingM.join(', ')}` : '') +
      (extraM.length ? `\n    extra in Chinese: ${extraM.join(', ')}` : ''),
    )
  }

  // 4. Measurement numbers must match as sets. A number present in one language
  //    and absent in the other is almost always a transcription slip.
  const enN = numbers(enText)
  const zhN = numbers(zhText)
  const missingN = [...enN].filter(n => !zhN.has(n)).sort()
  if (missingN.length) {
    problems.push(
      `${base}: numbers in English absent from Chinese: ${missingN.slice(0, 12).join(', ')}` +
      (missingN.length > 12 ? ` (+${missingN.length - 12} more)` : ''),
    )
  }

  checked.push({
    base,
    status: 'checked',
    headings: enH.length,
    markers: enM.size,
    numbers: enN.size,
  })
}

/* -------------------------------------------------------------------- report */

console.log('Bilingual pair check')
console.log('===================')
console.log(`root: ${root}`)
console.log('')

const paired = checked.filter(c => c.status === 'checked')
const exempt = checked.filter(c => c.status === 'exempt')

if (paired.length) {
  console.log('Pairs checked:')
  for (const c of paired) {
    console.log(`  ok  ${c.base.padEnd(46)} headings ${String(c.headings).padStart(3)}  markers ${String(c.markers).padStart(3)}  numbers ${String(c.numbers).padStart(3)}`)
  }
  console.log('')
}
if (exempt.length) {
  console.log('Exempt:')
  for (const c of exempt) console.log(`  --  ${c.base}`)
  console.log('')
}

if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`)
  for (const p of problems) console.log(`  ! ${p}`)
  console.log('')
  console.log('A drift here does not break a build, but it leaves a reader in a')
  console.log('document that no longer matches its counterpart.')
  process.exit(1)
}

console.log(`${paired.length} pair(s) consistent.`)
