// What to show when a `/fork` has not been used yet.
//
// A real `/fork` writes two title sidecars and NOTHING else until its first
// prompt lands, so opening one shows an empty tree — technically honest and
// completely useless, since the thing you want to see is what the fork starts
// from. That history exists, just in the parent's file.
//
// Two inferences are needed to find it, and both are labelled as inferences
// wherever the result is drawn:
//
//   which parent — `/fork` titles its child with the parent's `ai-title` plus
//   U+2442, so an exact match after stripping the glyph names the parent. This
//   is the same evidence the picker nests it by; there is nothing else, because
//   an unused fork shares no uuids with anything.
//
//   where it was cut — the fork file's creation time. Records written to the
//   parent before that moment are what the fork inherits; records after it are
//   the parent's own continuation, which the fork never saw. Verified against a
//   real fork: the split lands exactly between the prompt before it and the
//   prompt after, and `/fork` does not move the conversation, so the parent
//   keeps growing past the cut.
//
// The moment the fork receives a prompt it gets records of its own and this
// stops applying — `inheritedFor()` returns null as soon as one in-tree record
// exists, so the inferred view can never mask real data.

import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseTranscript } from './parse.js';
import { listSessions } from './sessions.js';
import { FORK_SUFFIX } from './session-list.js';

/** The last `ai-title` sidecar in a file, which is the one that won. */
function aiTitleOf(records) {
  let title = null;
  for (const r of records) {
    if (r.uuid) continue; // titles are sidecars; a node is never one
    const t = r.raw?.aiTitle;
    if (typeof t === 'string' && t.trim()) title = t.trim();
  }
  return title;
}

function birthOf(file) {
  try {
    return statSync(file).birthtimeMs || 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the history an unused fork inherits.
 *
 * @param {string} file the transcript being opened
 * @param {object[]} records its own parsed records
 * @returns {null | {records: object[], parentFile: string, parentId: string,
 *                   cutoff: number, inferred: true}}
 */
export function inheritedFor(file, records, deps = {}) {
  // Injectable so the rule can be tested without depending on real file
  // creation times, which no API lets a test set.
  const {
    birth = birthOf,
    sessions = listSessions,
    read = (f) => parseTranscript(f).records,
  } = deps;
  // Any record of its own and this does not apply. Checked first and cheaply:
  // it is what keeps an inference from ever standing in front of real data.
  if (!records.length || records.some((r) => r.uuid)) return null;

  const title = aiTitleOf(records);
  if (!title || !FORK_SUFFIX.test(title)) return null;
  const base = title.replace(FORK_SUFFIX, '').trim();
  if (!base) return null;

  const cutoff = birth(file);
  if (!cutoff) return null; // no creation time, no cut point, no guess

  let parent = null;
  for (const s of sessions(dirname(file))) {
    if (s.path === file) continue;
    const born = birth(s.path);
    if (!born || born >= cutoff) continue;
    const theirs = read(s.path);
    if (!theirs.some((r) => r.uuid)) continue;
    const t = aiTitleOf(theirs);
    if (!t || t.replace(FORK_SUFFIX, '').trim() !== base) continue;
    // Nearest such ancestor wins, the same tie-break the picker uses.
    if (!parent || born > parent.born) parent = { path: s.path, id: s.id, born, records: theirs };
  }
  if (!parent) return null;

  // Everything the parent had written by the time the fork was created. Records
  // are tagged rather than copied silently: the renderer says whose they are.
  const inherited = parent.records
    .filter((r) => r.uuid && r.timestamp && r.timestamp <= cutoff)
    .map((r) => ({ ...r, inherited: true }));
  if (!inherited.length) return null;

  return { records: inherited, parentFile: parent.path, parentId: parent.id, cutoff, inferred: true };
}
