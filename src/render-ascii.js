// Phase 1c — one of two renderers over the same lane model. SVG comes later and
// must consume `assignLanes()` output unchanged.

import { PLAIN, makePalette, vlen } from './palette.js';
import { transcriptEnds, trunkChildOf } from './graph.js';

const GLYPH = {
  prompt: '●',
  assistant: '○',
  tool_use: '○',
  tool_result: '○',
  system: '○',
  meta: '○',
  compact: '⊙',
  summary: '⊙',
  graft: '⊕',
  // An unused /fork, placed by inference rather than by a record of its own.
  // U+2442 is the character `/fork` writes into its own title, so it means that
  // command and nothing else — a plain divergence never borrows it.
  fork: '⑂',
  attachment: '○',
  command: '▪',
  // A sidecar is never laid out, so this is only ever a fallback. `unknown` now
  // means one thing only: a record with a uuid whose shape we did not recognise.
  sidecar: '⋄',
  unknown: '?',
};

function glyphFor(node) {
  // A fork stub is always a leaf, so `isTip` would swallow it — and "this arm
  // stopped here" is the least interesting true thing about it. The fork glyph
  // is checked first because it says the more useful half.
  if (node.kind === 'fork') return GLYPH.fork;
  if (node.isHead) return '◆';
  if (node.isTip) return '◇';
  return GLYPH[node.kind] || '○';
}

function label(node, { refs = new Map(), previewW = 56 } = {}) {
  // Provenance, not content: which sessions carry this node and what a caller
  // named it. Computed first because it is spent from the same line budget the
  // preview is — a `(5 sessions)` tail appended afterwards overran the terminal.
  const tail = [];
  const ref = refs.get(node.uuid);
  if (ref) tail.push(`[${ref}]`);
  if (node.sessions.size > 1) tail.push(`(${node.sessions.size} sessions)`);
  const room = Math.max(24, previewW - (tail.length ? tail.join(' ').length + 1 : 0));

  const bits = [];
  if (node.kind === 'prompt') {
    // `#N` used to live here, which put it at a different screen column for
    // every lane depth — the numbers never lined up with each other. It is a
    // gutter now (see `gut` below), and this is where it stopped being text.
    bits.push(node.preview ? `"${truncate(node.preview, room)}"` : '(empty prompt)');
  } else if (node.collapsedInto) {
    // A run of pure machinery (three session-opening attachments, a slash
    // command's three records) is not an assistant turn — do not call it one.
    const tools = node.collapsedKinds.filter((k) => k === 'tool_use').length;
    const conversational = node.collapsedKinds.some((k) => k === 'assistant' || k === 'tool_use');
    const head = conversational ? 'assistant' : node.kind;
    bits.push(`${head} · ${node.collapsedInto} msgs${tools ? `, ${tools} tools` : ''}`);
  } else if (node.kind === 'fork') {
    // Placed by inference — say so on the row, not only in the header. It marks
    // a file that exists and has never been used, which is the normal state of
    // a fork rather than a fault: nothing this conversation does reaches it.
    bits.push(`fork · ${node.preview || 'no records of its own'} · placed by creation time`);
  } else if (node.kind === 'compact') {
    bits.push('compacted');
    if (node.preview) bits.push(truncate(node.preview, 44));
  } else {
    bits.push(node.kind);
    if (node.preview) bits.push(truncate(node.preview, 44));
  }
  if (node.summary) bits.push(`⊙ ${truncate(node.summary, 40)}`);
  // The tail is returned apart from the label so the caller can dim it without
  // nesting escape codes inside a coloured span — a reset in the middle would
  // drop the colour for everything after it.
  //
  // `← HEAD` is no longer part of the text either: it is appended at render time
  // so it can be right-aligned, where it stays findable however long the label.
  return { text: bits.join(' '), tail: tail.join(' ') };
}

/**
 * Nearest prompt at or above a node — the thing you would rewind to.
 *
 * Exported because the detail pane names the same thing: it is what `b` would
 * branch from, and computing it twice is how the fork note and the pane would
 * come to disagree.
 */
export function ancestorPrompt(nodes, node) {
  let cur = node.parentUuid ? nodes.get(node.parentUuid) : null;
  let hops = 0;
  while (cur && hops++ < 500) {
    if (cur.kind === 'prompt') return cur;
    cur = cur.parentUuid ? nodes.get(cur.parentUuid) : null;
  }
  return null;
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * @param {object} graph annotated graph
 * @param {{rows: Array, width: number}} lanes
 */
export function renderAscii(graph, lanes, opts = {}) {
  return renderAsciiRows(graph, lanes, opts)
    .map((r) => r.text)
    .join('\n');
}

/**
 * Same output as renderAscii, but as rows tagged with the node they carry
 * (`uuid: null` for connector and link rows). The TUI needs this to map a
 * selection back to a screen line; keeping one renderer means the interactive
 * and printed views can never drift apart.
 *
 * @returns {{text: string, uuid: string|null}[]}
 */
export function renderAsciiRows(
  graph,
  lanes,
  { color = false, palette = null, refs = new Map(), selected = null, width = 0 } = {},
) {
  const { nodes } = graph;
  const out = [];
  // The renderer never builds an escape: it is handed a palette and calls it.
  // `color: true` is the shorthand a printed view and the tests still use, and
  // resolves to the 16-colour tier — the one every terminal has.
  const pal = palette ?? (color ? makePalette(4) : PLAIN);
  const cols = lanes.width;
  const push = (text, uuid = null) => out.push({ text, uuid });

  // A fixed gutter left of the lane art, so every `#N` sits in the same column
  // whatever depth its node is at. Width is computed once from the highest
  // number in the graph; rows with no number get spaces, which is what keeps
  // the lane art itself aligned across every kind of row.
  const highest = Math.max(0, ...[...nodes.values()].map((n) => (Number.isInteger(n.promptNo) ? n.promptNo : 0)));
  const gutterW = Math.max(2, 1 + String(highest).length);
  const gut = (n) => `${(Number.isInteger(n) ? `#${n}` : '').padStart(gutterW)}  `;
  const noGut = ' '.repeat(gutterW + 2);

  // How much of a prompt there is room to show. 56 was a fixed print width and
  // stays the default for callers with no terminal to ask; given one, the
  // preview takes what the gutter, the lane art and the HEAD marker leave.
  const chrome = 1 + gutterW + 2 + 2 * cols;
  const previewW = width ? Math.max(24, width - chrome - 12) : 56;

  // Whether this view spans more than one transcript. In a merged view an arm IS
  // a session — you made it with `/branch` and it has an id you can resume — and
  // a tree that draws two arms without naming either leaves you counting lanes
  // against a list of sessions. In a single-file view there is nothing to say.
  //
  // Measured by FILE, not by `node.sessions`: that set falls back to the file
  // path for any record without a `sessionId`, so a single transcript holding a
  // mix of both looked like two sessions and reported a boundary that does not
  // exist — with half a path where a session id should be. A transcript is the
  // thing these notes are actually about, and its name IS the session id.
  const allFiles = new Set();
  for (const n of nodes.values()) for (const f of n.files) allFiles.add(f);
  const merged = allFiles.size > 1;
  const short = (file) => String(file).replace(/^.*[/\\]/, '').replace(/\.jsonl$/, '').slice(0, 8);
  /** Which session an arm belongs to, when that is a fact worth having. */
  const armOf = (node) => {
    if (!merged) return '';
    const ids = [...node.files].map(short);
    if (!ids.length) return '';
    // Named while there are few enough to read. An arm carrying three or more
    // transcripts is a shared prefix that will fork again further down, and the
    // ids that matter get named at those forks.
    return ids.length <= 2 ? ` → ${ids.join(', ')}` : ` → ${ids.length} sessions`;
  };

  /**
   * What to call an arm where it begins. TWO different events open one, and
   * naming them the same would repeat the mistake of calling every divergence a
   * fork: a SPLIT, where the node genuinely has several children, and a
   * transcript BOUNDARY, where `/branch` was taken from a tip and forked
   * nothing at all — the chain is straight and the file simply changes.
   */
  const openingNote = (node, parentNode) => {
    if (transcriptEnds(parentNode, node)) {
      const ended = [...parentNode.files].filter((f) => !node.files.has(f));
      const stops = ended.length === 1 ? `${short(ended[0])} ends` : `${ended.length} sessions end`;
      const anc = ancestorPrompt(nodes, node);
      const where = anc ? ` after #${anc.promptNo}` : '';
      return `branched${where} → ${[...node.files].map(short).join(', ')} · ${stops} here`;
    }
    const anc = ancestorPrompt(nodes, node);
    if (!anc) return '';
    // The trunk child is not a split — it is the conversation carrying on. It
    // gets a note at all only because arms were drawn between it and its
    // parent; saying "split" there calls the original a branch of its own copy.
    if (parentNode && trunkChildOf(nodes, parentNode) === node.uuid) {
      return `#${anc.promptNo} continues${armOf(node)}`;
    }
    return `split after #${anc.promptNo} ${truncate(anc.preview, 32)}${armOf(node)}`;
  };

  for (const [idx, row] of lanes.rows.entries()) {
    const node = nodes.get(row.uuid);

    // Vertical link from the previous row. A connector row draws its own.
    //
    // Not before EVERY row, though: a bar between a prompt and the reply
    // directly beneath it in the same lane spends half the screen on `│` and
    // flattens the whole tree into one texture. A prompt and what follows it are
    // one turn, so they are drawn joined; the bar survives BETWEEN turns, which
    // is where it does the work of showing the lane continuing.
    const prev = idx > 0 ? lanes.rows[idx - 1] : null;
    const prevNode = prev ? nodes.get(prev.uuid) : null;
    const joined = prevNode?.kind === 'prompt' && prev.lane === row.lane;
    if (prev && row.opensFrom == null && !joined) {
      const cells = Array.from({ length: cols }, () => '  ');
      for (const l of prev.liveAfter) cells[l] = '│ ';
      const line = cells.join('').trimEnd();
      if (line) push(` ${noGut}${pal.faint(line)}`);
    }

    // Connector row when a new lane opens off an existing one. Chronological
    // layout means the connector meets a *column*, not the fork row, so name the
    // prompt it split after — that number is the rewind recipe (spec §5.1).
    if (row.opensFrom != null) {
      const cells = Array.from({ length: cols }, () => '  ');
      for (const l of row.through) cells[l] = '│ ';
      // A recycled column can sit to the LEFT of the lane it forks from, so the
      // corner has to follow the direction of travel. Drawing `├─` at the parent
      // unconditionally produced `──├─`, with the elbow pointing back the way it
      // came. Only the merged multi-session view makes this shape appear.
      const opens = row.opensFrom;
      const rightward = row.lane > opens;
      const from = Math.min(opens, row.lane);
      const to = Math.max(opens, row.lane);
      for (let i = from; i <= to; i++) {
        if (i === opens) cells[i] = rightward ? '├─' : '┤ ';
        else if (i === row.lane) cells[i] = rightward ? '┐ ' : '┌─';
        else cells[i] = '──';
      }
      push(` ${noGut}${pal.faint(cells.join('').trimEnd())}`);
      // The note gets its own row, indented to the lane the arm opens into.
      // Appended to the elbow it collided with the lane art of everything to the
      // right of it, and the deeper the fork the worse it read.
      const note = openingNote(node, nodes.get(node.parentUuid));
      if (note) push(` ${noGut}${' '.repeat(2 * row.lane)}${pal.faint(note)}`);
    }

    // A node that KEPT its parent's lane at a fork has diverged just as much as
    // the sibling that departed — but the layout says nothing, because nothing
    // moved. When other arms were drawn in between, the parent is far up the
    // screen and the connection is lost entirely, which is the case that reads
    // as "the trunk carried on" when it did not. So it gets the same note its
    // sibling got. Adjacent to its parent it needs none: the bar says it.
    const parentNode = node.parentUuid ? nodes.get(node.parentUuid) : null;

    // The trunk child KEPT its parent's column, so the layout says nothing about
    // it — nothing moved. It is also drawn last, after every arm's subtree, so
    // its parent is always far up the screen. Hence a note, always: under
    // depth-first order there is no case where it sits under its own parent.
    if (row.opensFrom == null && parentNode?.children.length > 1) {
      const note = openingNote(node, parentNode);
      if (note) push(` ${noGut}${' '.repeat(2 * row.lane)}${pal.faint(note)}`);
    }

    const cells = Array.from({ length: cols }, () => '  ');
    for (const l of row.through) cells[l] = '│ ';
    // Only the GLYPH goes green at HEAD. Painting the whole row bold+green made
    // the one row you already knew how to find the loudest thing on the screen,
    // and left no colour spare for saying what the row actually is.
    cells[row.lane] = `${node.isHead ? pal.head(glyphFor(node)) : glyphFor(node)} `;

    const graph_ = cells.join('');
    const isSel = selected === node.uuid;
    let { text: core, tail } = label(node, { refs, previewW });
    // Say it on the fork row itself. Otherwise a fork whose arms are drawn far
    // apart is invisible at the one place you are looking when you ask "where
    // did this split?" — and one of its arms always looks like a continuation.
    // No glyph: `⑂` is reserved for a real `/fork`. A node with two children is
    // a SPLIT, and the graph cannot tell which of the three mechanisms made it.
    const arms = node.children.length > 1 ? `${node.children.length} arms` : '';
    // The per-bit budgets inside `label` size the interesting part; this is the
    // guarantee. A label is a preview plus a kind plus a tail, and any of them
    // can be the one that overruns — so the finished line is measured against
    // the width once, here, rather than trusted to three separate allowances.
    if (width) {
      const fixed =
        1 +
        gutterW +
        2 +
        2 * cols +
        (tail ? tail.length + 1 : 0) +
        (arms ? arms.length + 1 : 0) +
        (node.isHead ? 7 : 0);
      core = truncate(core, Math.max(12, width - fixed));
    }
    // Machinery reads dim, what the user wrote reads cyan, and HEAD's text is
    // left alone — its glyph already says where you are.
    let text =
      node.kind === 'prompt'
        ? pal.prompt(core)
        : node.kind === 'fork'
          ? pal.graft(core) // transplanted history, the same hue the picker badges it with
          : node.isHead
            ? core
            : pal.machine(core);
    if (tail) text += ` ${pal.machine(tail)}`;
    // Graft's hue — divergence, the same colour the picker badges a fork with.
    if (arms) text += ` ${pal.graft(arms)}`;

    let line = `${isSel ? '▸' : ' '}${gut(node.promptNo)}${graph_}${text}`;
    if (node.isHead) {
      const badge = pal.head('← HEAD');
      // Right-aligned when the caller said how wide the screen is; otherwise it
      // trails the label, since padding to a width nobody supplied would be
      // trailing whitespace in printed output.
      const pad = width ? Math.max(1, width - vlen(line) - vlen(badge)) : 1;
      line += `${' '.repeat(pad)}${badge}`;
    }
    push(line, node.uuid);
  }

  // Where the borrowed history stops and the fork itself would begin. Drawn as
  // a row rather than printed by the caller so the tree and the TUI, which
  // scrolls these rows, cannot disagree about what the last line is.
  if (graph.inheritedFrom) {
    push(` ${noGut}${pal.faint('╵')}`);
    push(` ${noGut}${pal.faint('fork starts here · waiting for its first prompt')}`);
  }

  return out;
}

export function renderHeader(graph, lanes, { file = '' } = {}) {
  // An unused fork has no records of its own, so the counts below describe the
  // parent's history, not this session's. Saying so is the whole point: the
  // alternative is a tree that looks like it belongs to a file it is not in.
  if (graph.inheritedFrom) {
    const { parentId, count } = graph.inheritedFrom;
    return [
      `fork of ${parentId.slice(0, 8)} · no records of its own yet`,
      `  showing ${count} inherited record${count === 1 ? '' : 's'}, cut at this fork's creation time (inferred)`,
      file ? `  ${file}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const prompts = [...graph.nodes.values()].filter((n) => n.kind === 'prompt').length;
  const unknown = [...graph.nodes.values()].filter((n) => n.kind === 'unknown').length;
  const sidecars = graph.sidecars?.length || 0;
  return [
    `${graph.nodes.size} node${graph.nodes.size === 1 ? '' : 's'} · ${prompts} prompt${
      prompts === 1 ? '' : 's'
    } · ${lanes.width} lane${lanes.width === 1 ? '' : 's'} · ${graph.tips.length} tip${
      graph.tips.length === 1 ? '' : 's'
    }${
      graph.splits.length ? ` · ${graph.splits.length} split${graph.splits.length === 1 ? '' : 's'}` : ''
    }${sidecars ? ` · ${sidecars} sidecar` : ''}${
      // Surfaced here as well as in `stats`, because an unrecognised in-tree
      // record is the one thing that quietly degrades this view.
      unknown ? ` · ${unknown} UNKNOWN` : ''
    }`,
    file ? `  ${file}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
