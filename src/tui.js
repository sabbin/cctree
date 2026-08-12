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

import { renderAsciiRows, renderHeader } from './render-ascii.js';
import { assignLanes } from './lanes.js';
import { planBranch, buildBranchText } from './branch.js';
import { describeSessions, renderSessionRows } from './session-list.js';
import { readAliases, setAlias } from './store.js';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_OFF = '\x1b[?25l';
const CURSOR_ON = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const DIM = '\x1b[2m';
const REV = '\x1b[7m';
const RESET = '\x1b[0m';

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
export function frame({ header, rows, selectedLine, offset, height, status = '', help = true }) {
  const out = [];
  for (const line of header.split('\n')) out.push(line);

  const body = rows.slice(offset, offset + height);
  for (const [i, row] of body.entries()) {
    const isSelected = offset + i === selectedLine;
    out.push(isSelected ? `${REV}${row.text}${RESET}` : row.text);
  }
  // Pad so the footer does not jump around as the viewport shortens.
  for (let i = body.length; i < height; i++) out.push('');

  if (status) out.push(status);
  else if (help) {
    out.push(
      `${DIM}↑↓/jk move · enter detail · b branch · o open · r refresh · q quit${
        rows.length > height ? ` · ${offset + 1}-${Math.min(offset + height, rows.length)}/${rows.length}` : ''
      }${RESET}`,
    );
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

/** The detail block for one node. Pure. */
export function detailOf(node) {
  if (!node) return '';
  const when = node.timestamp ? new Date(node.timestamp).toISOString().replace('T', ' ').slice(0, 19) : 'no timestamp';
  const bits = [
    `${node.kind}${node.subkind ? `/${node.subkind}` : ''}${node.promptNo ? `  #${node.promptNo}` : ''}`,
    `uuid ${node.uuid}`,
    when,
    `${node.sessions.size} session${node.sessions.size === 1 ? '' : 's'}`,
  ];
  if (node.collapsedInto) bits.push(`collapsed ${node.collapsedInto}`);
  return `${DIM}${bits.join(' · ')}${RESET}`;
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
    files = null,
    allFiles = null,
    out = process.stdout,
    input = process.stdin,
  } = {},
) {
  const everyFile = allFiles ?? files ?? null;
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
  let showDetail = false;
  const branched = [];
  let lastBranchId = null;

  const keyOf = (row) => row.uuid ?? row.id ?? null;
  const reindex = () => {
    selectable = rows.map((r, i) => (keyOf(r) ? i : -1)).filter((i) => i >= 0);
    if (cursor >= selectable.length) cursor = Math.max(0, selectable.length - 1);
  };

  const loadSessions = () => {
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
    rows = renderSessionRows(sessions, { color: true, width: out.columns || 100 });
    reindex();
  };

  const loadTree = () => {
    state = load(treeFiles);
    lanes = assignLanes(state.graph);
    rows = renderAsciiRows(state.graph, lanes, { color: true });
    reindex();
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
    treeFiles = [session.file];
    mode = 'tree';
    status = '';
    showDetail = false;
    loadTree();
    cursorToHead();
  };

  const header = () => {
    if (mode === 'sessions') {
      const total = sessions.length;
      const related = sessions.filter((s) => s.shares.length).length;
      return (
        `${total} conversation${total === 1 ? '' : 's'}${related ? ` · ${related} share history` : ''}\n` +
        `  ${DIM}enter opens one · o resumes it · a merges them all${RESET}`
      );
    }
    return renderHeader(state.graph, lanes, { file: state.title });
  };

  const footer = () =>
    mode === 'sessions'
      ? `${DIM}↑↓/jk move · enter open · o resume · n name · a merge all · q quit${RESET}`
      : null;

  const draw = () => {
    const head = header();
    const detail = mode === 'tree' && showDetail ? detailOf(selectedNode()) : '';
    const chrome = head.split('\n').length + 1 + (detail ? 1 : 0);
    const height = Math.max(1, (out.rows || 24) - chrome);
    const selectedLine = selectable[cursor] ?? 0;
    offset = clampOffset({ selectedLine, offset, height, total: rows.length });
    const custom = footer();
    const lines = frame({
      header: head,
      rows,
      selectedLine,
      offset,
      height,
      status: status || (custom ?? ''),
    });
    if (detail) lines.push(detail);
    out.write(CLEAR + lines.join('\n'));
  };

  rebuild();
  if (mode === 'tree') cursorToHead();

  // `--select` aims the frame at a node without the interactive loop. That is
  // what makes the graph navigable from inside a chat.
  if (select != null && mode === 'tree') {
    const found = resolveSelection(state.graph, rows, selectable, select);
    if (found < 0) status = `${DIM}no node matching "${select}"${RESET}`;
    else {
      cursor = found;
      showDetail = true;
    }
  }

  // One frame, no raw mode, no alt screen — used by `--once` and by tests.
  if (once) {
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
    });
    if (mode === 'tree' && showDetail) lines.push(detailOf(selectedNode()));
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
      status = `${DIM}select a prompt (●) to branch from${RESET}`;
      return;
    }
    const file = node.record?.file;
    const records = state.recordsByFile?.get(file);
    if (!file || !records) {
      status = `${DIM}cannot locate the source transcript for that node${RESET}`;
      return;
    }
    const plan = planBranch(records, node.promptNo);
    if (!plan.ok) {
      status = `${DIM}${plan.reason}${RESET}`;
      return;
    }
    const id = randomUUID();
    const dest = join(dirname(file), `${id}.jsonl`);
    if (existsSync(dest)) {
      status = `${DIM}refusing to overwrite ${dest}${RESET}`;
      return;
    }
    const { text } = buildBranchText(readFileSync(file, 'utf8'), {
      cutLine: plan.cutLine,
      newSessionId: id,
    });
    if (!text) {
      status = `${DIM}branch would be empty${RESET}`;
      return;
    }
    writeFileSync(dest, text);
    branched.push({ at: node.promptNo, id });
    lastBranchId = id;
    status = emit
      ? `${REV}branched before #${node.promptNo} — press o to open it${RESET}`
      : `${DIM}branched before #${node.promptNo} · claude -r ${id}${RESET}`;
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
      status = `${DIM}${target.reason}${RESET}`;
      return;
    }
    if (!emit) {
      status = `${DIM}claude -r ${target.id}   (run cctree-go to do this in one key)${RESET}`;
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
          ? `${DIM}named "${renaming.buffer.trim()}"${RESET}`
          : `${DIM}alias cleared${RESET}`;
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
      if (renaming) status = `${REV}name: ${renaming.buffer}▏${RESET}${DIM}  enter saves · esc cancels${RESET}`;
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
        else showDetail = !showDetail;
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
      case 'open':
        doOpen();
        break;
      case 'rename': {
        const session = selectedSession();
        if (!session) {
          status = `${DIM}naming applies to a conversation — go back to the list with esc${RESET}`;
          break;
        }
        renaming = { id: session.id, buffer: session.alias ?? '' };
        status = `${REV}name: ${renaming.buffer}▏${RESET}${DIM}  enter saves · esc cancels${RESET}`;
        break;
      }
      case 'branch': {
        if (mode === 'sessions') {
          status = `${DIM}open a conversation first — branching happens in the tree${RESET}`;
          break;
        }
        const node = selectedNode();
        if (node && node.kind === 'prompt') {
          pendingBranch = node.uuid;
          status = `${REV}branch before #${node.promptNo}? everything from there is left behind  [y/n]${RESET}`;
        } else {
          status = `${DIM}select a prompt (●) to branch from${RESET}`;
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
