/**
 * Read a DSH v4 session log (`.jsonl.zstd`) without mutating it.
 *
 * The artifact is a CONCATENATED-FRAME Zstandard container: frame 0 holds the
 * header record, each later frame holds one durable event batch. Node's
 * one-shot `zstdDecompressSync` decodes only the first frame (and returns just
 * the header), so every frame must be located structurally and decoded
 * separately. `scanFrames` mirrors the backend's own structural scanner
 * (`dsh-session-persistence-jsonl/lib/index.js`, `scanZstdFrames`) so this
 * reader agrees with the writer on where frames begin and end.
 *
 * @module tools/session-log
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little-endian on the wire. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Locate complete Zstandard frames without decompressing their blocks.
 *
 * @param buffer - the complete artifact bytes.
 * @returns `frames` (byte ranges) and `tornStart` when a final frame is partial.
 * @throws when a complete frame is structurally invalid.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode one session log into its header record and its event list.
 *
 * The artifact's first line is a `session` header record carrying no `seq`.
 * Every remaining line is a durable event whose `seq` equals its zero-based
 * index in that list (the harness's `seq = log.length` contiguity contract).
 *
 * @param path - absolute path to a `session.v4.jsonl.zstd` file.
 * @returns `{ header, events, frames, torn }`.
 */
export function readSessionLog(path) {
  const buffer = readFileSync(path)
  const { frames, tornStart } = scanFrames(buffer)
  if (frames.length === 0) throw new Error(`${path}: no complete Zstandard frame`)
  const parts = []
  for (const { start, end } of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  }
  const text = parts.join('')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${path}: record ${index} is not valid JSON: ${error.message}`)
    }
  })
  if (records.length === 0) throw new Error(`${path}: empty log`)
  const [header, ...events] = records
  if (header.type !== 'session') throw new Error(`${path}: first record is "${header.type}", expected "session"`)
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) {
      throw new Error(`${path}: event ${index} has seq ${event.seq}; the log is not contiguous`)
    }
  }
  return { header, events, frames: frames.length, torn: tornStart !== undefined }
}

/** Event types that never contribute a model-visible surface node. */
const NON_SURFACE = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection',
  'agent/inbox/spliced', 'turn/start', 'step/start', 'step/end', 'turn/end',
  'session/title', 'session/title-llm-request', 'request/header', 'request/context',
  'compaction/start', 'compaction/end', 'compaction/prune',
  'web/deepseek-search-llm-request', 'llm/retry', 'llm/retry-started',
  'session/end-seed', 'todo/write', 'goal/change', 'command/run', 'command/done',
  'subagent/catalog', 'deliverables/presented', 'session-log-deepseek/delivery-accepted',
  'workspace/changes', 'assistant/attempt', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
  'tool/call',
])

/**
 * Count events by type, for reconnaissance output.
 *
 * @param events - a decoded event list.
 * @returns a type-to-count record.
 */
export function countTypes(events) {
  const out = {}
  for (const event of events) out[event.type] = (out[event.type] ?? 0) + 1
  return out
}

/** True when an event type is known never to carry a surface node. */
export function isNonSurface(type) {
  return NON_SURFACE.has(type)
}

/**
 * Enumerate every v4 session log under a DSH sessions root.
 *
 * @param root - the `.dsh/sessions` directory.
 * @returns `{ dir, sessionId, path, bytes }` records.
 */
export function listSessionLogs(root) {
  const out = []
  // The root may be absent on a machine that has never run the harness. An empty
  // result is the correct answer there; throwing would make every caller
  // unrunnable off the developer's own machine.
  let groups
  try {
    groups = readdirSync(root)
  } catch {
    return out
  }
  for (const group of groups) {
    const groupPath = join(root, group)
    let entries
    try {
      if (!statSync(groupPath).isDirectory()) continue
      entries = readdirSync(groupPath)
    } catch { continue }
    for (const sessionDir of entries) {
      const dir = join(groupPath, sessionDir)
      let files
      try {
        if (!statSync(dir).isDirectory()) continue
        files = readdirSync(dir)
      } catch { continue }
      const file = files.find((name) => name === 'session.v4.jsonl.zstd')
      if (file === undefined) continue
      const path = join(dir, file)
      out.push({ dir, group, sessionId: sessionDir, path, bytes: statSync(path).size })
    }
  }
  return out
}
