// What an unused `/fork` shows.
//
// The dependencies are injected rather than staged on disk: the rule turns on
// file CREATION times, and no API lets a test set one, so a filesystem-backed
// version of these would be timing-dependent for no gain in coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inheritedFor, forkStubs } from '../src/fork-context.js';

const FORKED = 'Test simple reply conversation ⑂';
const PARENT = 'Test simple reply conversation';

const sidecar = (aiTitle) => ({ uuid: null, kind: 'sidecar', raw: { type: 'ai-title', aiTitle } });
const node = (uuid, ts, kind = 'prompt', preview = '') => ({
  uuid,
  kind,
  preview,
  timestamp: Date.parse(ts),
});

// Parent born first, fork created between prompt E and prompt F — the shape a
// real `/fork` produces, since forking does not move the conversation.
const CUT = Date.parse('2026-08-12T13:30:51.000Z');
const parentRecords = [
  sidecar(PARENT),
  node('a', '2026-08-12T13:29:39.000Z', 'prompt', 'CONV A'),
  node('b', '2026-08-12T13:29:47.000Z', 'prompt', 'CONV B'),
  node('e', '2026-08-12T13:30:43.000Z', 'prompt', 'CONV E'),
  node('f', '2026-08-12T13:30:56.000Z', 'prompt', 'CONV F'),
  node('g', '2026-08-12T13:31:05.000Z', 'prompt', 'CONV G'),
];

const deps = (overrides = {}) => ({
  birth: (f) => (f === '/p/fork.jsonl' ? CUT : CUT - 60_000),
  sessions: () => [{ id: 'parent', path: '/p/parent.jsonl' }],
  read: () => parentRecords,
  ...overrides,
});

test('an unused fork borrows its parent history up to the cut', () => {
  const got = inheritedFor('/p/fork.jsonl', [sidecar(FORKED)], deps());
  assert.ok(got, 'the parent is found by its title');
  assert.equal(got.parentId, 'parent');
  assert.deepEqual(got.records.map((r) => r.preview), ['CONV A', 'CONV B', 'CONV E']);
  assert.ok(got.records.every((r) => r.inherited === true), 'tagged, so the view can say whose they are');
  assert.equal(got.inferred, true);
});

test('records written after the fork was created are not inherited', () => {
  // The parent keeps going after the fork; those prompts are the parent's own
  // continuation and the fork never saw them. Getting this wrong would show a
  // fork containing work that happened somewhere else.
  const got = inheritedFor('/p/fork.jsonl', [sidecar(FORKED)], deps());
  assert.ok(!got.records.some((r) => r.preview === 'CONV F' || r.preview === 'CONV G'));
});

test('a fork with any records of its own inherits nothing', () => {
  // The inference must never stand in front of real data — the moment the fork
  // is used it has a history and this stops applying.
  const used = [sidecar(FORKED), node('own1', '2026-08-12T13:32:00.000Z', 'prompt', 'CONV F')];
  assert.equal(inheritedFor('/p/fork.jsonl', used, deps()), null);
});

test('a session that is not a fork is left alone', () => {
  assert.equal(inheritedFor('/p/fork.jsonl', [sidecar(PARENT)], deps()), null, 'no glyph, no claim');
  assert.equal(inheritedFor('/p/fork.jsonl', [], deps()), null, 'nothing to go on');
});

test('no candidate parent means no invented history', () => {
  assert.equal(
    inheritedFor('/p/fork.jsonl', [sidecar('Some other conversation ⑂')], deps()),
    null,
    'a title that matches nothing yields nothing',
  );
  assert.equal(
    inheritedFor('/p/fork.jsonl', [sidecar(FORKED)], deps({ sessions: () => [] })),
    null,
    'no sessions to match against',
  );
});

test('a parent created after the fork cannot be its parent', () => {
  const got = inheritedFor('/p/fork.jsonl', [sidecar(FORKED)], deps({ birth: () => CUT }));
  assert.equal(got, null, 'same or later creation time is not an ancestor');
});

test('without a creation time it declines rather than guessing the cut', () => {
  const got = inheritedFor('/p/fork.jsonl', [sidecar(FORKED)], deps({ birth: () => 0 }));
  assert.equal(got, null);
});


// ── the fork's place in a merged tree ───────────────────────────────────────
//
// `inheritedFor` answers the single-file question by borrowing the parent's
// history. In a family view the parent is already on screen, so the missing
// thing is the fork itself — which has no records at all, and would otherwise
// be a limb sawn off a tree that claims to show the whole conversation.

const FORK_FILE = '/p/fork.jsonl';
const PARENT_FILE = '/p/parent.jsonl';
const withFile = (records, file) => records.map((r) => ({ ...r, file }));
const stubDeps = (born = {}) => ({
  birth: (f) => born[f] ?? (f === FORK_FILE ? CUT : CUT - 60_000),
});

test('an unused fork is placed where it was cut from', () => {
  const records = [
    ...withFile(parentRecords, PARENT_FILE),
    ...withFile([sidecar(FORKED)], FORK_FILE),
  ];
  const stubs = forkStubs([PARENT_FILE, FORK_FILE], records, stubDeps());
  assert.equal(stubs.length, 1);
  const [stub] = stubs;
  // E is the last prompt written before the fork existed; F and G came after,
  // and `/fork` does not move the conversation, so they are the parent's own.
  assert.equal(stub.parentUuid, 'e', 'attached after the last record it could have seen');
  assert.equal(stub.kind, 'fork');
  assert.equal(stub.file, FORK_FILE);
  assert.equal(stub.timestamp, CUT, 'its creation time is the only time it has');
  assert.equal(stub.inferred, true, 'and it is never mistaken for a record');
});

test('a fork with records of its own is never stubbed', () => {
  // The load-bearing guard, the same one `inheritedFor` opens with: an
  // inference must never stand in front of real data.
  const records = [
    ...withFile(parentRecords, PARENT_FILE),
    ...withFile([sidecar(FORKED), node('x', '2026-08-12T13:32:00.000Z', 'prompt', 'its own')], FORK_FILE),
  ];
  assert.deepEqual(forkStubs([PARENT_FILE, FORK_FILE], records, stubDeps()), []);
});

test('a single file is left to inheritedFor', () => {
  // With no parent on screen there is nothing to attach to, and borrowing the
  // history is the better answer — two mechanisms, no overlap.
  const records = withFile([sidecar(FORKED)], FORK_FILE);
  assert.deepEqual(forkStubs([FORK_FILE], records, stubDeps()), []);
});

test('a fork created before its supposed parent is not placed', () => {
  const records = [
    ...withFile(parentRecords, PARENT_FILE),
    ...withFile([sidecar(FORKED)], FORK_FILE),
  ];
  const stubs = forkStubs([PARENT_FILE, FORK_FILE], records, stubDeps({ [FORK_FILE]: CUT - 120_000 }));
  assert.deepEqual(stubs, [], 'nothing older can be its parent');
});

test('a /branch copy cannot be mistaken for the fork\'s parent', () => {
  // `/branch` writes a `custom-title` and does NOT copy the parent\'s
  // `ai-title`, so a branch carries no matching title and only the true parent
  // can win — which is what stops a copied prefix claiming the fork.
  const BRANCH_FILE = '/p/branch.jsonl';
  const records = [
    ...withFile(parentRecords, PARENT_FILE),
    ...withFile(parentRecords.filter((r) => r.uuid), BRANCH_FILE),
    ...withFile([sidecar(FORKED)], FORK_FILE),
  ];
  const stubs = forkStubs([PARENT_FILE, BRANCH_FILE, FORK_FILE], records, {
    birth: (f) => (f === FORK_FILE ? CUT : f === BRANCH_FILE ? CUT - 30_000 : CUT - 60_000),
  });
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0].uuid.includes('fork'), true);
});

test('a fork whose parent is absent from the view is not invented', () => {
  const records = withFile([sidecar(FORKED)], FORK_FILE);
  const other = withFile([node('z', '2026-08-12T13:29:00.000Z', 'prompt', 'unrelated')], '/p/other.jsonl');
  assert.deepEqual(forkStubs([FORK_FILE, '/p/other.jsonl'], [...records, ...other], stubDeps()), []);
});
