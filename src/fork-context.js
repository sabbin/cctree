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


/**
 * Where an unused `/fork` belongs in a MERGED tree.
 *
 * `inheritedFor()` above answers the single-file question — "open this empty
 * fork, show me what it starts from" — by borrowing the parent's records. That
 * is the wrong answer when the parent is already on screen: its records are
 * there, and what is missing is the fork itself, which has none. A family view
 * that silently omits the fork is drawing a tree with a limb sawn off.
 *
 * So the fork gets one synthetic record, and the graph does the rest — lanes, a
 * connector, a tip. The record is marked `inferred` and rendered as such: it is
 * evidence of a file's existence and creation time, not of anything anybody said.
 *
 * The inference is smaller than `inheritedFor()`'s. Which parent comes from the
 * same title match, but the cut point only has to name ONE record — the parent's
 * last at or before the fork's creation — rather than slicing a whole history.
 *
 * @param {string[]} files every transcript in the view
 * @param {object[]} records their parsed records, each carrying `.file`
 * @returns {object[]} zero or more synthetic records, safe to concat and rebuild
 */
export function forkStubs(files, records, deps = {}) {
  const { birth = birthOf } = deps;
  // A single file is `inheritedFor()`'s job: with no parent on screen there is
  // nothing to attach to, and borrowing the history is the better answer.
  if (!files || files.length < 2) return [];

  const byFile = new Map(files.map((f) => [f, []]));
  for (const r of records) byFile.get(r.file)?.push(r);

  const forks = [];
  const hosts = [];
  for (const file of files) {
    const rs = byFile.get(file) ?? [];
    if (!rs.length) continue;
    const born = birth(file);
    const title = aiTitleOf(rs);
    // Anything with a record of its own is a possible parent, never a stub: an
    // inference must not stand in front of real data, which is the same guard
    // `inheritedFor()` opens with.
    if (rs.some((r) => r.uuid)) {
      hosts.push({ file, rs, born, base: title ? title.replace(FORK_SUFFIX, '').trim() : null });
      continue;
    }
    if (!born || !title || !FORK_SUFFIX.test(title)) continue;
    const base = title.replace(FORK_SUFFIX, '').trim();
    if (base) forks.push({ file, born, base, sessionId: rs.find((r) => r.sessionId)?.sessionId ?? null });
  }

  const stubs = [];
  for (const fork of forks) {
    // Nearest older session whose own title matches — the same tie-break the
    // picker nests by. A `/branch` copy cannot win this: `/branch` writes a
    // `custom-title` and does NOT copy the parent's `ai-title`, so a branch has
    // no `base` at all and only the true parent can match.
    let parent = null;
    for (const h of hosts) {
      if (!h.born || h.born >= fork.born || h.base !== fork.base) continue;
      if (!parent || h.born > parent.born) parent = h;
    }
    if (!parent) continue;

    // Records the parent wrote after the fork was created are its own
    // continuation — `/fork` does not move the conversation — so the attachment
    // is its last record at or before that moment.
    let attach = null;
    for (const r of parent.rs) {
      if (!r.uuid || !r.timestamp || r.timestamp > fork.born) continue;
      if (!attach || r.timestamp > attach.timestamp) attach = r;
    }
    if (!attach) continue;

    stubs.push({
      uuid: `fork:${fork.sessionId ?? fork.file}`,
      parentUuid: attach.uuid,
      type: 'fork',
      kind: 'fork',
      subkind: null,
      timestamp: fork.born,
      sessionId: fork.sessionId,
      cwd: null,
      gitBranch: null,
      version: null,
      isSidechain: false,
      leafUuid: null,
      requestId: null,
      toolUseIds: null,
      toolResultFor: null,
      checkpoint: null,
      preview: 'no prompt yet',
      file: fork.file,
      line: 0,
      // Never a real record, and everything downstream may rely on knowing it.
      inferred: true,
      raw: null,
    });
  }
  return stubs;
}
