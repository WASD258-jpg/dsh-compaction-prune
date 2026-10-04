/**
 * Rebuild a live `Session` from a recorded event log, verbatim.
 *
 * Every event is re-appended in order so the reconstructed session's `seq`
 * numbers equal the recorded ones. That equality is what lets the
 * counterfactual align a replayed measurement with the recorded trajectory.
 *
 * Three log-format details have to be honoured, and all three are recorded
 * exactly as the persistence backend wrote them:
 *
 *   1. `sourceEventSeqs` is RANGE-ENCODED (`[[16,19],27,31]` means 16,17,18,19,
 *      27,31). `Session.append()` takes the decoded list, so the encoded form has
 *      to be decoded with the harness's own `decodeSeqRanges`.
 *   2. A header with `isSeeded: true` requires an explicit constructor seed whose
 *      length equals the inherited prefix, with the final inherited
 *      `session/end-seed` marker at `inheritedEventCount`.
 *   3. The constructor always appends a trailing `session/end-seed` when the
 *      seed does not end with one, which would shift every later seq. Seeding
 *      with the recorded prefix (marker included) keeps seq alignment exact.
 *
 * @module tools/replay
 */

import { Session, decodeSeqRanges } from '@deepseek-ai/dsh-session'

/**
 * The `inheritedEventCount` a seeded header implies.
 *
 * @param header - the recorded session header.
 * @param events - the recorded event list.
 * @returns the index of the final inherited marker, or undefined when unseeded.
 */
export function inheritedCountFor(header, events) {
  if (header.isSeeded !== true) return undefined
  let found
  for (const [index, event] of events.entries()) {
    if (event.type === 'session/end-seed' && event.data?.inherited === true) found = index
  }
  return found
}

/**
 * Append one recorded event to a reconstructed session.
 *
 * @param session - the reconstructed session.
 * @param event - a decoded event from the log.
 * @returns the appended event.
 */
export function appendRecorded(session, event) {
  return session.append(event.type, event.data, {
    surfaceOp: event.surfaceOp,
    sourceEventSeqs: event.sourceEventSeqs === undefined
      ? undefined
      : decodeSeqRanges(event.sourceEventSeqs),
  })
}

/**
 * The log index at which a reconstruction must start appending.
 *
 * @param header - the recorded session header.
 * @param events - the recorded event list.
 * @returns the first index not covered by the constructor seed.
 */
export function seedBoundary(header, events) {
  const inherited = inheritedCountFor(header, events)
  return inherited === undefined ? 0 : inherited + 1
}

/**
 * Build a session seeded with a recorded prefix.
 *
 * @param header - the recorded header record (it carries `version` and `id`).
 * @param seedEvents - the prefix the constructor adopts; `[]` when unseeded.
 * @returns the reconstructed `Session`.
 * @throws when the prefix does not satisfy the session's own seed contract.
 */
export function seedSession(header, seedEvents) {
  const inherited = inheritedCountFor(header, seedEvents)
  // An EMPTY ARRAY is not the same as no seed: the constructor appends a
  // trailing `session/end-seed` whenever a seed is supplied and the log does not
  // already end with one, which would shift every subsequent seq by one.
  if (inherited === undefined) return Session.create(header.id, undefined, header)
  return Session.create(header.id, [...seedEvents], header, inherited)
}
