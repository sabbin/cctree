// Connector geometry.
//
// Lanes are recycled once a tip dies, so a new arm can open in a column to the
// LEFT of the one it forked from. That shape only shows up in a merged
// multi-session view, which is why it survived until the picker was built.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseText } from '../src/parse.js';
import { buildGraph, annotate } from '../src/graph.js';
import { assignLanes } from '../src/lanes.js';
import { renderAscii, renderAsciiRows, renderHeader } from '../src/render-ascii.js';

const at = (m) => `2026-08-08T10:${String(m).padStart(2, '0')}:00.000Z`;
const node = (uuid, parentUuid, minute, role = 'user', text = `text for ${uuid}`, sessionId = 's1') =>
  JSON.stringify({
    uuid,
    parentUuid,
    type: role,
    sessionId,
    timestamp: at(minute),
    message: { role, content: text },
  });

/**
 * A leftward open — a lane recycled to the LEFT of the one it forks from.
 *
 * Depth-first order made this unreachable from a real transcript: an arm is
 * drawn whole before its siblings, and every lane to its left is held open for a
 * trunk child that has not been emitted yet, so `freeLane` can only ever hand
 * back a column to the RIGHT. The elbow logic stays because the geometry is
 * still wrong if it ever happens, and it is tested directly rather than through
 * a fixture that can no longer produce it.
 */
test('a lane opening to the left draws its elbow the right way round', () => {
  const { graph } = build([node('u1', null, 1), node('a1', 'u1', 2)].join('\n'));
  const lanes = {
    width: 3,
    rows: [
      { uuid: 'u1', lane: 2, through: [], opensFrom: null, closes: false, liveAfter: [2] },
      { uuid: 'a1', lane: 0, through: [2], opensFrom: 2, closes: true, liveAfter: [] },
    ],
  };
  const out = renderAscii(graph, lanes, { color: false });
  // The bug: `──├─`, an elbow pointing back the way the line came from.
  assert.ok(!out.includes('──├'), `elbow points the wrong way:\n${out}`);
  assert.ok(out.includes('┌─') || out.includes('┤'), `expected a leftward elbow:\n${out}`);
});

test('a lane opening to the right still draws the original shape', () => {
  const graph = annotate(
    buildGraph(parseText([node('u1', null, 1), node('c1', 'u1', 2), node('c2', 'u1', 3)].join('\n')).records),
  );
  const lanes = assignLanes(graph);
  const out = renderAscii(graph, lanes, { color: false });
  assert.ok(out.includes('├─'), `expected a rightward elbow:\n${out}`);
  assert.ok(out.includes('┐'), `expected the corner to close:\n${out}`);
});


// ── the #N gutter ───────────────────────────────────────────────────────────

/** A trunk of `n` prompts, each answered, so promptNo climbs past one digit. */
const trunk = (n) => {
  const lines = [];
  let parent = null;
  for (let i = 1; i <= n; i++) {
    lines.push(node(`u${i}`, parent, i * 2, 'user'));
    lines.push(node(`a${i}`, `u${i}`, i * 2 + 1, 'assistant'));
    parent = `a${i}`;
  }
  return lines.join('\n');
};

const build = (text) => {
  const graph = annotate(buildGraph(parseText(text).records));
  return { graph, lanes: assignLanes(graph) };
};

/**
 * Several transcripts merged — the shape `/branch` actually produces, where the
 * copy repeats its parent's records verbatim, uuids and all, in its own file.
 * A single file holding several sessionIds is not a thing Claude Code writes.
 */
const buildFiles = (files) => {
  const records = Object.entries(files).flatMap(([file, text]) => parseText(text, file).records);
  const graph = annotate(buildGraph(records));
  return { graph, lanes: assignLanes(graph) };
};

test('#N sits in a fixed gutter, whatever lane its node is in', () => {
  // The number used to be the first word of the label, so it started at a
  // different screen column for every lane depth and the numbers never lined up
  // with each other — which is the whole point of numbering them.
  const { graph, lanes } = build(fourLanes());
  assert.ok(lanes.width >= 2, 'the fixture really does use more than one lane');
  // Only node rows carry a gutter; the `split after #N` note is prose.
  const rows = renderAsciiRows(graph, lanes, { color: false }).filter((r) => r.uuid && /#\d/.test(r.text));
  const columns = rows.map((r) => r.text.indexOf('#'));
  assert.ok(rows.length >= 2, 'more than one numbered row to compare');
  assert.equal(new Set(columns).size, 1, `gutter ragged:\n${rows.map((r) => r.text).join('\n')}`);

  // And the lane art begins past the gutter on every row, numbered or not: the
  // gutter is a fixed cost, so lane 0 is always at the same column and every
  // other lane is a whole number of two-column cells right of it.
  const all = renderAsciiRows(graph, lanes, { color: false });
  const artAt = all.map((r) => r.text.search(/[●○◆◇⊙▪⋄│├┤┌┐─]/)).filter((i) => i >= 0);
  assert.equal(Math.min(...artAt), 5, 'lane 0 sits immediately past the gutter');
  assert.ok(artAt.every((i) => (i - 5) % 2 === 0), `lane art off its grid: ${artAt}`);
});

/**
 * Four lanes live at once. Under depth-first order that needs NESTING, not
 * siblings: an arm's column is freed as soon as its subtree is drawn, so four
 * branches off one node reuse one column, while a branch of a branch of a
 * branch stacks up. The trunk child is the latest at each level.
 */
const fourLanes = () => {
  const lines = [node('a', null, 1)];
  // Each level: one arm that departs, one trunk that keeps the column.
  lines.push(node('x1', 'a', 2), node('t1', 'a', 9));
  lines.push(node('x2', 'x1', 3), node('t2', 'x1', 8));
  lines.push(node('x3', 'x2', 4), node('t3', 'x2', 7));
  return lines.join('\n');
};

test('the #N gutter holds at one lane and at four', () => {
  // Verify §4. Lane art grows rightwards from a FIXED gutter, so the numbers
  // line up with each other no matter how wide the graph gets — which is the
  // entire reason for numbering them.
  for (const fixture of [trunk(3), fourLanes()]) {
    const { graph, lanes } = build(fixture);
    const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });
    const numbered = rows.filter((r) => r.uuid && /#\d/.test(r.text));
    assert.ok(numbered.length >= 3);
    assert.equal(new Set(numbered.map((r) => r.text.indexOf('#'))).size, 1, 'gutter ragged');
    // A fork note indents to the lane of the arm it belongs to, which is always
    // the row directly below it — for an arm that departs (note under its own
    // corner) and equally for one that kept its parent's column and so has no
    // corner at all. Same invariant either way.
    for (const [i, r] of rows.entries()) {
      if (!/split after/.test(r.text)) continue;
      const below = rows[i + 1];
      assert.ok(below?.uuid, 'a note always sits directly above the node it describes');
      assert.equal(
        r.text.indexOf('split'),
        below.text.search(/[●○◆◇⊙▪⋄⑂]/),
        `note not aligned with its arm: ${JSON.stringify([r.text, below.text])}`,
      );
    }
  }
  assert.ok(build(fourLanes()).lanes.width >= 4, 'the fixture really does open four lanes');
});

test('the gutter widens for a two-digit prompt number, and only then', () => {
  const narrow = build(trunk(9));
  const wide = build(trunk(12));
  const artOf = ({ graph, lanes }) =>
    renderAsciiRows(graph, lanes, { color: false })[0].text.search(/[●○◆◇]/);
  assert.equal(artOf(narrow), 5, 'selection column + "#9" + the two-space separator');
  assert.equal(artOf(wide), 6, 'one more digit, one more column, computed once for the whole render');

  const rows = renderAsciiRows(wide.graph, wide.lanes, { color: false }).filter(
    (r) => r.uuid && /#\d/.test(r.text),
  );
  assert.equal(new Set(rows.map((r) => r.text.indexOf('●'))).size, 1, '#9 and #12 still align');
});

test('a prompt and the reply beneath it are drawn joined', () => {
  // A bar before every row spent half the screen on `│` and flattened the tree
  // into one texture. The bar belongs BETWEEN turns, where it shows the lane
  // continuing — not inside one, where the rows are already one thing.
  const { graph, lanes } = build(trunk(3));
  const lines = renderAsciiRows(graph, lanes, { color: false }).map((r) => r.text);
  for (const [i, line] of lines.entries()) {
    if (!/#\d/.test(line)) continue;
    assert.ok(lines[i + 1] && /assistant/.test(lines[i + 1]), 'the reply follows its prompt directly');
  }
  const bars = lines.filter((l) => l.trim() === '│');
  assert.equal(bars.length, 2, 'one bar between each pair of turns, and none inside one');
});

test('the fork note gets its own row, indented to the lane it opens', () => {
  // Appended to the elbow it collided with the lane art of every column to the
  // right of it, and the deeper the fork the worse it read.
  const { graph, lanes } = build(
    [node('u1', null, 1), node('a1', 'u1', 2), node('u2', 'u1', 3), node('b1', 'u2', 4)].join('\n'),
  );
  const rows = renderAsciiRows(graph, lanes, { color: false });
  const elbow = rows.findIndex((r) => /[├┤]/.test(r.text));
  assert.ok(elbow >= 0, 'the fixture forks');
  assert.doesNotMatch(rows[elbow].text, /split after/, 'the elbow row carries art only');
  assert.match(rows[elbow + 1].text, /split after #\d/, 'and the note is the row below it');
  assert.equal(rows[elbow + 1].uuid, null, 'a note is not a node');
});

test('HEAD is marked by its glyph and a right-aligned badge, not a shouting row', () => {
  const { graph, lanes } = build(trunk(3));
  const rows = renderAsciiRows(graph, lanes, { color: true, width: 70 });
  const head = rows.find((r) => r.text.includes('◆'));
  assert.match(head.text, /\x1b\[32m◆\x1b\[0m/, 'the glyph says where you are');
  assert.doesNotMatch(head.text, /\x1b\[1m/, 'the row is not bold — that drowned every other signal');
  assert.match(head.text, /\x1b\[32m← HEAD\x1b\[0m$/, 'and the badge closes the line');

  const visible = head.text.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(visible.length, 70, 'right-aligned to the width it was given');

  // With no width there is nothing to align to, so it trails the label instead
  // of padding printed output out to a column nobody asked for.
  const printed = renderAsciiRows(graph, lanes, { color: false });
  assert.match(printed.find((r) => r.text.includes('◆')).text, /text for a3 ← HEAD$/);
});

test('no tree row is wider than the width it was given', () => {
  // The `(N sessions)` tail is spent from the same line budget the preview is;
  // appended after truncation it pushed a merged view past the terminal edge.
  const long = 'a prompt long enough to need truncating at any sane terminal width, and then some more';
  const text = [
    node('u1', null, 1, 'user', long),
    node('a1', 'u1', 2, 'assistant', long),
    node('u2', 'a1', 3, 'user', long),
    node('b1', 'u2', 4, 'assistant', long),
    node('b2', 'u2', 5, 'assistant', long),
  ].join('\n');
  const { graph, lanes } = build(text);
  // Two sessions carrying the same nodes is what puts a tail on every row.
  for (const n of graph.nodes.values()) n.sessions = new Set(['s1', 's2']);
  for (const width of [80, 100, 200]) {
    for (const r of renderAsciiRows(graph, lanes, { color: false, width })) {
      assert.ok(r.text.length <= width, `${r.text.length} > ${width}: ${JSON.stringify(r.text)}`);
    }
  }
});

test('renderHeader counts in the singular when there is one of something', () => {
  const { graph, lanes } = build(trunk(1));
  const head = renderHeader(graph, lanes);
  assert.match(head, /1 prompt · 1 lane · 1 tip\b/, 'no "1 lanes"');
  assert.doesNotMatch(head, /1 (nodes|prompts|lanes|tips)/);

  const many = build(trunk(3));
  assert.match(renderHeader(many.graph, many.lanes), /3 prompts · 1 lane · 1 tip\b/);
});


test('a placed fork reads as one, not as an abandoned tip', () => {
  // A fork stub is always a leaf, so `isTip` would claim it and draw `◇` —
  // "this arm stopped here", which is the least interesting true thing about a
  // file that has never been used. It gets the fork glyph and says it was
  // placed rather than recorded.
  const stub = {
    uuid: 'fork:s2',
    parentUuid: 'a1',
    type: 'fork',
    kind: 'fork',
    subkind: null,
    timestamp: Date.parse(at(3)),
    sessionId: 's2',
    preview: 'no prompt yet',
    file: '/p/fork.jsonl',
    line: 0,
    inferred: true,
    isSidechain: false,
    requestId: null,
    toolUseIds: null,
    toolResultFor: null,
    checkpoint: null,
  };
  const { records } = parseText([node('u1', null, 1), node('a1', 'u1', 2)].join('\n'));
  const graph = annotate(buildGraph([...records, stub]));
  const lanes = assignLanes(graph);
  const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });
  const row = rows.find((r) => r.uuid === 'fork:s2');
  assert.ok(row, 'the stub is laid out like any other node');
  assert.match(row.text, /⑂/, 'and carries the fork glyph, not the tip glyph');
  assert.match(row.text, /placed by creation time/, 'the inference is stated on the row');
  assert.doesNotMatch(row.text, /◇/);

  // Transplanted history is magenta everywhere — the same hue the picker badges
  // a fork with, so the two views agree about what the colour means.
  const colored = renderAsciiRows(graph, lanes, { color: true, width: 100 }).find((r) => r.uuid === 'fork:s2');
  assert.match(colored.text, /\x1b\[35m/);
});


test('both arms of a fork are labelled, including the one that kept the column', () => {
  // Reported: branching twice off the same prompt showed one arm departing and
  // the other looking like the trunk carrying on. The arm that keeps its
  // parent's column has diverged just as much — nothing about it moved, which
  // is exactly why the layout said nothing about it.
  //
  // Shape: A, B in the trunk; branch after B giving C; back to B, branch again
  // giving G. C is explored first, so G is the one that keeps the column.
  const text = [
    node('a', null, 1),
    node('b', 'a', 2),
    node('c', 'b', 3, 'user', 'first arm'),
    node('c2', 'c', 4, 'assistant'),
    node('g', 'b', 5, 'user', 'second arm'),
    node('g2', 'g', 6, 'assistant'),
  ].join('\n');
  const { graph, lanes } = build(text);
  assert.deepEqual(graph.splits, ['b'], 'one fork, two arms');

  const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });
  // Both arms say where they left, but they do not say the same thing: one
  // branched off, the other IS the conversation carrying on.
  const notes = rows.filter((r) => /split after|continues/.test(r.text));
  assert.equal(notes.length, 2, `both arms name where they diverged:\n${rows.map((r) => r.text).join('\n')}`);
  assert.equal(rows.filter((r) => /split after/.test(r.text)).length, 1, 'one departed');
  assert.equal(rows.filter((r) => /continues/.test(r.text)).length, 1, 'one carried on');

  // And the fork row says so itself, so the split is visible at the point you
  // look when you ask where it happened — not only at the arms.
  const forkRow = rows.find((r) => r.uuid === 'b');
  assert.match(forkRow.text, /\b2 arms\b/);
  assert.doesNotMatch(forkRow.text, /⑂/, 'that glyph means /fork, and nobody ran /fork here');

  // A node with one child says nothing.
  assert.doesNotMatch(rows.find((r) => r.uuid === 'a').text, /arms/);
});

test('the trunk child is drawn last, so it always needs its note', () => {
  // Under depth-first order every arm's subtree is drawn before the trunk
  // carries on, so the trunk child is never adjacent to its own parent. The
  // note is what restores the connection the layout cannot draw.
  const text = [
    node('a', null, 1),
    node('c', 'a', 3, 'user', 'the arm that departs'),
    node('c2', 'c', 4, 'assistant'),
    node('t', 'a', 5, 'user', 'the trunk carrying on'),
  ].join('\n');
  const { graph, lanes } = build(text);
  const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });

  const order = rows.filter((r) => r.uuid).map((r) => r.uuid);
  assert.ok(order.indexOf('c') < order.indexOf('t'), 'the arm is drawn before the trunk resumes');
  const tIdx = rows.findIndex((r) => r.uuid === 't');
  assert.match(rows[tIdx - 1].text, /continues/, 'and the trunk says where it left');
  assert.notEqual(rows[tIdx - 1].uuid, 'a', 'its parent is nowhere near it on screen');
});


test('in a merged view each arm names the session it is', () => {
  // An arm of a merged tree IS a session — you made it with `/branch` and it
  // has an id you can resume. Two unlabelled arms next to a list of three
  // sessions leaves you counting lanes to work out which is which.
  const shared = [node('a', null, 1, 'user', 'shared opening'), node('b', 'a', 2, 'user', 'shared second')];
  const { graph, lanes } = buildFiles({
    'aaaaaaaa-1111.jsonl': [...shared, node('c', 'b', 3, 'user', 'first branch')].join('\n'),
    'bbbbbbbb-2222.jsonl': [...shared, node('g', 'b', 4, 'user', 'second branch')].join('\n'),
  });
  assert.deepEqual(graph.splits, ['b'], 'the copied prefix dedupes and b forks');

  const notes = renderAsciiRows(graph, lanes, { color: false, width: 100 })
    .filter((r) => /split after|continues/.test(r.text))
    .map((r) => r.text);
  assert.equal(notes.length, 2);
  // The OLDER transcript is the trunk — a `/branch` copy is younger than what
  // it copied — so it carries on and the copy is the one drawn departing.
  assert.ok(notes.some((n) => /continues.*→ aaaaaaaa/.test(n)), `original not the trunk: ${notes}`);
  assert.ok(notes.some((n) => /split after.*→ bbbbbbbb/.test(n)), `copy not an arm: ${notes}`);
});

test('a single-file view says nothing about sessions', () => {
  // There is only one, so naming it on every note is noise.
  const text = [
    node('a', null, 1),
    node('b', 'a', 2, 'user', 'one arm'),
    node('c', 'a', 3, 'user', 'the other'),
  ].join('\n');
  const { graph, lanes } = build(text);
  for (const r of renderAsciiRows(graph, lanes, { color: false, width: 100 })) {
    assert.doesNotMatch(r.text, /→ s1/, `session named in a single-file view: ${r.text}`);
  }
});


test('a branch taken from the tip of a session is marked, though it forks nothing', () => {
  // Measured on a real four-session family: `/branch` from D, where D's session
  // never continued, produced a chain in which EVERY node has one child. There
  // is no fork to draw — the line simply changes transcript halfway down, and
  // the only evidence was `(2 sessions)` quietly becoming nothing.
  const shared = [node('a', null, 1, 'user', 'shared opening'), node('b', 'a', 2, 'user', 'shared second')];
  const { graph, lanes } = buildFiles({
    // The original stops at b. Nothing of its own follows.
    'aaaaaaaa-1111.jsonl': shared.join('\n'),
    'bbbbbbbb-2222.jsonl': [
      ...shared,
      node('m', 'b', 3, 'user', 'branched onwards'),
      node('n', 'm', 4, 'user', 'and further'),
    ].join('\n'),
  });
  assert.deepEqual(graph.splits, [], 'nothing forked — that is the whole point');

  const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });
  const idx = rows.findIndex((r) => r.uuid === 'm');
  assert.match(rows[idx - 1].text, /branched after #2 → bbbbbbbb/, 'the new transcript is named');
  assert.match(rows[idx - 1].text, /aaaaaaaa ends here/, 'and so is the one that stopped');
  assert.equal(rows[idx - 1].uuid, null, 'a boundary is not a node');
  assert.equal(rows.filter((r) => /branched after/.test(r.text)).length, 1, 'said once, where it happens');
});

test('a mix of records with and without a sessionId is still one transcript', () => {
  // Regression: `buildGraph` falls back to the FILE PATH when a record carries
  // no `sessionId`, so a single transcript holding both looked like two
  // sessions and announced a boundary that does not exist — naming half a path
  // where a session id belongs. Caught by the fixture snapshot, not by a test.
  const withSession = node('a', null, 1, 'user', 'has one', 's1');
  const without = JSON.stringify({
    uuid: 'b',
    parentUuid: 'a',
    type: 'user',
    timestamp: at(2),
    message: { role: 'user', content: 'no sessionId at all' },
  });
  const { graph, lanes } = build([withSession, without].join('\n'));
  for (const r of renderAsciiRows(graph, lanes, { color: false, width: 100 })) {
    assert.doesNotMatch(r.text, /branched after/, `phantom boundary: ${r.text}`);
    assert.doesNotMatch(r.text, /→ \//, 'and never a file path where a session id goes');
  }
});

test('a split names its arms and says nothing about boundaries', () => {
  // Both mechanisms describe the same event when they coincide; a node with
  // several children already names each arm's session, so a boundary note there
  // would say it twice.
  const text = [
    node('a', null, 1, 'user', 'shared', 's1'),
    node('c', 'a', 2, 'user', 'one arm', 's2'),
    node('g', 'a', 3, 'user', 'other arm', 's3'),
  ].join('\n');
  const { graph, lanes } = build(text);
  const rows = renderAsciiRows(graph, lanes, { color: false, width: 100 });
  assert.equal(rows.filter((r) => /branched after/.test(r.text)).length, 0, 'no boundary at a split');
  assert.equal(
    rows.filter((r) => /split after|continues/.test(r.text)).length,
    2,
    'the arms carry it instead',
  );
});

test('a single-transcript view has no boundaries to mark', () => {
  const text = [node('a', null, 1), node('b', 'a', 2), node('c', 'b', 3)].join('\n');
  const { graph, lanes } = build(text);
  for (const r of renderAsciiRows(graph, lanes, { color: false, width: 100 })) {
    assert.doesNotMatch(r.text, /branched after/);
  }
});
