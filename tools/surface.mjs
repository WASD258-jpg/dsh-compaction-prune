/**
 * Pure, allocation-light replay of a session's model-visible surface.
 *
 * The harness's own `foldSurface` is the authority, but it is O(events) per
 * call, so replaying 21k events at every decision point is quadratic. This
 * module maintains the same fold incrementally and is cross-checked against
 * `foldSurface` at every decision point (see `tools/a2-counterfactual.mjs`),
 * so a divergence is detected rather than assumed away.
 *
 * Surface semantics copied from `@deepseek-ai/dsh-session`:
 *   - `surfaceOp: 'append'` pushes the event's own seq onto the tail.
 *   - `surfaceOp: { op: 'replace', startSeq, endSeq }` replaces that inclusive
 *     positional range in place with the new event's seq.
 *
 * @module tools/surface
 */

import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'

/**
 * Append or replace one event in an ordered surface node list.
 *
 * @param nodes - current node seqs, mutated in place.
 * @param event - a decoded session event.
 * @returns nothing; `nodes` is updated.
 * @throws when a replacement names a range absent from `nodes`.
 */
export function applyToSurface(nodes, event) {
  const op = event.surfaceOp
  if (op === undefined) return
  if (op === 'append') {
    nodes.push(event.seq)
    return
  }
  const startIndex = nodes.indexOf(op.startSeq)
  const endIndex = nodes.indexOf(op.endSeq)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`surface: replace at seq ${event.seq} names range ${op.startSeq}-${op.endSeq} absent from the current surface`)
  }
  nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
}

/**
 * Fold a whole event prefix with the harness's own implementation.
 *
 * @param events - a contiguous event list.
 * @returns the harness's surface nodes, as seq numbers.
 */
export function referenceSurface(events) {
  return foldSurface(events).nodes.map((node) => (typeof node === 'object' ? node.seq : node))
}

/**
 * Compare an incrementally maintained surface against the harness's fold.
 *
 * @param nodes - the incremental node list.
 * @param events - the event prefix the list claims to describe.
 * @returns `{ ok, expected, actual }`; `ok` is true only on exact agreement.
 */
export function crossCheck(nodes, events) {
  const expected = referenceSurface(events)
  const actual = [...nodes]
  const ok = expected.length === actual.length && expected.every((seq, index) => seq === actual[index])
  return { ok, expected, actual }
}

/**
 * Derive the model-visible message one surface event produces.
 *
 * @param event - a decoded session event.
 * @returns the derived message, or null when the event produces none.
 */
export function messageOf(event) {
  return deriveEventMessage(event)
}
