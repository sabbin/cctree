// Colour depth.
//
// The property that matters is not which escape comes out — it is that NONE of
// them changes the column arithmetic. Every renderer pads with `vlen`, so the
// same rows at four different depths must strip back to identical text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { colorDepth, makePalette, vlen, vtrunc, wrap, PLAIN } from '../src/palette.js';
import { parseTranscript } from '../src/parse.js';
import { buildGraph, annotate, collapse } from '../src/graph.js';
import { assignLanes } from '../src/lanes.js';
import { renderAsciiRows } from '../src/render-ascii.js';
import { describeSessions, renderSessionRows } from '../src/session-list.js';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = join(F, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('colorDepth reads the terminal instead of assuming one', () => {
  const tty = { isTTY: true };
  assert.equal(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, tty), 0, 'NO_COLOR outranks everything');
  assert.equal(colorDepth({}, { isTTY: false }), 0, 'a pipe is not a terminal');
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, tty), 24);
  assert.equal(colorDepth({ COLORTERM: '24bit' }, tty), 24);
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, tty), 8);
  assert.equal(colorDepth({ TERM: 'xterm-kitty' }, tty), 8);
  assert.equal(colorDepth({ TERM: 'xterm' }, tty), 4, 'a plain terminal still has sixteen colours');
  // FORCE_COLOR is how a caller overrides the pipe test, so it must not be
  // gated behind isTTY.
  assert.equal(colorDepth({ FORCE_COLOR: '3' }, { isTTY: false }), 24);
  assert.equal(colorDepth({ FORCE_COLOR: '1' }, { isTTY: false }), 4);
});

test('depth 0 emits nothing at all, and is what a pipe gets', () => {
  const p = makePalette(0);
  for (const name of ['prompt', 'branch', 'head', 'graft', 'machine', 'faint']) {
    assert.equal(p[name]('x'), 'x', `${name} must be the identity at depth 0`);
  }
  assert.equal(p.select('x', 40), 'x', 'no fill either — there is nothing to fill with');
  assert.equal(PLAIN.depth, 0, 'and that is the default a renderer falls back to');
});

test('one hue, three renderings', () => {
  assert.equal(makePalette(4).prompt('x'), '\x1b[36mx\x1b[0m');
  assert.equal(makePalette(8).prompt('x'), '\x1b[38;5;110mx\x1b[0m');
  assert.equal(makePalette(24).prompt('x'), '\x1b[38;2;126;196;214mx\x1b[0m');
});

test('the selection fill survives the resets inside the row', () => {
  // The bug this exists to prevent: every coloured span in a row closes with
  // \x1b[0m, which clears the BACKGROUND too, so a naive wrap paints only as far
  // as the first span and the highlight looks patchy.
  const p = makePalette(24);
  const row = `id ${p.branch('(Branch 2)')} tail`;
  const filled = p.select(row, 40);
  const opens = filled.match(/\x1b\[48;2;40;38;35m/g) ?? [];
  assert.equal(opens.length, 2, 'reopened after the inner span closed');
  assert.equal(vlen(filled), 40, 'and padded to the full width, measured visibly');
  assert.ok(filled.endsWith('\x1b[0m'));

  // 16 colours has no background to set, so selection degrades to bold rather
  // than to nothing — `▸` carries the same signal positionally at every tier.
  const basic = makePalette(4).select(row, 40);
  assert.match(basic, /^\x1b\[1m/);
  assert.equal(vlen(basic), vlen(row), 'bold does not paint a region, so it does not pad one');
});

test('vlen measures what the eye sees, not what the string holds', () => {
  const p = makePalette(24);
  assert.equal(vlen(p.prompt('abc')), 3);
  assert.ok(p.prompt('abc').length > 20, 'a truecolor escape really is that long');
  assert.equal(vlen(''), 0);
  assert.equal(vlen('plain'), 5);
});

test('colour depth never moves a column', () => {
  // Verify §6. If a pad used `.length` anywhere, a deeper tier would push the
  // text right by the length of an escape sequence and this would catch it.
  const { records } = parseTranscript(A);
  const graph = annotate(buildGraph(records));
  collapse(graph);
  annotate(graph, { headUuid: graph.head });
  const lanes = assignLanes(graph);

  const sessions = describeSessions(
    [{ id: 'aaaaaaaa-1111', file: A, createdAt: 1000, records }],
    { now: Date.parse('2026-08-08T12:00:00Z') },
  );

  for (const width of [80, 100, 200]) {
    const tree = [0, 4, 8, 24].map((d) =>
      renderAsciiRows(graph, lanes, { palette: makePalette(d), width }).map((r) => strip(r.text)),
    );
    const picker = [0, 4, 8, 24].map((d) =>
      renderSessionRows(sessions, { palette: makePalette(d), width }).map((r) => strip(r.text)),
    );
    for (const rows of [tree, picker]) {
      for (const other of rows.slice(1)) assert.deepEqual(other, rows[0], `width ${width}`);
    }
  }
});

test('color: false and an explicit depth-0 palette are the same thing', () => {
  const { records } = parseTranscript(A);
  const graph = annotate(buildGraph(records));
  const lanes = assignLanes(graph);
  const viaFlag = renderAsciiRows(graph, lanes, { color: false, width: 100 });
  const viaPalette = renderAsciiRows(graph, lanes, { palette: makePalette(0), width: 100 });
  assert.deepEqual(viaPalette, viaFlag, 'the shorthand cannot drift from the palette');
});


// ── vtrunc: cutting a row that carries colour ───────────────────────────────

test('vtrunc counts columns, not bytes', () => {
  assert.equal(vtrunc('hello world', 5), 'hello');
  assert.equal(vtrunc('hello', 99), 'hello', 'shorter than the cut is left alone');
  assert.equal(vtrunc('', 5), '');
  assert.equal(vtrunc('hello', 0), '', 'nothing visible survives a zero-width column');
  assert.equal(vtrunc('hello', -3), '');
  // No ellipsis: the pane border says the row was cut, and an … on every row is
  // noise against the tree's lane art.
  assert.doesNotMatch(vtrunc('hello world', 5), /…/);
});

test('vtrunc keeps escapes free and never cuts one in half', () => {
  const p = makePalette(24);
  const row = p.prompt('hello world');
  const cut = vtrunc(row, 5);
  assert.equal(vlen(cut), 5, 'five visible columns');
  assert.ok(cut.length > 20, 'the escapes came along, and they are long');
  assert.doesNotMatch(cut, /\x1b\[38;2;126;196;$/, 'never a fragment of a sequence');
  assert.match(cut, /^\x1b\[38;2;126;196;214mhello/);
});

test('vtrunc emits escapes found past the cut — this is the bleed guard', () => {
  // Verify §8. The closing reset of a span that started BEFORE the cut lives
  // after it. Drop it and the colour runs across the divider and through the
  // whole right-hand pane, which is the failure you actually see on screen.
  const p = makePalette(24);
  const row = `${p.prompt('hello world')} tail`;
  const cut = vtrunc(row, 5);
  assert.ok(cut.endsWith('\x1b[0m'), `unclosed sequence: ${JSON.stringify(cut)}`);
  assert.equal(vlen(cut), 5, 'and emitting them costs no columns');

  // A string that opens a span and never closes it gets one anyway.
  assert.ok(vtrunc('\x1b[36mabcdef', 3).endsWith('\x1b[0m'));
  // A string with no escapes at all gets no gratuitous reset.
  assert.equal(vtrunc('abcdef', 3), 'abc');
});

test('vtrunc survives a selected row, which nests a background under spans', () => {
  const p = makePalette(24);
  const row = p.select(`id ${p.branch('(Branch 2)')} tail`, 40);
  const cut = vtrunc(row, 10);
  assert.equal(vlen(cut), 10);
  assert.ok(cut.endsWith('\x1b[0m'), 'the fill is closed, so it cannot paint the divider');
});

// ── wrap ────────────────────────────────────────────────────────────────────

test('wrap breaks on words and measures visibly', () => {
  assert.deepEqual(wrap('the quick brown fox', 10), ['the quick', 'brown fox']);
  assert.deepEqual(wrap('   spaced   out   ', 20), ['spaced out'], 'whitespace is normalised');
  assert.deepEqual(wrap('', 10), [], 'nothing to wrap is no lines, not one empty one');
  assert.deepEqual(wrap(null, 10), []);
  assert.deepEqual(wrap('anything', 0), [], 'a zero-width column holds nothing');

  const p = makePalette(24);
  const lines = wrap(`${p.prompt('the quick')} brown fox`, 10);
  assert.deepEqual(lines.map(vlen), [9, 9], 'colour costs no columns, so it wraps where it looks like it should');
});

test('wrap cuts a word too long for the column instead of overhanging', () => {
  // In a pane an overhang is a row that runs into the tree beside it.
  const lines = wrap('supercalifragilistic', 8);
  assert.deepEqual(lines, ['supercal', 'ifragili', 'stic']);
  for (const l of lines) assert.ok(vlen(l) <= 8);
});
