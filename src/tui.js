// Phase 3 — the companion TUI.
//
// Zero dependencies and no build step, deliberately. `bin/` lands on PATH the
// moment the plugin is enabled, and anything requiring `npm install` or a dist/
// would break that — a stale dist/ can lie to you, and a plugin symlinked from a
// working copy has no node_modules at all.
//
// The pure parts (key mapping, scroll maths, frame composition) are exported
// separately from the I/O loop so they can be tested without a terminal. The
// loop itself is the only part that touches stdin, the screen, or the clock.

import { readFileSync, statSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

import { renderAsciiRows, renderHeader, ancestorPrompt } from './render-ascii.js';
import { assignLanes } from './lanes.js';
import { planBranch, buildBranchText } from './branch.js';
import { describeSessions, renderSessionRows, familyFiles } from './session-list.js';
import { readAliases, setAlias } from './store.js';
import { colorDepth, makePalette, PLAIN, vlen, vtrunc, wrap } from './palette.js';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_OFF = '\x1b[?25l';
const CURSOR_ON = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

// The key tables. Deliberately unchanged from what the TUI has always had — the
// mockups showed a command palette and a graft key, and neither exists.
const TREE_KEYS = [
  ['↑↓/jk', 'move'],
  ['enter', 'detail'],
  ['b', 'branch'],
  ['o', 'open'],
  ['f', 'family'],
  ['tab', 'pane'],
  ['q', 'quit'],
];
const PICKER_KEYS = [
  ['↑↓/jk', 'move'],
  ['enter', 'open'],
  ['o', 'resume'],
  ['n', 'name'],
  ['a', 'merge all'],
  ['tab', 'timeline'],
  ['q', 'quit'],
];

/**
 * The key hint line: keys at normal brightness, what they do dimmed.
 *
 * Separated by spaces rather than `·` — the dots read as content when the labels
 * beside them are already dim, and the bar is the one line you scan past.
 */
export function keybar(keys, pal) {
  return keys.map(([key, what]) => `${key} ${pal.machine(what)}`).join('   ');
}

/**
 * Split one stdin chunk into individual keypresses. Pure.
 *
 * stdin delivers bytes, not keys: fast typing, key repeat, a paste, or anything
 * driving the TUI through a pipe can coalesce several keypresses into a single
 * chunk. Matching the whole chunk against a key table silently drops every one
 * of them — including `q`, which makes the TUI unquittable. Found by driving it
 * through a pty, where `jjjq` arrives as one string.
 */
export function splitKeys(chunk) {
  const keys = [];
  const s = String(chunk);
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      // CSI sequence: ESC [ params final. Anything else is a bare ESC.
      const m = /^\x1b\[[0-9;?]*[~a-zA-Z]/.exec(s.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    keys.push(s[i]);
    i += 1;
  }
  return keys;
}

/**
 * Map a single keypress to an action. Pure.
 *
 * Arrow keys arrive as escape sequences, and a bare ESC must not be mistaken for
 * one — so the multi-byte forms are matched before the single-character ones.
 */
export function keyAction(key) {
  switch (key) {
    case '\x1b[A':
      return 'up';
    case '\x1b[B':
      return 'down';
    case '\x1b[5~':
      return 'pageUp';
    case '\x1b[6~':
      return 'pageDown';
    case '\x03': // Ctrl-C
    case 'q':
      return 'quit';
    case 'k':
      return 'up';
    case 'j':
      return 'down';
    case 'g':
      return 'top';
    case 'G':
      return 'bottom';
    case 'b':
      return 'branch';
    case 'o':
      return 'open';
    case 'r':
      return 'refresh';
    // Widen the tree to the whole conversation — its branches and its forks —
    // or narrow it back to the one arm.
    case 'f':
      return 'family';
    // Swap how the detail is presented. Single-byte and otherwise unused, so
    // `splitKeys` needs nothing new to deliver it.
    case '\t':
      return 'layout';
    case 'y':
      return 'yes';
    // `n` renames. During a branch confirmation anything that is not `yes`
    // cancels, so it still reads as "no" in the only place that asked.
    case 'n':
      return 'rename';
    case '\r':
    case '\n':
      return 'detail';
    case 'a':
      return 'all';
    // Going back out of a session. A bare ESC still must not be mistaken for the
    // start of an arrow sequence — splitKeys has already decided that question.
    case '\x1b':
    case 'h':
    case '\x1b[D':
      return 'back';
    default:
      return null;
  }
}

/**
 * Scroll offset that keeps `selectedLine` on screen, clamped to the content.
 * Pure. Returns the offset to use, which may be the one passed in.
 */
export function clampOffset({ selectedLine, offset, height, total }) {
  if (height <= 0) return 0;
  const maxOffset = Math.max(0, total - height);
  let next = Math.min(offset, maxOffset);
  if (selectedLine < next) next = selectedLine;
  else if (selectedLine >= next + height) next = selectedLine - height + 1;
  return Math.max(0, Math.min(next, maxOffset));
}

/**
 * Compose the visible screen. Pure: takes already-rendered rows and returns the
 * lines to print, so the frame can be asserted in a test with no terminal.
 */
export function frame({
  header,
  rows,
  selectedLine,
  offset,
  height,
  status = '',
  help = true,
  keys = TREE_KEYS,
  palette = PLAIN,
  width = 0,
  detail = [],
  detailWidth = 0,
}) {
  const out = [];
  for (const line of header.split('\n')) out.push(line);

  const body = rows.slice(offset, offset + height);
  // The header spans the full width above the split and the keybar spans it
  // below; only the body is two columns. `detailWidth === 0` is the whole of
  // today's behaviour, kept as its own branch so it stays byte-identical.
  const leftW = detailWidth ? width - detailWidth - DIVIDER_W : 0;

  for (let i = 0; i < height; i++) {
    const row = body[i];
    const isSelected = row && offset + i === selectedLine;
    // A background tint, not reverse video. Reverse flattens every colour in the
    // row, which throws away exactly the distinctions the picker exists to draw;
    // the tint keeps them all legible. `palette.select` is also what knows to
    // re-open the background after each inner reset — a row is built from spans
    // and every span closes with one, which is why a naive wrap looks patchy.
    if (!detailWidth) {
      if (!row) out.push(''); // pad so the footer does not jump as the viewport shortens
      else out.push(isSelected ? palette.select(row.text, width) : row.text);
      continue;
    }
    // Padded to the column BEFORE the tint, because `select` only pads where it
    // has a background to paint: at the 16-colour tier it degrades to bold and
    // pads nothing, which would leave the divider ragged on the selected row.
    const cut = padTo(vtrunc(row?.text ?? '', leftW), leftW);
    const left = isSelected ? palette.select(cut, leftW) : cut;
    // `select(row.text, width)` here instead of `leftW` is the single most
    // likely bug in the split view: the tint paints straight through the border
    // and across the pane.
    out.push(`${left}${palette.faint(DIVIDER)}${vtrunc(detail[i] ?? '', detailWidth)}`);
  }

  if (status) out.push(status);
  else if (help) {
    const scroll =
      rows.length > height ? `   ${offset + 1}-${Math.min(offset + height, rows.length)}/${rows.length}` : '';
    out.push(keybar(keys, palette) + palette.machine(scroll));
  }
  return out;
}

/**
 * Resolve a `--select` argument to an index into the selectable rows. Pure.
 *
 * Accepts a prompt number (`4`, `#4`) or a uuid prefix, because those are the
 * two things a human or an agent has in hand after reading a frame. Returns -1
 * when nothing matches, which the caller reports rather than silently ignoring.
 */
export function resolveSelection(graph, rows, selectable, select) {
  if (select == null || select === '') return -1;
  const wanted = String(select).replace(/^#/, '');
  const asNumber = Number(wanted);

  for (const [i, line] of selectable.entries()) {
    const node = graph.nodes.get(rows[line].uuid);
    if (!node) continue;
    if (Number.isInteger(asNumber) && asNumber > 0 && node.promptNo === asNumber) return i;
    if (!Number.isInteger(asNumber) && node.uuid.startsWith(wanted)) return i;
  }
  return -1;
}

/**
 * Which session `o` should open. Pure.
 *
 * A branch made in this run wins: you almost certainly want to enter the thing
 * you just created. Otherwise it is the session the selected node came from,
 * which makes `o` mean "open whatever is under the cursor" and turns the graph
 * into a way of moving between existing arms, not only new ones.
 */
export function resolveOpenTarget({ lastBranchId = null, node = null } = {}) {
  if (lastBranchId) return { id: lastBranchId, reason: 'the branch you just made' };
  const id = node?.record?.sessionId ?? null;
  if (id) return { id, reason: 'the session this node belongs to' };
  return { id: null, reason: 'nothing to open — select a node, or branch first with b' };
}

/**
 * When a transcript was first written. Not every filesystem records a birth
 * time; 0 means "unknown", and the picker then declines to claim a direction
 * rather than inventing one.
 */
function birthOf(file) {
  try {
    const st = statSync(file);
    return st.birthtimeMs > 0 ? st.birthtimeMs : 0;
  } catch {
    return 0;
  }
}

/** Width of the pane's label gutter. Labels right of it, values left-aligned. */
const LABEL_W = 11;

/** The split view's border: one space, one rule, one space. */
const DIVIDER = ' │ ';
const DIVIDER_W = 3;

/**
 * Narrower than this and the pane is REFUSED, not squeezed.
 *
 * A 38-column pane beside a 50-column tree is two unusable columns instead of
 * one usable one. The refusal is recomputed every frame rather than stored, so
 * widening the window brings the pane back with no keypress.
 */
const PANE_MIN_COLS = 120;

/**
 * How the two views split the screen, and they do not split it the same way.
 *
 * A node's detail is a field list: it wants a narrow column and the tree keeps
 * the majority. A conversation's timeline is a TREE — lane art plus prompt text
 * — so it needs the larger half, and the conversation list narrows to make room.
 */
const PANE_SHAPE = {
  detail: { leftShare: 0.58, min: 38, max: 52 },
  timeline: { leftShare: 0.45, min: 44, max: 96 },
};

/**
 * How wide the pane is, and whether there is one at all. Pure.
 *
 * @param {'off'|'line'|'pane'} detailMode
 * @param {number} cols
 * @param {'detail'|'timeline'} kind which view is asking
 * @returns {{pane: boolean, detailWidth: number, leftW: number}}
 */
export function paneGeometry(detailMode, cols, kind = 'detail') {
  const shape = PANE_SHAPE[kind] ?? PANE_SHAPE.detail;
  const pane = detailMode === 'pane' && cols >= PANE_MIN_COLS;
  const detailWidth = pane
    ? Math.max(shape.min, Math.min(shape.max, cols - Math.floor(cols * shape.leftShare)))
    : 0;
  return { pane, detailWidth, leftW: pane ? cols - detailWidth - DIVIDER_W : cols };
}

/**
 * One conversation's timeline, for the picker's pane. Pure.
 *
 * The same `renderAsciiRows` the tree view uses, rendered to the pane's width
 * rather than the screen's — one renderer for the printed view, the tree view
 * and this, so none of the three can drift from the others.
 */
export function timelinePanel(graph, lanes, pal = PLAIN, width = 40, { file = '', sessions = 1 } = {}) {
  if (!graph || width <= 0) return [];
  const counts = renderHeader(graph, lanes, {}).split('\n')[0];
  const out = [pal.machine(vtrunc(`TIMELINE  ${counts}`, width))];
  // Named by the conversation this row is, plus how many transcripts that is —
  // otherwise a tree with two arms in it looks like it came from one file.
  if (file) {
    const label = sessions > 1 ? `${basename(file)}  +${sessions - 1} more` : basename(file);
    out.push(pal.faint(vtrunc(label, width)));
  }
  out.push('');
  for (const row of renderAsciiRows(graph, lanes, { palette: pal, width })) out.push(row.text);
  return out;
}

/** Pad to `w` by VISIBLE width. Never `.padEnd` — that counts escape bytes. */
const padTo = (text, w) => `${text}${' '.repeat(Math.max(0, w - vlen(text)))}`;

/** Cut to `n` visible columns with an ellipsis, for prose inside one field. */
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return vlen(t) > n ? `${vtrunc(t, n - 1)}…` : t;
};

/**
 * What there is to say about one node. Pure.
 *
 * ONE list, read by both presentations: `detailOf` joins the `inline` forms into
 * a single line, `detailLines` lays the same fields out down a pane. Two lists
 * would drift the moment a field was added to whichever one was in front of you.
 *
 * @returns {{label: string, value: string, inline: string, tone?: string}[]}
 */
function detailFields(node, graph = null) {
  if (!node) return [];
  const when = node.timestamp
    ? new Date(node.timestamp).toISOString().replace('T', ' ').slice(0, 19)
    : 'no timestamp';
  const kind =
    `${node.kind}${node.subkind ? `/${node.subkind}` : ''}` +
    `${node.promptNo ? `  #${node.promptNo}` : ''}` +
    `${node.collapsedInto ? `  collapsed ${node.collapsedInto}` : ''}`;

  // Which sessions carry this node. For a `/branch` copy that is the whole
  // point of deduping by uuid, so the ids are worth the columns.
  const ids = [...node.sessions].map((id) => String(id).slice(0, 8));
  const count = `${ids.length} session${ids.length === 1 ? '' : 's'}`;

  const fields = [
    { label: 'kind', value: kind, inline: kind },
    { label: 'uuid', value: node.uuid, inline: `uuid ${node.uuid}` },
    { label: 'when', value: when, inline: when },
    {
      label: 'sessions',
      value: ids.length > 1 ? `${count} · ${ids.join(', ')}` : count,
      inline: count,
    },
  ];

  // What `b` would branch from. A prompt IS its own cut point — `b` branches
  // BEFORE the selected prompt — so it names itself; anything else names the
  // prompt you would have to move up to first.
  const anchor = node.kind === 'prompt' ? node : graph ? ancestorPrompt(graph.nodes, node) : null;
  if (anchor?.promptNo) {
    // Truncated: the full text is the `preview` block below, and repeating it
    // here costs the pane four lines to say the same thing twice.
    const value = `#${anchor.promptNo} ${clip(anchor.preview, 48)}`;
    fields.push({ label: 'rewind to', value, inline: `rewind to #${anchor.promptNo}`, tone: 'branch' });
  }
  return fields;
}

/** The detail block for one node, as one line. Pure. The narrow-terminal path. */
export function detailOf(node, pal = PLAIN, graph = null) {
  if (!node) return '';
  return pal.machine(detailFields(node, graph).map((f) => f.inline).join(' · '));
}

/**
 * The same fields, laid down a pane of `width` columns. Pure.
 *
 * Returns already-rendered lines — `frame()` never formats a field, it only
 * places what it is given, which is what keeps it a layout function.
 */
export function detailLines(node, graph = null, pal = PLAIN, width = 40) {
  if (!node || width <= 0) return [];
  const valueW = Math.max(8, width - LABEL_W);
  const out = [];

  // Title, treated like §1's column header: dim, uppercase, naming the thing.
  out.push(pal.machine(vtrunc(`NODE  ${node.uuid.slice(0, 8)}`, width)));
  out.push('');

  for (const field of detailFields(node, graph)) {
    const tone = field.tone === 'branch' ? pal.branch : (s) => s;
    // The value is wrapped PLAIN and painted afterwards: wrapping a painted
    // string would leave each line holding half of somebody's escape pair.
    const lines = wrap(field.value, valueW);
    for (const [i, line] of lines.entries()) {
      const label = i === 0 ? field.label : '';
      out.push(`${pal.faint(padTo(label, LABEL_W))}${tone(line)}`);
    }
    if (!lines.length) out.push(pal.faint(padTo(field.label, LABEL_W)));
  }

  // The one multi-line field, and the only one worth a separator.
  const preview = wrap(node.preview ?? '', width).slice(0, 4);
  if (preview.length) {
    out.push('');
    for (const line of preview) out.push(pal.machine(line));
  }
  return out;
}


/**
 * Interactive loop. The only part that touches the terminal.
 *
 * Two views, because a merged tree stops being readable once a project has a
 * few branches: `sessions` lists the conversations, `tree` shows one of them.
 * Both are the same machinery — a list of rows, each optionally tagged with the
 * thing it represents — so selection, scrolling and drawing are written once.
 *
 * @param {(files: string[]) => {graph: object, title: string, recordsByFile: Map}} load
 */
export function runTui(
  load,
  {
    once = false,
    select = null,
    emit = null,
    view = 'tree',
    pane = false,
    files = null,
    allFiles = null,
    out = process.stdout,
    input = process.stdin,
  } = {},
) {
  const everyFile = allFiles ?? files ?? null;
  /**
   * How wide the screen is. A pipe has no width; asking for the pane is the
   * caller asserting they have somewhere to put it, so that case gets a width
   * that fits one. Everything else gets the print default.
   */
  const columnsOf = () => out.columns || (pane ? PANE_MIN_COLS + 10 : 100);
  // Asked once, at the boundary, against the stream actually being written to —
  // `--once` into a pipe is not a terminal and gets no escapes at all.
  const palette = makePalette(colorDepth(process.env, out));
  let mode = view;
  let treeFiles = files ?? everyFile;

  let state = null; // tree view
  let lanes = null;
  let sessions = []; // picker view
  let rows = [];
  let selectable = [];
  let cursor = 0;
  let offset = 0;
  let status = '';
  let pendingBranch = null;
  let renaming = null;
  // 'off' | 'line' | 'pane'. One enum rather than a boolean plus a layout flag,
  // so there is no state where detail is on and nothing knows how to draw it.
  let detailMode = pane ? 'pane' : 'off';
  // Which arm the tree is focused on, and whether its relatives are shown with
  // it. A conversation is usually several files — a `/branch` is a copy, a
  // `/fork` is a sibling — and opening one file draws a straight line through
  // what is really a tree. So entering shows the family, and `f` narrows.
  let treeFocusFile = files?.length === 1 ? files[0] : null;
  let showFamily = true;
  const branched = [];
  let lastBranchId = null;

  const keyOf = (row) => row.uuid ?? row.id ?? null;
  const reindex = () => {
    selectable = rows.map((r, i) => (keyOf(r) ? i : -1)).filter((i) => i >= 0);
    if (cursor >= selectable.length) cursor = Math.max(0, selectable.length - 1);
  };

  /** Describe every session in the project. Needed by the picker AND by `f`. */
  // One graph per session file, built on demand for the picker's pane and thrown
  // away whenever the transcripts are re-read. Keyed by file, so moving the
  // cursor back to a conversation you have already looked at costs nothing.
  const timelines = new Map();

  const timelineFor = (session, width) => {
    if (!session) return [];
    let built = timelines.get(session.file);
    if (!built) {
      // The FAMILY, not the one file — the same list `enter` would open. A
      // conversation is usually several transcripts: a `/branch` is a copy and a
      // `/fork` is a sibling, and loading only this file draws a straight line
      // through what the row immediately above it is already showing as a tree.
      const family = familyFiles(sessions.length ? sessions : describeAll(), session.file);
      const loaded = load(family?.length ? family : [session.file]);
      built = { graph: loaded.graph, lanes: assignLanes(loaded.graph), count: family?.length ?? 1 };
      timelines.set(session.file, built);
    }
    return timelinePanel(built.graph, built.lanes, palette, width, {
      file: session.file,
      sessions: built.count,
    });
  };

  const describeAll = () => {
    timelines.clear();
    const s = load(everyFile);
    const entries = [...s.recordsByFile.entries()].map(([file, records]) => ({
      id: basename(file, '.jsonl'),
      file,
      records,
      // Only the filesystem knows which session was created first: a branch's
      // records are verbatim copies and carry the original timestamps.
      createdAt: birthOf(file),
    }));
    sessions = describeSessions(entries, { now: Date.now(), aliases: readAliases() });
    return sessions;
  };

  const loadSessions = () => {
    describeAll();
    render();
  };

  /** Point `treeFiles` at either the focused arm or its whole family. */
  const applyTreeFiles = () => {
    if (!treeFocusFile) return;
    // Described on demand: arriving straight in tree view (`cctree tui <id>`)
    // never builds a picker, and `f` still has to know what the family is.
    const family = showFamily ? familyFiles(sessions.length ? sessions : describeAll(), treeFocusFile) : null;
    treeFiles = family && family.length > 1 ? family : [treeFocusFile];
  };

  const loadTree = () => {
    state = load(treeFiles);
    lanes = assignLanes(state.graph);
    render();
  };

  /**
   * Rebuild the visible rows from data already loaded.
   *
   * Separate from loading because the rows now depend on the CURSOR: the `▸` in
   * the gutter is the selection signal at every colour depth, and with no colour
   * at all it is the only one there is. Rendering is pure string building over a
   * few hundred rows, so it is cheap to redo per frame; reading the transcripts
   * is not, and stays in the two loaders.
   *
   * Rendered twice because selection is an INDEX and the marker needs an ID:
   * the first pass is what turns one into the other. Adding a marker changes
   * neither the row count nor which rows are selectable, so the index survives.
   */
  const render = (w = columnsOf()) => {
    // The renderer is given the width of the column it will actually occupy —
    // the LEFT column when the pane is open. Rendering to the full width and
    // cutting afterwards would push `← HEAD` off the end of every tree row.
    const build = (sel) =>
      mode === 'sessions'
        ? renderSessionRows(sessions, { palette, width: w, selected: sel })
        : renderAsciiRows(state.graph, lanes, { palette, width: w, selected: sel });
    rows = build(null);
    reindex();
    const line = selectable[cursor];
    const key = line == null ? null : keyOf(rows[line]);
    if (key) {
      rows = build(key);
      reindex();
    }
  };

  const rebuild = () => (mode === 'sessions' ? loadSessions() : loadTree());

  const selectedNode = () => {
    if (mode !== 'tree') return null;
    const line = selectable[cursor];
    const uuid = line == null ? null : rows[line]?.uuid;
    return uuid ? state.graph.nodes.get(uuid) : null;
  };
  const selectedSession = () => {
    if (mode !== 'sessions') return null;
    const line = selectable[cursor];
    const id = line == null ? null : rows[line]?.id;
    return id ? sessions.find((s) => s.id === id) : null;
  };

  /** Jump the cursor to HEAD — where the conversation actually is. */
  const cursorToHead = () => {
    const headLine = rows.findIndex((r) => r.uuid && state.graph.nodes.get(r.uuid)?.isHead);
    const at = selectable.indexOf(headLine);
    cursor = at >= 0 ? at : 0;
    offset = 0;
  };

  const enterSession = (session) => {
    if (!session) return;
    treeFocusFile = session.file;
    showFamily = true;
    applyTreeFiles();
    mode = 'tree';
    status = '';
    // The pane persists across the two views. §3.1 reset it to 'off' here, but
    // that was written when only the tree had one: closing a pane the user
    // opened, because they navigated, is the surprise — not keeping it.
    loadTree();
    cursorToHead();
    const others = treeFiles.length - 1;
    if (others) {
      status = palette.machine(
        `showing this conversation and its ${others} branch${others === 1 ? '' : 'es'} · f for this arm alone`,
      );
    }
  };

  const header = () => {
    if (mode === 'sessions') {
      const total = sessions.length;
      const related = sessions.filter((s) => s.shares.length).length;
      // The count line only. The hint that used to sit under it put prose
      // between the reader and the data; it is the keybar now, at the bottom.
      return `${total} conversation${total === 1 ? '' : 's'}${related ? ` · ${related} share history` : ''}`;
    }
    return renderHeader(state.graph, lanes, { file: state.title });
  };

  /** What the pane holds, decided by which view is open. */
  const paneFor = (width) =>
    mode === 'sessions'
      ? timelineFor(selectedSession(), width)
      : detailLines(selectedNode(), state.graph, palette, width);

  const keysFor = () => {
    if (mode === 'sessions') return PICKER_KEYS;
    // The label names what the key will DO, not what is on screen — a toggle
    // whose caption describes the current state reads backwards.
    return TREE_KEYS.map(([k, what]) =>
      k === 'f' ? [k, treeFocusFile && showFamily ? 'this arm' : 'family'] : [k, what],
    );
  };

  const draw = () => {
    const cols = columnsOf();
    // Geometry first: the tree has to be RENDERED to the column it will occupy,
    // not cut down to it afterwards. Recomputed every frame, so a resize across
    // the 120-column boundary takes effect on the next draw with no keypress.
    // Both views dock a pane; what goes in it is what differs. The tree shows one
    // node's fields, the picker shows the selected conversation's timeline.
    const kind = mode === 'sessions' ? 'timeline' : 'detail';
    const { pane: showPane, detailWidth, leftW } = paneGeometry(detailMode, cols, kind);
    render(leftW);

    const head = header();
    // Too narrow for a pane falls back to the one-line footer for THIS frame —
    // `detailMode` is left alone, so widening the window restores the pane. The
    // picker has no one-line form; a conversation is not one line.
    const line = mode === 'tree' && detailMode !== 'off' && !showPane
      ? detailOf(selectedNode(), palette, state.graph)
      : '';
    const chrome = head.split('\n').length + 1 + (line ? 1 : 0);
    const height = Math.max(1, (out.rows || 24) - chrome);
    const selectedLine = selectable[cursor] ?? 0;
    // The pane never scrolls and never affects the height: clamping is still
    // the tree's row count against the tree's viewport.
    offset = clampOffset({ selectedLine, offset, height, total: rows.length });
    const lines = frame({
      header: head,
      rows,
      selectedLine,
      offset,
      height,
      status,
      keys: keysFor(),
      palette,
      width: cols,
      detail: showPane ? paneFor(detailWidth) : [],
      detailWidth,
    });
    if (line) lines.push(line);
    out.write(CLEAR + lines.join('\n'));
  };

  rebuild();
  if (mode === 'tree') cursorToHead();

  // `--select` aims the frame at a node without the interactive loop. That is
  // what makes the graph navigable from inside a chat.
  if (select != null && mode === 'tree') {
    const found = resolveSelection(state.graph, rows, selectable, select);
    if (found < 0) status = `${palette.machine(`no node matching "${select}"`)}`;
    else {
      cursor = found;
      // An agent reading one frame wants the fields, not a truncated line — so
      // the pane when there is room for one, and the line when there is not.
      if (detailMode !== 'pane') detailMode = (out.columns || 0) >= PANE_MIN_COLS ? 'pane' : 'line';
    }
  }

  // One frame, no raw mode, no alt screen — used by `--once` and by tests.
  if (once) {
    const cols = columnsOf();
    const kind = mode === 'sessions' ? 'timeline' : 'detail';
    const { pane: showPane, detailWidth, leftW } = paneGeometry(detailMode, cols, kind);
    render(leftW);
    const head = header();
    const selectedLine = selectable[cursor] ?? 0;
    const lines = frame({
      header: head,
      rows,
      selectedLine,
      offset: 0,
      height: rows.length,
      status,
      help: mode === 'tree',
      keys: keysFor(),
      palette,
      width: cols,
      detail: showPane ? paneFor(detailWidth) : [],
      detailWidth,
    });
    if (mode === 'tree' && detailMode !== 'off' && !showPane) {
      lines.push(detailOf(selectedNode(), palette, state.graph));
    }
    out.write(lines.join('\n') + '\n');
    return { branched, selected: selectedNode()?.uuid ?? selectedSession()?.id ?? null, mode };
  }

  if (!input.isTTY || !out.isTTY) {
    throw new Error('cctree tui needs a terminal (try `cctree tui --once`, or `cctree show`)');
  }

  let closed = false;
  const restore = () => {
    if (closed) return;
    closed = true;
    try {
      input.setRawMode(false);
    } catch {
      /* already gone */
    }
    input.pause();
    out.write(CURSOR_ON + ALT_OFF);
    // Branches outlive the screen: print their resume commands into scrollback.
    for (const b of branched) out.write(`branched before #${b.at} -> claude -r ${b.id}\n`);
  };
  // A TUI that dies without restoring leaves the caller staring at a raw-mode
  // alternate screen with no cursor. `exit` alone does not cover being killed.
  process.on('exit', restore);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      restore();
      process.exit(0);
    });
  }
  process.on('uncaughtException', (err) => {
    restore();
    throw err;
  });

  const doBranch = () => {
    const node = selectedNode();
    if (!node || node.kind !== 'prompt') {
      status = `${palette.machine(`select a prompt (●) to branch from`)}`;
      return;
    }
    const file = node.record?.file;
    const records = state.recordsByFile?.get(file);
    if (!file || !records) {
      status = `${palette.machine(`cannot locate the source transcript for that node`)}`;
      return;
    }
    const plan = planBranch(records, node.promptNo);
    if (!plan.ok) {
      status = `${palette.machine(`${plan.reason}`)}`;
      return;
    }
    const id = randomUUID();
    const dest = join(dirname(file), `${id}.jsonl`);
    if (existsSync(dest)) {
      status = `${palette.machine(`refusing to overwrite ${dest}`)}`;
      return;
    }
    const { text } = buildBranchText(readFileSync(file, 'utf8'), {
      cutLine: plan.cutLine,
      newSessionId: id,
    });
    if (!text) {
      status = `${palette.machine(`branch would be empty`)}`;
      return;
    }
    writeFileSync(dest, text);
    branched.push({ at: node.promptNo, id });
    lastBranchId = id;
    status = emit
      ? `${palette.select(`branched before #${node.promptNo} — press o to open it`)}`
      : `${palette.machine(`branched before #${node.promptNo} · claude -r ${id}`)}`;
    rebuild();
  };

  // Handing the id back to a shell wrapper, which then execs `claude -r`. It
  // goes through a file rather than stdout because stdout is the screen — a
  // caller capturing it would get the whole ANSI frame along with the id.
  const doOpen = () => {
    const fromList = selectedSession();
    const target = fromList
      ? { id: fromList.id, reason: 'the selected conversation' }
      : resolveOpenTarget({ lastBranchId, node: selectedNode() });
    if (!target.id) {
      status = `${palette.machine(`${target.reason}`)}`;
      return;
    }
    if (!emit) {
      status = `${palette.machine(`claude -r ${target.id}   (run cctree-go to do this in one key)`)}`;
      return;
    }
    writeFileSync(emit, `${target.id}\n`);
    restore();
    process.exit(0);
  };

  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  out.write(ALT_ON + CURSOR_OFF);

  const handleKey = (key) => {
    // Text entry swallows the key table wholesale: while naming a conversation
    // `q` is a letter, not a command.
    if (renaming) {
      if (key === '\r' || key === '\n') {
        setAlias(renaming.id, renaming.buffer);
        status = renaming.buffer.trim()
          ? `${palette.machine(`named "${renaming.buffer.trim()}"`)}`
          : `${palette.machine(`alias cleared`)}`;
        renaming = null;
        rebuild();
      } else if (key === '\x1b') {
        renaming = null;
        status = '';
      } else if (key === '\x7f' || key === '\b') {
        renaming.buffer = renaming.buffer.slice(0, -1);
      } else if (key === '\x03') {
        restore();
        process.exit(0);
      } else if (key.length === 1 && key >= ' ') {
        renaming.buffer += key;
      }
      if (renaming) status = `${palette.select(`name: ${renaming.buffer}▏`)}${palette.machine(`  enter saves · esc cancels`)}`;
      draw();
      return;
    }

    const action = keyAction(key);

    if (pendingBranch) {
      if (action === 'yes') doBranch();
      else status = '';
      pendingBranch = null;
      draw();
      return;
    }

    switch (action) {
      case 'quit':
        restore();
        process.exit(0);
        break;
      case 'up':
        cursor = Math.max(0, cursor - 1);
        status = '';
        break;
      case 'down':
        cursor = Math.min(selectable.length - 1, cursor + 1);
        status = '';
        break;
      case 'pageUp':
        cursor = Math.max(0, cursor - 10);
        break;
      case 'pageDown':
        cursor = Math.min(selectable.length - 1, cursor + 10);
        break;
      case 'top':
        cursor = 0;
        break;
      case 'bottom':
        cursor = selectable.length - 1;
        break;
      case 'detail':
        // Enter means "go deeper": into a conversation, or into a node's detail.
        if (mode === 'sessions') enterSession(selectedSession());
        // Still "go deeper", and it picks the best presentation there is room
        // for rather than making the user choose before they have seen either.
        else detailMode = detailMode === 'off' ? (columnsOf() >= PANE_MIN_COLS ? 'pane' : 'line') : 'off';
        break;
      case 'back':
        // Only meaningful when there is a list to go back to.
        if (mode === 'tree' && everyFile && everyFile.length) {
          mode = 'sessions';
          status = '';
          cursor = 0;
          offset = 0;
          loadSessions();
        }
        break;
      case 'all':
        if (everyFile && everyFile.length) {
          treeFiles = everyFile;
          treeFocusFile = null; // a whole-project merge is not one conversation
          mode = 'tree';
          status = '';
          loadTree();
          cursorToHead();
        }
        break;
      case 'refresh':
        rebuild();
        status = '';
        break;
      case 'layout':
        // The keybar says `tab`, and the keybar is the only discovery mechanism
        // this TUI has, so tab PRODUCES a pane — including from a cold start,
        // where it used to do nothing at all and look broken.
        //
        // In the tree, a second tab swaps down to the one-line form and `enter`
        // hides it. In the picker there is no one-line form — a conversation is
        // not one line — so tab is a straight on/off.
        detailMode =
          mode === 'sessions'
            ? detailMode === 'pane'
              ? 'off'
              : 'pane'
            : detailMode === 'pane'
              ? 'line'
              : 'pane';
        // Asking for something that cannot be drawn deserves an answer. The
        // refusal is silent everywhere else because nowhere else did you ask.
        if (detailMode === 'pane' && columnsOf() < PANE_MIN_COLS) {
          status = palette.machine(
            `the pane needs ${PANE_MIN_COLS} columns — this terminal has ${columnsOf()}` +
              (mode === 'sessions' ? '' : ', so detail stays on one line'),
          );
        }
        break;
      case 'family': {
        if (mode !== 'tree') {
          status = palette.machine('open a conversation first — f widens the tree it drew');
          break;
        }
        if (!treeFocusFile) {
          status = palette.machine('this view is already every session — esc goes back to the list');
          break;
        }
        showFamily = !showFamily;
        applyTreeFiles();
        loadTree();
        cursorToHead();
        const others = treeFiles.length - 1;
        status = palette.machine(
          others
            ? `showing this conversation and its ${others} branch${others === 1 ? '' : 'es'}`
            : showFamily
              ? 'this conversation has no branches or forks'
              : 'showing this arm alone',
        );
        break;
      }
      case 'open':
        doOpen();
        break;
      case 'rename': {
        const session = selectedSession();
        if (!session) {
          status = `${palette.machine(`naming applies to a conversation — go back to the list with esc`)}`;
          break;
        }
        renaming = { id: session.id, buffer: session.alias ?? '' };
        status = `${palette.select(`name: ${renaming.buffer}▏`)}${palette.machine(`  enter saves · esc cancels`)}`;
        break;
      }
      case 'branch': {
        if (mode === 'sessions') {
          status = `${palette.machine(`open a conversation first — branching happens in the tree`)}`;
          break;
        }
        const node = selectedNode();
        if (node && node.kind === 'prompt') {
          pendingBranch = node.uuid;
          status = `${palette.select(`branch before #${node.promptNo}? everything from there is left behind  [y/n]`)}`;
        } else {
          status = `${palette.machine(`select a prompt (●) to branch from`)}`;
        }
        break;
      }
      default:
        return;
    }
    draw();
  };

  input.on('data', (chunk) => {
    for (const key of splitKeys(chunk)) handleKey(key);
  });

  // Live beside the session. fs.watch is best-effort: if the platform refuses,
  // the view is still correct, it just needs `r`.
  let timer = null;
  for (const file of everyFile || []) {
    try {
      watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          rebuild();
          draw();
        }, 250);
      });
    } catch {
      /* manual refresh only */
    }
  }

  out.on('resize', draw);
  draw();
  return { branched };
}
