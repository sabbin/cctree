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
import { planBranch, planBranchTo, buildBranchText } from '../src/branch.js';
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

// --- planBranchTo: a cut that follows an ARM, not the file -------------------
//
// One transcript, rewound once: A is answered, then the person went back to A's
// answer and asked C instead of B. In the file, B's arm sits BETWEEN A and C, so
// cutting the file just before C's answer would carry B along — and a resume
// would continue whichever arm was written last before the cut.
const at = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;
const rec = (o) => JSON.stringify({ sessionId: 's', ...o });
const user = (uuid, parentUuid, text, n) => rec({ type: 'user', uuid, parentUuid, timestamp: at(n), message: { role: 'user', content: text } });
const said = (uuid, parentUuid, n, content = [{ type: 'text', text: 'ok' }], requestId) =>
  rec({ type: 'assistant', uuid, parentUuid, timestamp: at(n), requestId, message: { role: 'assistant', content } });
const result = (uuid, parentUuid, id, n) =>
  rec({ type: 'user', uuid, parentUuid, timestamp: at(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } });

const REWOUND = [
  rec({ type: 'permission-mode', permissionMode: 'default' }),
  user('pA', null, 'question A', 1),
  said('aA', 'pA', 2),
  user('pB', 'aA', 'question B', 3),
  said('aB', 'pB', 4),
  rec({ type: 'last-prompt', leafUuid: 'aB' }),
  user('pC', 'aA', 'question C', 5),
  said('aC', 'pC', 6),
].join('\n');

const keptUuids = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => r.uuid ?? r.type);

test('planBranchTo keeps the arm the node is on and drops the rewound one', () => {
  const { records } = parseText(REWOUND);
  const plan = planBranchTo(records, 'aC');
  assert.equal(plan.ok, true);
  const { text } = buildBranchText(REWOUND, { keepLines: plan.keepLines, newSessionId: 'n' });
  assert.deepEqual(keptUuids(text), ['permission-mode', 'pA', 'aA', 'pC', 'aC']);
});

test('planBranchTo ends ON the node, so the arm before a rewind is reachable too', () => {
  const { records } = parseText(REWOUND);
  const { text } = buildBranchText(REWOUND, { keepLines: planBranchTo(records, 'aB').keepLines, newSessionId: 'n' });
  // The leaf pointer was written after B — it names where the ORIGINAL ended,
  // and is dropped rather than left to contradict the cut.
  assert.deepEqual(keptUuids(text), ['permission-mode', 'pA', 'aA', 'pB', 'aB']);
});

test('planBranchTo keeps a parallel call\'s result that sits beside the chain', () => {
  // The forked encoding (see linearizeTurns): use B hangs off use A, and A's
  // result is a sibling of use B. The chain up from B's result never visits A's
  // result; losing it would leave a tool_use the API refuses to resume.
  const text = [
    user('p', null, 'go', 1),
    said('useA', 'p', 2, [{ type: 'tool_use', id: 'ta', name: 'Read', input: {} }], 'r1'),
    said('useB', 'useA', 3, [{ type: 'tool_use', id: 'tb', name: 'Read', input: {} }], 'r1'),
    result('resA', 'useA', 'ta', 4),
    result('resB', 'useB', 'tb', 5),
    said('done', 'resB', 6),
  ].join('\n');
  const { records } = parseText(text);
  const out = buildBranchText(text, { keepLines: planBranchTo(records, 'done').keepLines, newSessionId: 'n' });
  assert.deepEqual(keptUuids(out.text), ['p', 'useA', 'useB', 'resA', 'resB', 'done']);
});

test('planBranchTo refuses a node the transcript does not hold', () => {
  const { records } = parseText(REWOUND);
  const plan = planBranchTo(records, 'nope');
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no record nope/);
});
