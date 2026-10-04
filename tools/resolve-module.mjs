/**
 * Resolve a harness package that is present in the pnpm store but not hoisted
 * to this repository's top-level `node_modules`.
 *
 * `@deepseek-ai/dsh-llm` arrives as a transitive dependency of the tool-result
 * pruner, and pnpm's isolated layout keeps it under `.pnpm/` where a bare
 * `import '@deepseek-ai/dsh-llm'` cannot see it. Rather than re-resolving the
 * dependency tree (which would rewrite the lockfile this repository pins), the
 * lookup falls back to a scan of the store.
 *
 * @module tools/resolve-module
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The harness installation that owns the running deployment. */
export const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT
  ?? join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh')

/**
 * Locate the entry file of a harness package.
 *
 * Search order:
 *   1. this repository's hoisted `node_modules`
 *   2. the pnpm store under `node_modules/.pnpm`
 *   3. the installed harness's own `node_modules` (last resort; that tree has
 *      been patched by `dsh-purge`, so a result from here is reported as tainted)
 *
 * @param pkg - the package name, e.g. `@deepseek-ai/dsh-llm`.
 * @returns `{ entry, source, tainted }`.
 * @throws when the package cannot be found anywhere.
 */
export function locatePackage(pkg) {
  const [scope, name] = pkg.startsWith('@') ? pkg.split('/') : [undefined, pkg]
  const rel = scope === undefined ? name : join(scope, name)

  const hoisted = join(REPO_ROOT, 'node_modules', rel)
  if (existsSync(join(hoisted, 'package.json'))) {
    return { entry: entryOf(hoisted, pkg), source: 'hoisted', tainted: false }
  }

  const store = join(REPO_ROOT, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    const prefix = `${pkg.replace('/', '+')}@`
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith(prefix)) continue
      const candidate = join(store, dir, 'node_modules', rel)
      if (existsSync(join(candidate, 'package.json'))) {
        return { entry: entryOf(candidate, pkg), source: 'pnpm-store', tainted: false }
      }
    }
  }

  const harness = join(HARNESS_ROOT, 'node_modules', rel)
  if (existsSync(join(harness, 'package.json'))) {
    return { entry: entryOf(harness, pkg), source: 'harness-install', tainted: true }
  }

  throw new Error(`cannot locate package "${pkg}" in ${REPO_ROOT}/node_modules or ${HARNESS_ROOT}/node_modules`)
}

/** Read one package's declared ESM entry point. */
function entryOf(dir, pkg) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const main = manifest.exports?.['.']?.default ?? manifest.exports?.['.'] ?? manifest.main ?? 'lib/index.js'
  const file = typeof main === 'string' ? main : 'lib/index.js'
  return join(dir, file)
}

/**
 * Import a harness package by name, resolving through {@link locatePackage}.
 *
 * @param pkg - the package name.
 * @returns the imported module namespace.
 */
export async function importPackage(pkg) {
  const { entry } = locatePackage(pkg)
  return import(pathToFileURL(entry).href)
}
