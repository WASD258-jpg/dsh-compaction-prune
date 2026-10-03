// Privacy and hygiene gate for a public repository.
//
// Run this BEFORE the first commit and on every change. A leak cannot be undone
// by a later commit: git history is forever, and a force-push to a public repo
// may already be cached or forked.
//
// Usage:
//   node tools/privacy-check.mjs [repo-root]

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? process.cwd())

/* --------------------------------------------------------------- scanning */

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function readText(file) {
  try {
    const buf = fs.readFileSync(file)
    // Skip binary content: a NUL in the first 8 KiB means it is not text.
    if (buf.subarray(0, 8192).includes(0)) return null
    return buf.toString('utf8')
  } catch { return null }
}

/**
 * Each check: id, description, pattern, and whether a hit is fatal.
 *
 * Patterns are deliberately specific. A broad word like "token" appears
 * throughout this repository as domain vocabulary (tokenMeter, maxTokens,
 * token budget) and flagging it would train the reader to ignore the gate.
 */
const CHECKS = [
  {
    id: 'credential-openai',
    what: 'OpenAI/DeepSeek-style API key',
    re: /sk-[A-Za-z0-9]{20,}/g,
    fatal: true,
  },
  {
    id: 'credential-openrouter',
    what: 'OpenRouter API key',
    re: /sk-or-v1-[a-f0-9]{32,}/g,
    fatal: true,
  },
  {
    id: 'credential-google',
    what: 'Google API key',
    re: /AQ\.[A-Za-z0-9_-]{30,}/g,
    fatal: true,
  },
  {
    id: 'credential-github',
    what: 'GitHub token',
    re: /gh[pous]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
    fatal: true,
  },
  {
    id: 'credential-private-key',
    what: 'PEM private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    fatal: true,
  },
  {
    id: 'credential-assignment',
    what: 'literal secret in an assignment',
    re: /(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/gi,
    fatal: true,
  },
  {
    id: 'windows-user-path',
    what: 'local Windows user path',
    re: /[A-Za-z]:\\+Users\\+[^\\\/\s"']+/g,
    fatal: true,
  },
  {
    id: 'unix-home-path',
    what: 'local home path',
    re: /(?:\/Users\/|\/home\/)[a-zA-Z0-9._-]{2,}/g,
    fatal: true,
  },
  {
    id: 'private-ip',
    what: 'private or loopback address',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1:\d{2,5})\b/g,
    fatal: true,
  },
  {
    id: 'email-nonplaceholder',
    what: 'a real-looking email (placeholders excluded)',
    re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)|noreply|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    fatal: false,
  },
  {
    id: 'session-log',
    what: 'session log or session data file',
    re: null, // filename check
    fatal: true,
  },
]

const ALLOWED_FILE_EXT = new Set([
  '.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.txt', '.gitignore', '.gitattributes',
])

/* ------------------------------------------------------------------ report */

const files = walk(root)
const findings = []

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/')

  // Session data must never be committed, whatever its extension.
  if (/\.(?:jsonl|zstd)$/.test(rel) || /session.*\.json$/.test(rel) || /\.credentials/.test(rel)) {
    findings.push({ id: 'session-log', rel, line: 0, text: '(data file present in tree)' })
    continue
  }

  const text = readText(file)
  if (text === null) continue

  const lines = text.split('\n')
  for (const check of CHECKS) {
    if (check.re === null) continue
    for (let i = 0; i < lines.length; i += 1) {
      check.re.lastIndex = 0
      const m = check.re.exec(lines[i])
      if (m !== null) {
        findings.push({
          id: check.id,
          what: check.what,
          rel,
          line: i + 1,
          text: m[0].slice(0, 60),
          fatal: check.fatal,
        })
      }
    }
  }
}

const fatal = findings.filter(f => f.fatal !== false)
const advisory = findings.filter(f => f.fatal === false)

console.log('Privacy check')
console.log('=============')
console.log(`root:  ${root}`)
console.log(`files: ${files.length} scanned`)
console.log('')

if (advisory.length > 0) {
  console.log('Advisory (review, not necessarily a leak):')
  for (const f of advisory) {
    console.log(`  [${f.id}] ${f.rel}:${f.line}  ${f.text}`)
  }
  console.log('')
}

if (fatal.length > 0) {
  console.log('FATAL — do not commit:')
  for (const f of fatal) {
    console.log(`  [${f.id}] ${f.rel}:${f.line}  ${f.text}`)
  }
  console.log('')
  console.log(`${fatal.length} fatal finding(s). Resolve before committing.`)
  console.log('Note: a leak already committed is not undone by a later commit —')
  console.log('git history persists. If this is post-commit, rewrite history and')
  console.log('treat any exposed credential as compromised.')
  process.exit(1)
}

console.log('No fatal findings.')
if (advisory.length === 0) console.log('No advisory findings either — clean.')
