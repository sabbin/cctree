// Phase 3 — companion TUI.
//
// The loop itself needs a terminal, so the parts worth testing are deliberately
// pure: key mapping, scroll maths and frame composition take values and return
// values. `--once` renders a single frame with no raw mode, which gives an
// end-to-end path that a test runner can actually drive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  keyAction,
  splitKeys,
  clampOffset,
  frame,
  detailOf,
  runTui,
  resolveOpenTarget,
} from '../src/tui.js';
import { parseTranscript } from '../src/parse.js';
import { buildGraph, annotate, collapse } from '../src/graph.js';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = join(F, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');

const loader = () => {
  const { records } = parseTranscript(A);
  const graph = annotate(buildGraph(records));
  collapse(graph);
  annotate(graph, { headUuid: graph.head });
  return { graph, title: A, files: [A], recordsByFile: new Map([[A, records]]) };
};

const fakeOut = (rows = 24) => ({
  rows,
  isTTY: false,
  buf: '',
  write(s) {
    this.buf += s;
  },
  on() {},
});

test('keyAction matches escape sequences before single characters', () => {
  assert.equal(keyAction('\x1b[A'), 'up');
  assert.equal(keyAction('\x1b[B'), 'down');
  assert.equal(keyAction('k'), 'up');
  assert.equal(keyAction('j'), 'down');
  assert.equal(keyAction('q'), 'quit');
  assert.equal(keyAction('\x03'), 'quit', 'Ctrl-C always quits');
  assert.equal(keyAction('b'), 'branch');
  assert.equal(keyAction('\r'), 'detail');
  // A bare ESC means "go back"; splitKeys has already ensured it is not the
  // head of an arrow sequence by the time it reaches here.
  assert.equal(keyAction('\x1b'), 'back');
  assert.equal(keyAction('z'), null);
});

test('splitKeys separates keypresses that arrived in one chunk', () => {
  // Regression: stdin delivered `jjjq` as a single chunk, the whole string was
  // matched against the key table, nothing matched, and all four keys were
  // dropped — including `q`, so the TUI could not be quit. Caught by driving it
  // through a pty; no amount of pure-function testing would have found it.
  assert.deepEqual(splitKeys('jjjq'), ['j', 'j', 'j', 'q']);
  assert.ok(splitKeys('jjjq').map(keyAction).includes('quit'), 'q survives a burst');

  assert.deepEqual(splitKeys('\x1b[A\x1b[B'), ['\x1b[A', '\x1b[B'], 'escape sequences stay whole');
  assert.deepEqual(splitKeys('j\x1b[Aq'), ['j', '\x1b[A', 'q'], 'mixed chunks split correctly');
  assert.deepEqual(splitKeys('\x1b[5~'), ['\x1b[5~'], 'tilde-terminated sequences too');
  assert.deepEqual(splitKeys('\x1b'), ['\x1b'], 'a bare ESC is its own key');
  assert.deepEqual(splitKeys(''), []);
});

test('clampOffset keeps the selection on screen and never overscrolls', () => {
  // Selection below the viewport pulls it down by the minimum needed.
  assert.equal(clampOffset({ selectedLine: 30, offset: 0, height: 10, total: 100 }), 21);
  // Selection above pulls it up to exactly the selection.
  assert.equal(clampOffset({ selectedLine: 5, offset: 20, height: 10, total: 100 }), 5);
  // Already visible: offset is left alone.
  assert.equal(clampOffset({ selectedLine: 25, offset: 20, height: 10, total: 100 }), 20);
  // Never scrolls past the end, even when asked to.
  assert.equal(clampOffset({ selectedLine: 99, offset: 95, height: 10, total: 100 }), 90);
  // Content shorter than the viewport never scrolls at all.
  assert.equal(clampOffset({ selectedLine: 2, offset: 0, height: 50, total: 5 }), 0);
  assert.equal(clampOffset({ selectedLine: 0, offset: 0, height: 0, total: 5 }), 0);
});

test('frame pads to the viewport so the footer cannot jump', () => {
  const rows = [{ text: 'a', uuid: 'x' }, { text: 'b', uuid: 'y' }];
  const lines = frame({ header: 'H', rows, selectedLine: 0, offset: 0, height: 6 });
  assert.equal(lines[0], 'H');
  assert.equal(lines.length, 1 + 6 + 1, 'header + full viewport + footer');
  assert.ok(lines[1].includes('a'));
  assert.ok(lines[1].includes('\x1b[7m'), 'the selected row is highlighted');
  assert.ok(!lines[2].includes('\x1b[7m'), 'and only that row');
  assert.match(lines.at(-1), /b branch · o open/, 'the footer shows the keys');
});

test('frame shows a scroll position only when content overflows', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `row${i}`, uuid: `u${i}` }));
  const scrolled = frame({ header: 'H', rows: many, selectedLine: 0, offset: 0, height: 10 });
  assert.match(scrolled.at(-1), /1-10\/40/);

  const fits = frame({ header: 'H', rows: many.slice(0, 3), selectedLine: 0, offset: 0, height: 10 });
  assert.doesNotMatch(fits.at(-1), /\d+\/\d+/);
});

test('a status message replaces the help footer', () => {
  const rows = [{ text: 'a', uuid: 'x' }];
  const lines = frame({ header: 'H', rows, selectedLine: 0, offset: 0, height: 2, status: 'branch? [y/n]' });
  assert.equal(lines.at(-1), 'branch? [y/n]');
  assert.doesNotMatch(lines.at(-1), /o open/);
});

test('detailOf reports identity without inventing fields', () => {
  const { graph } = loader();
  const prompt = [...graph.nodes.values()].find((n) => n.kind === 'prompt');
  const detail = detailOf(prompt);
  assert.match(detail, /prompt/);
  assert.match(detail, new RegExp(prompt.uuid));
  assert.match(detail, /#\d/, 'prompts carry their number');
  assert.match(detail, /1 session/);
  assert.equal(detailOf(null), '', 'no selection is not an error');
});

test('--select aims a frame at a prompt number or a uuid prefix', () => {
  const out = fakeOut();
  const result = runTui(loader, { once: true, select: '2', out, input: { isTTY: false } });
  assert.equal(result.selected, 'u2', 'prompt #2 resolves to its node');
  assert.match(out.buf, /uuid u2/, 'and the detail line comes with it');

  const hashed = fakeOut();
  assert.equal(
    runTui(loader, { once: true, select: '#2', out: hashed, input: { isTTY: false } }).selected,
    'u2',
    'a leading # is accepted, since that is how the graph prints it',
  );

  const byUuid = fakeOut();
  assert.equal(
    runTui(loader, { once: true, select: 'a3', out: byUuid, input: { isTTY: false } }).selected,
    'a3',
    'uuid prefixes resolve too — not every node is a numbered prompt',
  );
});

test('an unmatched --select says so instead of quietly picking HEAD', () => {
  const out = fakeOut();
  runTui(loader, { once: true, select: '99', out, input: { isTTY: false } });
  assert.match(out.buf, /no node matching "99"/);
});

test('o opens the branch you just made, else the node under the cursor', () => {
  const node = { record: { sessionId: 'session-of-the-node' } };

  // A fresh branch wins: it is what you were just doing.
  assert.equal(resolveOpenTarget({ lastBranchId: 'brand-new', node }).id, 'brand-new');
  // Otherwise `o` means "open whatever is selected", which is how you move
  // between arms that already exist rather than only ones you create.
  assert.equal(resolveOpenTarget({ node }).id, 'session-of-the-node');
  // A node with no session (a synthetic or hand-built record) is not an error.
  assert.equal(resolveOpenTarget({ node: { record: {} } }).id, null);
  assert.match(resolveOpenTarget({}).reason, /branch first with b/);
});

test('--once renders a full frame with no terminal', () => {
  const out = fakeOut();
  const result = runTui(loader, { once: true, out, input: { isTTY: false } });
  assert.deepEqual(result.branched, []);
  const text = out.buf;
  assert.match(text, /nodes ·/, 'header is present');
  assert.match(text, /#1/, 'and the graph body');
  assert.ok(!text.includes('\x1b[?1049h'), 'never enters the alternate screen');
});

test('the interactive loop refuses to start without a terminal', () => {
  assert.throws(
    () => runTui(loader, { once: false, out: fakeOut(), input: { isTTY: false } }),
    /needs a terminal/,
    'better than silently corrupting a pipe',
  );
});
