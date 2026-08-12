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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  paneGeometry,
  timelinePanel,
  keyAction,
  splitKeys,
  clampOffset,
  frame,
  detailOf,
  detailLines,
  runTui,
  resolveOpenTarget,
} from '../src/tui.js';
import { makePalette, vlen } from '../src/palette.js';
import { parseTranscript } from '../src/parse.js';
import { buildGraph, annotate, collapse } from '../src/graph.js';
import { assignLanes } from '../src/lanes.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A throwaway project: a parent transcript and a `/branch` of it, under a
 * CLAUDE_CONFIG_DIR of their own.
 *
 * Hermetic on purpose. The first version of the pty test below drove the
 * author's own transcript directory and named a session id out of it, which
 * would fail on any other machine and quietly rot on this one.
 */
function tempProject() {
  const home = mkdtempSync(join(tmpdir(), 'cctree-home-'));
  const cwd = join(home, 'work');
  const dir = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });

  const at = (m) => `2026-08-08T10:${String(m).padStart(2, '0')}:00.000Z`;
  const rec = (session) => (uuid, parentUuid, minute, role, text) =>
    JSON.stringify({
      uuid,
      parentUuid,
      type: role,
      sessionId: session,
      cwd,
      timestamp: at(minute),
      message: { role, content: text },
    });
  const P = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const p = rec(P);
  const b = rec(B);
  const shared = [
    ['u1', null, 1, 'user', 'ALPHA the shared opening prompt'],
    ['a1', 'u1', 2, 'assistant', 'a reply'],
  ];
  writeFileSync(
    join(dir, `${P}.jsonl`),
    [...shared.map((a) => p(...a)), p('u2', 'a1', 3, 'user', 'TRUNK continues here')].join('\n'),
  );
  // Strictly later, or `describeSessions` cannot tell which one is the branch —
  // birthtime is the only evidence, and copied records keep their timestamps.
  const until = Date.now() + 15;
  while (Date.now() < until) {
    /* the filesystem needs a measurably different creation time */
  }
  writeFileSync(
    join(dir, `${B}.jsonl`),
    [...shared.map((a) => b(...a)), b('b1', 'a1', 4, 'user', 'BRANCHED off here')].join('\n'),
  );
  return { home, cwd, dir, parent: P, branch: B, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Drive the real binary through a pty and return its LAST frame. */
function pty(project, keys, cols, args = '') {
  const raw = execFileSync(
    'script',
    ['-qec', `stty cols ${cols} rows 24 2>/dev/null; ${BIN} tui --cwd ${project.cwd} ${args}`, '/dev/null'],
    { input: keys, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: project.home } },
  );
  const frames = raw.split('\x1b[2J');
  return frames[frames.length - 1].replace(/\x1b\[[0-9;]*m/g, '');
}
const BIN = join(REPO, 'bin', 'cctree');
const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const A = join(F, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');

const loader = () => {
  const { records } = parseTranscript(A);
  const graph = annotate(buildGraph(records));
  collapse(graph);
  annotate(graph, { headUuid: graph.head });
  return { graph, title: A, files: [A], recordsByFile: new Map([[A, records]]) };
};

const fakeOut = (rows = 24, columns = undefined) => ({
  rows,
  columns,
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
  assert.equal(keyAction('f'), 'family', 'widen the tree to the whole conversation');
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
  assert.match(lines.at(-1), /b branch {3}o open/, 'the footer shows the keys');
});

test('the selected row is tinted, never reversed', () => {
  // Reverse video flattens every colour in the row, which throws away exactly
  // the distinctions the picker exists to draw. A background tint keeps them.
  const rows = [{ text: `id ${makePalette(24).branch('(Branch 2)')}`, uuid: 'x' }, { text: 'b', uuid: 'y' }];
  const lines = frame({
    header: 'H',
    rows,
    selectedLine: 0,
    offset: 0,
    height: 2,
    palette: makePalette(24),
    width: 30,
  });
  assert.doesNotMatch(lines[1], /\x1b\[7m/, 'no reverse video anywhere');
  assert.match(lines[1], /\x1b\[48;2;/, 'a background instead');
  assert.match(lines[1], /\x1b\[38;2;214;166;90m/, 'and the badge keeps its own colour under it');
  assert.equal(vlen(lines[1]), 30, 'filled to the full row width, measured visibly');
  assert.equal(lines[2], 'b', 'and only the selected row');
});

test('with no colour the selection is the gutter marker alone', () => {
  // Nothing is distinguished by colour alone: at depth 0 there is no background
  // to tint, so `frame` leaves the row exactly as the renderer drew it — and the
  // renderer has already put a `▸` in the gutter.
  const rows = [{ text: '▸ a', uuid: 'x' }];
  const lines = frame({ header: 'H', rows, selectedLine: 0, offset: 0, height: 1, width: 40 });
  assert.equal(lines[1], '▸ a', 'byte-identical to the unselected text');
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


// ── the detail pane's field list ────────────────────────────────────────────

test('detailOf and detailLines read the same fields', () => {
  // Two lists would drift the moment a field was added to whichever one was in
  // front of you, so both presentations come off one.
  const { graph } = loader();
  const prompt = [...graph.nodes.values()].find((n) => n.kind === 'prompt');
  const line = detailOf(prompt, undefined, graph);
  const pane = detailLines(prompt, graph, undefined, 40).join('\n');

  for (const shared of [prompt.uuid, `#${prompt.promptNo}`, 'prompt']) {
    assert.ok(line.includes(shared), `the line dropped ${shared}`);
    assert.ok(pane.includes(shared), `the pane dropped ${shared}`);
  }
  assert.equal(detailLines(null, graph, undefined, 40).length, 0, 'no selection is not an error');
  assert.deepEqual(detailLines(prompt, graph, undefined, 0), [], 'nor is a zero-width pane');
});

test('the pane names what b would branch from', () => {
  // `ancestorPrompt` already computed this for the fork notes; it is the single
  // most useful line in the pane, because it is what `b` acts on.
  const { graph } = loader();
  const prompt = [...graph.nodes.values()].find((n) => n.kind === 'prompt' && n.promptNo === 2);
  const own = detailLines(prompt, graph, undefined, 40).join('\n');
  assert.match(own, /rewind to\s+#2/, 'a prompt is its own cut point — b branches BEFORE it');

  // A node under a prompt names the prompt above it, which is where the cursor
  // would have to go first.
  const under = graph.nodes.get(prompt.children[0]);
  assert.match(detailLines(under, graph, undefined, 40).join('\n'), /rewind to\s+#2/);
});

test('every pane line fits the width it was given, at every tier', () => {
  const { graph } = loader();
  const node = [...graph.nodes.values()].find((n) => n.kind === 'prompt');
  for (const depth of [0, 4, 8, 24]) {
    for (const width of [38, 44, 52]) {
      for (const l of detailLines(node, graph, makePalette(depth), width)) {
        assert.ok(vlen(l) <= width, `${vlen(l)} > ${width} at depth ${depth}: ${JSON.stringify(l)}`);
      }
    }
  }
});

test('the uuid is wrapped, never elided — it is the field you copy', () => {
  const { graph } = loader();
  const node = [...graph.nodes.values()].find((n) => n.kind === 'prompt');
  const long = { ...node, uuid: '0f0e0d0c-1b1a-4919-8817-161514131211' };
  const pane = detailLines(long, graph, undefined, 38).join('');
  assert.ok(pane.includes('0f0e0d0c-1b1a-4919-8817-161514131211'.slice(0, 20)), 'the head survives');
  assert.doesNotMatch(pane, /…/, 'and nothing was thrown away to make it fit');
});


// ── §3.3 the split frame ────────────────────────────────────────────────────

const paneRows = () => [
  { text: 'plain row', uuid: 'a' },
  { text: '\x1b[36mcoloured row\x1b[0m', uuid: 'b' },
  { text: '', uuid: null },
  { text: '▸ a much longer row than the left column can possibly hold', uuid: 'c' },
];

test('frame without a pane is byte-identical to frame before §3 existed', () => {
  // Verify §7. `detail`/`detailWidth` are additive: every existing call site
  // passes neither, and the no-pane branch is kept separate precisely so it
  // cannot be refactored into the split path by accident.
  const rows = paneRows();
  for (const depth of [0, 4, 8, 24]) {
    for (const selectedLine of [0, 3]) {
      const args = {
        header: 'H1\nH2',
        rows,
        selectedLine,
        offset: 0,
        height: 6,
        palette: makePalette(depth),
        width: 80,
      };
      assert.deepEqual(frame({ ...args, detail: [], detailWidth: 0 }), frame(args), `depth ${depth}`);
      assert.deepEqual(frame({ ...args, detail: ['ignored'], detailWidth: 0 }), frame(args), 'width 0 wins');
    }
  }
});

test('the split frame is one grid: header full width, two columns, keybar full width', () => {
  const lines = frame({
    header: 'H1\nH2',
    rows: paneRows(),
    selectedLine: 0,
    offset: 0,
    height: 6,
    width: 130,
    detail: ['NODE  abc12345', '', 'kind       prompt'],
    detailWidth: 40,
  });
  assert.equal(lines[0], 'H1', 'the header spans the split, above it');
  assert.equal(lines[1], 'H2');
  const body = lines.slice(2, 8);
  assert.equal(body.length, 6, 'one line per viewport row, pane or no pane');
  // Measured visibly — `indexOf` counts escape bytes, which is the same mistake
  // the renderer would be making if the columns were ragged.
  const dividerAt = (l) => vlen(l.slice(0, l.indexOf('│')));
  for (const l of body) {
    assert.equal(dividerAt(l), 130 - 40 - 3 + 1, `divider ragged: ${JSON.stringify(l)}`);
  }
  assert.match(body[0], /plain row/);
  assert.match(body[0], /NODE {2}abc12345/, 'the pane is placed beside the tree, not under it');
  assert.match(body[2], /kind {7}prompt/, 'and stays in step with the rows');
  // The pane is padded to the body height so the keybar cannot jump.
  assert.match(body[5], /│/, 'the border runs the full height');
  assert.match(lines.at(-1), /b branch/, 'the keybar spans the split, below it');
});

test('a row too wide for the left column is cut at the divider, not wrapped', () => {
  const width = 130;
  const detailWidth = 40;
  const leftW = width - detailWidth - 3;
  const lines = frame({
    header: 'H',
    rows: paneRows(),
    selectedLine: 0,
    offset: 0,
    height: 4,
    width,
    detail: [],
    detailWidth,
  });
  for (const l of lines.slice(1, 5)) {
    assert.equal(vlen(l.slice(0, l.indexOf('│'))), leftW + 1, 'left column is exactly leftW wide');
    assert.ok(!l.slice(0, l.indexOf('│')).includes('\n'));
    assert.ok(vlen(l) <= width, `${vlen(l)} > ${width}`);
  }
});

test('the selection tint stops at the divider', () => {
  // Verify §6, and the trap §3.3 calls out by name: `select(row.text, width)`
  // instead of `leftW` paints the border and the whole pane in the highlight.
  for (const depth of [8, 24]) {
    const pal = makePalette(depth);
    const lines = frame({
      header: 'H',
      rows: paneRows(),
      selectedLine: 0,
      offset: 0,
      height: 4,
      palette: pal,
      width: 130,
      detail: ['pane content here'],
      detailWidth: 40,
    });
    const selected = lines[1];
    const divider = selected.indexOf('│');
    const afterDivider = selected.slice(divider);
    assert.doesNotMatch(afterDivider, /\x1b\[48;/, `background bled past the divider at depth ${depth}`);
    assert.match(selected.slice(0, divider), /\x1b\[48;/, 'but the row itself is tinted');
    assert.equal(vlen(selected) <= 130, true);
  }
});

test('a coloured row cut mid-span does not bleed into the pane', () => {
  // The other trap: the closing reset lives past the cut, so a naive slice
  // leaves the span open and the tree's colour runs through the pane.
  const pal = makePalette(24);
  const lines = frame({
    header: 'H',
    rows: [{ text: pal.prompt('a very long cyan row that will certainly be cut'), uuid: 'a' }],
    selectedLine: -1,
    offset: 0,
    height: 1,
    palette: pal,
    width: 130,
    detail: ['pane'],
    detailWidth: 40,
  });
  const line = lines[1];
  const left = line.slice(0, line.indexOf('│'));
  assert.ok(left.includes('\x1b[0m'), 'the span the cut interrupted is closed before the divider');
});


// ── §3.4 geometry: the pane is refused, never squeezed ──────────────────────

test('the pane is refused below 120 columns', () => {
  // Verify §5. A 38-column pane beside a 50-column tree is two unusable columns
  // where there was one usable one, so the answer is no rather than smaller.
  for (const cols of [60, 80, 90, 119]) {
    const g = paneGeometry('pane', cols);
    assert.equal(g.pane, false, `${cols} columns should refuse`);
    assert.equal(g.detailWidth, 0);
    assert.equal(g.leftW, cols, 'and the tree gets the whole width');
  }
  for (const cols of [120, 130, 200]) {
    const g = paneGeometry('pane', cols);
    assert.equal(g.pane, true, `${cols} columns should allow`);
    assert.ok(g.detailWidth >= 38 && g.detailWidth <= 52, `pane ${g.detailWidth} out of bounds`);
    assert.equal(g.leftW, cols - g.detailWidth - 3, 'one space, one rule, one space');
    assert.ok(g.leftW > g.detailWidth, 'the tree keeps the majority of the screen');
  }
  // Off and line never produce a pane, however wide the terminal is.
  for (const mode of ['off', 'line']) {
    assert.equal(paneGeometry(mode, 300).pane, false);
    assert.equal(paneGeometry(mode, 300).detailWidth, 0);
  }
});

test('--once --pane opens the pane at 130 columns and refuses it at 90', () => {
  const wide = fakeOut(24, 130);
  runTui(loader, { once: true, select: '2', pane: true, out: wide, input: { isTTY: false } });
  assert.match(wide.buf, /│/, 'the divider is drawn');
  assert.match(wide.buf, /NODE {2}u2/, 'and the pane carries the fields');

  const narrow = fakeOut(24, 90);
  runTui(loader, { once: true, select: '2', pane: true, out: narrow, input: { isTTY: false } });
  assert.doesNotMatch(narrow.buf, /│ NODE/, 'no pane at 90 columns');
  assert.match(narrow.buf, /uuid u2/, 'it falls back to the one-line detail, not to nothing');
});

test('a resize across the boundary changes the frame with no keypress', () => {
  // Verify §5. The refusal is recomputed per frame rather than stored, which is
  // what makes `out.on("resize", draw)` enough on its own.
  const out = fakeOut(24, 90);
  const result = runTui(loader, { once: true, select: '2', pane: true, out, input: { isTTY: false } });
  assert.doesNotMatch(out.buf, /│ NODE/);
  assert.ok(result, 'and the narrow frame still rendered');

  // Same stored mode, wider terminal, pane returns.
  const wider = fakeOut(24, 130);
  runTui(loader, { once: true, select: '2', pane: true, out: wider, input: { isTTY: false } });
  assert.match(wider.buf, /│/);
});

test('with the pane open the tree is rendered to the left column, not cut to it', () => {
  // Rendering to the full width and cutting afterwards would push `← HEAD` off
  // the end of every row — the badge is right-aligned to the width it is given.
  const out = fakeOut(40, 130);
  runTui(loader, { once: true, select: '2', pane: true, out, input: { isTTY: false } });
  const head = out.buf.split('\n').find((l) => l.includes('← HEAD'));
  assert.ok(head, 'HEAD survives the split');
  assert.ok(head.indexOf('← HEAD') < head.indexOf('│'), 'and stays inside the tree column');
});

test('tab maps to layout, and nothing shows a pane unasked', () => {
  assert.equal(keyAction('\t'), 'layout');
  const out = fakeOut(24, 130);
  runTui(loader, { once: true, out, input: { isTTY: false } });
  assert.doesNotMatch(out.buf, /│ NODE/, 'a frame nobody asked detail of has none');
  assert.doesNotMatch(out.buf, /NODE {2}u/);
});


test('tab produces a pane from a cold start — the keybar promises one', () => {
  // Reported: pressing tab in the tree did nothing visible. It was doing what
  // §3.1 said — swap presentations, no-op when detail is off — while the keybar
  // that same section mandates reads `tab pane`. A key that is advertised and
  // does nothing is broken however it was specified.
  //
  // Driven through a real pty, because this is a keypress-to-screen claim and
  // the pure parts had it "right" the whole time.
  const project = tempProject();
  try {
    const cold = pty(project, '\tq', 130, project.parent);
    assert.match(cold, /│ kind/, 'one tab, from nothing showing, and there is a pane');

    const swapped = pty(project, '\t\tq', 130, project.parent);
    assert.doesNotMatch(swapped, /│ kind/, 'a second tab swaps it back down to the line');
    assert.match(swapped, /uuid \w/, 'and the line is what is left');

    const narrow = pty(project, '\tq', 100, project.parent);
    assert.doesNotMatch(narrow, /│ kind/, 'still refused below 120');
    assert.match(narrow, /the pane needs 120 columns/, 'but it says so rather than doing nothing');
  } finally {
    project.cleanup();
  }
});


// ── the picker's pane (mockup 2b) ───────────────────────────────────────────

test('the two views split the screen differently, because the panes differ', () => {
  // A node's detail is a field list and wants a narrow column. A conversation's
  // timeline is a TREE — lane art plus prompt text — so it takes the larger
  // half and the list narrows to make room.
  for (const cols of [130, 160, 198]) {
    const detail = paneGeometry('pane', cols, 'detail');
    const timeline = paneGeometry('pane', cols, 'timeline');
    assert.ok(timeline.detailWidth > detail.detailWidth, `timeline pane too narrow at ${cols}`);
    assert.ok(detail.leftW > detail.detailWidth, 'the tree keeps the majority of the screen');
    assert.ok(timeline.leftW >= 40, `the conversation list is unusable at ${cols}`);
    for (const g of [detail, timeline]) assert.equal(g.leftW + g.detailWidth + 3, cols, 'no lost columns');
  }
  // The 120-column refusal is the same for both.
  for (const kind of ['detail', 'timeline']) {
    assert.equal(paneGeometry('pane', 119, kind).pane, false);
    assert.equal(paneGeometry('pane', 119, kind).leftW, 119, 'and the list gets the whole width');
  }
});

test('timelinePanel is the tree renderer, aimed at a column', () => {
  // One renderer for the printed view, the tree view and the picker's pane, so
  // none of the three can drift from the others.
  const { graph } = loader();
  const lanes = assignLanes(graph);
  const lines = timelinePanel(graph, lanes, makePalette(0), 60, { file: '/p/0f0e0d0c-1b1a.jsonl' });
  assert.match(lines[0], /^TIMELINE {2}\d+ nodes/);
  assert.equal(lines[1], '0f0e0d0c-1b1a.jsonl', 'named by file, not by full path');
  assert.equal(lines[2], '');
  assert.ok(lines.some((l) => /#1/.test(l)), 'and the timeline itself follows');
  for (const l of lines) assert.ok(vlen(l) <= 60, `${vlen(l)} > 60: ${JSON.stringify(l)}`);

  assert.deepEqual(timelinePanel(graph, lanes, makePalette(0), 0), [], 'no column, no panel');
  assert.deepEqual(timelinePanel(null, lanes, makePalette(0), 40), []);
});

test('the picker docks a timeline, at every colour tier', () => {
  for (const depth of [0, 24]) {
    const out = fakeOut(30, 160);
    out.isTTY = false;
    runTui(loader, {
      once: true,
      view: 'sessions',
      pane: true,
      allFiles: [A],
      out,
      input: { isTTY: false },
      palette: makePalette(depth),
    });
    const plain = out.buf.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /│/, `no divider at depth ${depth}`);
    assert.match(plain, /TIMELINE {2}\d+ nodes/, 'the pane carries the selected conversation');
    for (const l of plain.split('\n')) assert.ok(vlen(l) <= 160, `row over width: ${JSON.stringify(l)}`);
  }
});


test('the picker pane shows the whole conversation, not just the file', () => {
  // Reported: the timeline docked beside a conversation drew only that
  // transcript, so a row the picker was ALREADY drawing as a tree — parent with
  // a branch under it — appeared in the pane as a straight line. The pane loads
  // the family, exactly as `enter` does.
  const project = tempProject();
  try {
    const frame = pty(project, '\tq', 170);
    const pane = frame
      .split('\n')
      .map((l) => (l.includes('│') ? l.slice(l.indexOf('│')) : ''))
      .join('\n');

    assert.match(pane, /TIMELINE/, 'the pane opened');
    assert.match(pane, /TRUNK continues here/, 'the trunk is there');
    assert.match(pane, /BRANCHED off here/, "and so is the branch's own prompt");
    assert.match(pane, /split after/, 'drawn as the fork it is');
    assert.match(pane, /\+1 more/, 'and it says the tree spans more than one transcript');
  } finally {
    project.cleanup();
  }
});
