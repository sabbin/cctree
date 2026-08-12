// Phase 2a — programmatic branching.
//
// The behaviour these pin down was measured, not assumed: a real `/branch` of
// this project's own session preserved all 291 uuids and rewrote only
// `sessionId`. A synthesized branch built by these functions was then resumed
// with `claude -r` and had exactly the expected history, which is what makes
// writing a session file a supportable operation rather than a guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { parseTranscript, parseText } from '../src/parse.js';
import { planBranch, buildBranchText } from '../src/branch.js';
import { buildGraph, annotate } from '../src/graph.js';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = join(F, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');

test('planBranch cuts before the chosen prompt, not after it', () => {
  const { records } = parseTranscript(A);
  const plan = planBranch(records, 2);
  assert.equal(plan.ok, true);
  assert.equal(plan.target.uuid, 'u2', 'prompt #2 is the cut point');
  assert.equal(plan.cutLine, plan.target.line);
  assert.equal(plan.keptLines, plan.target.line - 1, 'everything strictly before it survives');
  // Rewind semantics: #2 and every later prompt is left behind so you can ask
  // #2 differently. Fixture A has four prompts.
  assert.equal(plan.droppedPrompts, 3);
});

test('planBranch refuses branches that cannot exist', () => {
  const { records } = parseTranscript(A);
  const first = planBranch(records, 1);
  assert.equal(first.ok, false);
  assert.match(first.reason, /empty session/, 'branching before #1 would produce nothing');

  const past = planBranch(records, 99);
  assert.equal(past.ok, false);
  assert.match(past.reason, /no prompt #99/);
  assert.equal(past.available, 4);
});

test('a branch rewrites sessionId and nothing else', () => {
  const source = readFileSync(A, 'utf8');
  const { records } = parseTranscript(A);
  const plan = planBranch(records, 3);
  const { text, kept, rewritten } = buildBranchText(source, {
    cutLine: plan.cutLine,
    newSessionId: 'new-session-id',
  });

  assert.equal(kept, plan.keptLines);
  assert.equal(rewritten, kept, 'every copied record carries the new session id');

  const original = source.split('\n').filter((l) => l.trim()).slice(0, kept).map((l) => JSON.parse(l));
  const copied = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  for (const [i, c] of copied.entries()) {
    const o = original[i];
    assert.equal(c.sessionId, 'new-session-id');
    assert.equal(c.uuid, o.uuid, 'uuids survive the copy — dedupe depends on it');
    assert.equal(c.parentUuid, o.parentUuid, 'so does the parent link');
    // Everything other than the session id must come across untouched, including
    // fields this build does not understand.
    assert.deepEqual({ ...c, sessionId: null }, { ...o, sessionId: null });
  }
});

test('a branch dedupes against its original into one tree with a fork', () => {
  // The end-to-end property: feed the original and a cctree-made branch to the
  // graph builder and the fork point falls out with no fork-edge concept.
  const source = readFileSync(A, 'utf8');
  const { records } = parseTranscript(A);
  const plan = planBranch(records, 3);
  const { text } = buildBranchText(source, { cutLine: plan.cutLine, newSessionId: 'branch-session' });

  // The branch then continues with a different prompt, as a real one would.
  const continued =
    text +
    JSON.stringify({
      uuid: 'b1',
      parentUuid: 'a3',
      type: 'user',
      sessionId: 'branch-session',
      timestamp: '2026-08-01T11:00:00.000Z',
      message: { role: 'user', content: 'a different third question' },
    }) +
    '\n';

  const graph = annotate(
    buildGraph([...records, ...parseText(continued, 'branch.jsonl').records]),
  );
  assert.equal(graph.roots.length, 1, 'two files, one tree');
  const forkPoint = graph.nodes.get('a3');
  assert.ok(forkPoint.children.includes('b1'), 'the branch hangs off the cut point');
  assert.ok(forkPoint.children.length >= 2, 'and so does the original arm');
  assert.equal(graph.nodes.get('u1').sessions.size, 2, 'the shared prefix knows both sessions');
  assert.equal(graph.nodes.get('b1').sessions.size, 1, 'the divergent tail does not');
});

test('an unparseable line is carried across, never dropped', () => {
  // Same tolerance rule as the parser: a line we cannot read was still part of
  // the conversation, and dropping it would silently truncate history.
  const source = ['{"uuid":"x1","sessionId":"old","type":"user"}', '{ not json at all', ''].join('\n');
  const { text, kept, rewritten } = buildBranchText(source, { cutLine: 4, newSessionId: 'fresh' });
  const lines = text.split('\n').filter((l) => l.trim());
  assert.equal(kept, 2);
  assert.equal(rewritten, 1, 'only the parseable record could be rewritten');
  assert.equal(lines[1], '{ not json at all', 'the bad line survives verbatim');
});
