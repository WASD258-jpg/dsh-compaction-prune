/**
 * Pin the analysed corpus so the report's counts stay reproducible.
 *
 * The sessions directory is LIVE: every session run — including runs of these
 * very tools — appends a new log. Absolute counts ("55 logs", "48 analysable")
 * therefore drift the moment anyone re-runs anything, and a measurement that
 * cannot be re-derived from a fixed input is not a measurement.
 *
 * A manifest records the exact session set a run used, keyed by session id with
 * the artifact size as a cheap integrity check. Every tool accepts `--manifest`
 * to restrict itself to that set.
 *
 * Usage:
 *   node tools/corpus.mjs build [--out tools/corpus-manifest.json]
 *   node tools/corpus.mjs show
 *
 * @module tools/corpus
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSessionLogs, readSessionLog } from './session-log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MANIFEST_PATH = join(HERE, 'corpus-manifest.json')
export const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

/**
 * Describe every currently-present v4 session log.
 *
 * @param root - the sessions directory.
 * @returns `{ root, generatedAt, sessions }`, where each session records its id,
 *   group, byte size, creation time, and whether it carries usable usage.
 */
export function describeCorpus(root = SESSIONS_ROOT) {
  const sessions = []
  for (const log of listSessionLogs(root)) {
    let header
    let hasUsage = false
    let decodable = true
    let reason
    try {
      const decoded = readSessionLog(log.path)
      header = decoded.header
      hasUsage = decoded.events.some((event) => event.type === 'assistant/message' && event.data.usage !== undefined)
    } catch (error) {
      decodable = false
      reason = error.message.split('\n')[0]
    }
    sessions.push({
      id: log.sessionId,
      group: log.group,
      bytes: log.bytes,
      createdAt: header?.createdAt ?? null,
      decodable,
      hasUsage,
      ...reason === undefined ? {} : { undecodableReason: reason },
    })
  }
  sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { root, generatedAt: Date.now(), sessions }
}

/**
 * Load a pinned manifest.
 *
 * @param path - the manifest file.
 * @returns the parsed manifest.
 */
export function loadManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) throw new Error(`no corpus manifest at ${path}; run "node tools/corpus.mjs build" first`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Restrict a `listSessionLogs` result to a manifest's session set.
 *
 * The returned logs are the live entries for the pinned ids, so a manifest
 * selects a fixed session SET while still reading current bytes — which is what
 * makes the member counts stable even as unrelated sessions appear.
 *
 * @param logs - live log entries.
 * @param manifest - a loaded manifest.
 * @returns the logs whose session id is in the manifest, plus any missing ids.
 */
export function restrictToManifest(logs, manifest) {
  const wanted = new Set(manifest.sessions.map((session) => session.id))
  const present = logs.filter((log) => wanted.has(log.sessionId))
  const presentIds = new Set(present.map((log) => log.sessionId))
  const missing = manifest.sessions.filter((session) => !presentIds.has(session.id)).map((session) => session.id)
  return { logs: present, missing }
}

function main() {
  const command = process.argv[2] ?? 'show'
  if (command === 'build') {
    const outIndex = process.argv.indexOf('--out')
    const out = outIndex === -1 ? MANIFEST_PATH : process.argv[outIndex + 1]
    const manifest = describeCorpus()
    writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
    const usable = manifest.sessions.filter((session) => session.hasUsage && session.decodable)
    console.log(`wrote ${out}`)
    console.log(`  sessions present : ${manifest.sessions.length}`)
    console.log(`  usable (usage+decode): ${usable.length}`)
    console.log(`  undecodable      : ${manifest.sessions.filter((session) => !session.decodable).length}`)
    return
  }
  const manifest = loadManifest()
  const usable = manifest.sessions.filter((session) => session.hasUsage && session.decodable)
  console.log(`manifest: ${MANIFEST_PATH}`)
  console.log(`  generated : ${new Date(manifest.generatedAt).toISOString()}`)
  console.log(`  sessions  : ${manifest.sessions.length}`)
  console.log(`  usable    : ${usable.length}`)
  const live = listSessionLogs(manifest.root)
  const { missing } = restrictToManifest(live, manifest)
  console.log(`  live now  : ${live.length} (manifest pins ${manifest.sessions.length}; ${missing.length} pinned session(s) no longer present)`)
}

if (process.argv[1]?.endsWith('corpus.mjs')) main()
