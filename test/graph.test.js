import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscript, stats } from '../src/parse.js';
import { buildGraph, annotate, collapse } from '../src/graph.js';
import { assignLanes } from '../src/lanes.js';
import { renderAscii } from '../src/render-ascii.js';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = join(F, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');
const B = join(F, 'bbbbbbbb-0000-4000-8000-000000000002.jsonl');
const C = join(F, 'cccccccc-0000-4000-8000-000000000003.jsonl');

const load = (...files) => {
  const records = files.flatMap((f) => parseTranscript(f).records);
  return annotate(buildGraph(records));
};

test('parser tolerates garbage without throwing', () => {
  const { records, issues } = parseTranscript(join(F, 'broken.jsonl'));
  assert.equal(records.length, 2, 'keeps every parseable record, including unknown kinds');
  assert.equal(issues.length, 3, 'malformed line, non-object line, truncated tail');
  assert.equal(records[1].kind, 'unknown');
  assert.ok(issues.at(-1).reason.includes('truncated'));
});

test('parser never invents fields it did not see', () => {
  const { records } = parseTranscript(join(F, 'broken.jsonl'));
  const unknown = records.find((r) => r.type === 'brand-new-record-kind-from-a-future-release');
  assert.equal(unknown.timestamp, null);
  assert.equal(unknown.preview, '');
});

test('rewind produces a sibling, not a new root', () => {
  const g = load(A);
  assert.equal(g.roots.length, 1);
  const forkPoint = g.nodes.get('a3');
  assert.equal(forkPoint.children.length, 2, 'a3 has both arms hanging off it');
  assert.deepEqual(forkPoint.children, ['u3', 'u4']);
  assert.equal(g.tips.length, 2, 'both arms stay reachable');
});

test('/branch copies dedupe by uuid, so the fork point falls out for free', () => {
  const g = load(A, B);
  assert.equal(g.roots.length, 1, 'two files, one tree');
  assert.equal(g.nodes.get('a3').children.length, 3, 'three arms off the shared prefix');
  assert.equal(g.nodes.get('a3').sessions.size, 2, 'shared prefix knows it lives in both sessions');
  assert.equal(g.nodes.get('u5').sessions.size, 1, 'the divergent tail does not');
});

test('a dangling parentUuid becomes a root, not an error', () => {
  const g = load(C);
  assert.equal(g.roots.length, 1);
  assert.equal(g.orphans.length, 1);
  assert.equal(g.nodes.get('c0').danglingParent, 'GONE-parent-from-expired-transcript');
  assert.equal(g.nodes.get('c0').kind, 'compact');
});

test('summary records attach to their leaf instead of becoming nodes', () => {
  const g = load(C);
  assert.ok(!g.nodes.has(undefined));
  assert.equal(g.nodes.get('c2').summary, 'Lane allocator work');
});

test('collapse folds tool runs but never crosses a prompt or a fork', () => {
  const g = collapse(annotate(load(A)));
  assert.ok(!g.nodes.has('r2'), 'tool_result absorbed');
  assert.equal(g.nodes.get('a2').collapsedInto, 2, 'a2 + r2 become one node');
  assert.equal(g.nodes.get('a3').children.length, 2, 'the fork point stays its own node');
  assert.equal(g.nodes.get('a3').collapsedInto, undefined, 'forks are never absorbed');
  for (const n of g.nodes.values()) {
    if (n.kind === 'prompt') assert.equal(n.collapsedInto, undefined, 'prompts are never absorbed');
  }
});

test('lane allocator: one lane per live arm, freed when a tip dies', () => {
  const g = collapse(annotate(load(A)));
  const { rows, width } = assignLanes(g);
  assert.equal(width, 2, 'two arms, two lanes');
  assert.equal(rows.length, g.nodes.size, 'every node gets exactly one row');

  const opens = rows.filter((r) => r.opensFrom != null);
  assert.equal(opens.length, 1, 'exactly one lane opens (the rewind)');
  assert.equal(opens[0].uuid, 'u4');
  assert.equal(opens[0].opensFrom, 0);
  assert.equal(opens[0].lane, 1);
});

test('lane allocator reuses a column after its tip dies', () => {
  const g = collapse(annotate(load(A, B)));
  const { rows, width } = assignLanes(g);
  const opens = rows.filter((r) => r.opensFrom != null);
  assert.equal(opens.length, 2, 'three arms means two lanes open off the trunk');
  assert.deepEqual(opens.map((r) => r.lane), [1, 1], 'the second arm recycles the first arm dead column');
  assert.equal(width, 2, 'sequential arms never need a third column');
  // A row may never claim a column another row is drawing a bar through.
  for (const r of rows) assert.ok(!r.through.includes(r.lane));
});

test('renderer emits one line per node plus connector rows', () => {
  const g = collapse(annotate(load(A)));
  const lanes = assignLanes(g);
  const lines = renderAscii(g, lanes, { color: false }).split('\n');
  const nodeLines = lines.filter((l) => /[●○◆◇⊙]/.test(l));
  assert.equal(nodeLines.length, g.nodes.size, 'exactly one line carries each node');
  assert.ok(lines.some((l) => l.includes('forked after #2')), 'the fork names the prompt to rewind to');
  assert.ok(lines.some((l) => l.includes('◆')), 'HEAD is marked');
  assert.ok(lines.some((l) => l.includes('◇')), 'the abandoned arm is marked as a tip');
  assert.ok(lines.some((l) => l.includes('#1')), 'prompts are numbered for the rewind recipe');
});

test('stats surface drift signals', () => {
  const { records } = parseTranscript(A);
  const s = stats(records);
  assert.equal(s.noUuid, 0);
  assert.deepEqual(s.versions, ['2.1.99']);
  assert.ok(s.kinds.prompt >= 3);
});

// ── parallel tool calls (the phantom fork) ──────────────────────────────────

const LINEAR = join(F, 'parallel-linear.jsonl');
const FORKED = join(F, 'parallel-forked.jsonl');

/** Topology as kind-chains, so two files with the same shape compare equal. */
const shape = (g) =>
  g.order.map((u) => {
    const n = g.nodes.get(u);
    return `${n.kind}<-${n.parentUuid ?? 'root'}`;
  });

test('a parallel turn is one chain however the transcript wrote it', () => {
  const linear = load(LINEAR);
  const forked = load(FORKED);
  // The property worth having: which of the two encodings landed on disk is a
  // race, so it must not be observable in the graph.
  assert.deepEqual(shape(forked), shape(linear));
  assert.equal(forked.forks.length, 0, 'no fork survives — nobody branched here');
  assert.equal(forked.tips.length, 1, 'the orphaned tool_result is not a second tip');
});

test('the phantom fork is real in the file and only removed in memory', () => {
  const raw = annotate(buildGraph(parseTranscript(FORKED).records, { linearize: false }));
  assert.equal(raw.forks.length, 1, 'the transcript really does record a fork');
  assert.equal(raw.tips.length, 2, 'and a dead-end tool_result tip');
  assert.equal(raw.nodes.get('A').children.length, 2, 'call A owns both arms');
});

test('the next turn moves to the end of the chain, not beside it', () => {
  const g = load(FORKED);
  // Appending the sibling to the result instead of splicing merely relocates
  // the fork onto the result, which is what the first cut of this did.
  assert.equal(g.nodes.get('t2').parentUuid, 'rB', 'follow-on hangs off the LAST result');
  assert.equal(g.nodes.get('rA').children.length, 1, 'the first result is not a fork either');
  assert.equal(g.relinked.length, 1);
});

test('a genuine rewind fork is never linearized away', () => {
  const g = load(A);
  assert.equal(g.forks.length, 1, 'the rewind under a3 survives');
  assert.equal(g.nodes.get('a3').children.length, 2);
  assert.equal(g.relinked.length, 0, 'nothing to relink: no shared requestId');
});

test('the phantom fork is pinned against a real 2.1.228 transcript', () => {
  // Synthetic fixtures encode what we BELIEVE the two shapes are; this one is
  // captured evidence that a real release still writes them, and that requestId
  // is still the field telling them apart. If a future version stops emitting
  // requestId this test goes red rather than silently doing nothing.
  const REAL = join(F, 'real-2.1.228-fa1b5fc0.jsonl');
  const records = parseTranscript(REAL).records;
  assert.ok(records.some((r) => r.requestId), 'requestId survives redaction');

  const raw = annotate(buildGraph(records, { linearize: false }));
  const fixed = annotate(buildGraph(records));
  assert.equal(raw.forks.length, 2, 'two phantom forks in the file as written');
  assert.equal(fixed.forks.length, 0, 'and none of them is a branch anyone made');
  assert.equal(raw.tips.length, 3);
  assert.equal(fixed.tips.length, 1, 'orphaned tool_results stop counting as tips');
  assert.equal(fixed.relinked.length, 2);
});
