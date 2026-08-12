// What an unused `/fork` shows.
//
// The dependencies are injected rather than staged on disk: the rule turns on
// file CREATION times, and no API lets a test set one, so a filesystem-backed
// version of these would be timing-dependent for no gain in coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inheritedFor } from '../src/fork-context.js';

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
