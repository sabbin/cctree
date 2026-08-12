// Phase 1c — one of two renderers over the same lane model. SVG comes later and
// must consume `assignLanes()` output unchanged.

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
  attachment: '○',
  command: '▪',
  // A sidecar is never laid out, so this is only ever a fallback. `unknown` now
  // means one thing only: a record with a uuid whose shape we did not recognise.
  sidecar: '⋄',
  unknown: '?',
};

const C = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
};

function glyphFor(node) {
  if (node.isHead) return '◆';
  if (node.isTip) return '◇';
  return GLYPH[node.kind] || '○';
}

function label(node, { refs = new Map() } = {}) {
  const bits = [];
  if (node.kind === 'prompt') {
    bits.push(`#${node.promptNo ?? '?'}`);
    bits.push(node.preview ? `"${truncate(node.preview, 56)}"` : '(empty prompt)');
  } else if (node.collapsedInto) {
    // A run of pure machinery (three session-opening attachments, a slash
    // command's three records) is not an assistant turn — do not call it one.
    const tools = node.collapsedKinds.filter((k) => k === 'tool_use').length;
    const conversational = node.collapsedKinds.some((k) => k === 'assistant' || k === 'tool_use');
    const head = conversational ? 'assistant' : node.kind;
    bits.push(`${head} · ${node.collapsedInto} msgs${tools ? `, ${tools} tools` : ''}`);
  } else if (node.kind === 'compact') {
    bits.push('compacted');
    if (node.preview) bits.push(truncate(node.preview, 44));
  } else {
    bits.push(node.kind);
    if (node.preview) bits.push(truncate(node.preview, 44));
  }
  if (node.summary) bits.push(`⊙ ${truncate(node.summary, 40)}`);
  const ref = refs.get(node.uuid);
  if (ref) bits.push(`[${ref}]`);
  if (node.isHead) bits.push('← HEAD');
  if (node.sessions.size > 1) bits.push(`(${node.sessions.size} sessions)`);
  return bits.join(' ');
}

/** Nearest prompt at or above a node — the thing you would rewind to. */
function ancestorPrompt(nodes, node) {
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
export function renderAsciiRows(graph, lanes, { color = false, refs = new Map(), selected = null } = {}) {
  const { nodes } = graph;
  const out = [];
  const paint = (s, c) => (color ? `${c}${s}${C.reset}` : s);
  const cols = lanes.width;
  const push = (text, uuid = null) => out.push({ text, uuid });

  for (const [idx, row] of lanes.rows.entries()) {
    const node = nodes.get(row.uuid);

    // Vertical link from the previous row. A connector row draws its own.
    const prev = idx > 0 ? lanes.rows[idx - 1] : null;
    if (prev && row.opensFrom == null) {
      const cells = Array.from({ length: cols }, () => '  ');
      for (const l of prev.liveAfter) cells[l] = '│ ';
      const line = cells.join('').trimEnd();
      if (line) push(` ${paint(line, C.dim)}`);
    }

    // Connector row when a new lane opens off an existing one. Chronological
    // layout means the connector meets a *column*, not the fork row, so name the
    // prompt it forked after — that number is the rewind recipe (spec §5.1).
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
      const anc = ancestorPrompt(nodes, node);
      const note = anc ? `  forked after #${anc.promptNo} ${truncate(anc.preview, 32)}` : '';
      push(` ${paint(cells.join('').trimEnd() + note, C.dim)}`);
    }

    const cells = Array.from({ length: cols }, () => '  ');
    for (const l of row.through) cells[l] = '│ ';
    cells[row.lane] = `${glyphFor(node)} `;

    const graph_ = cells.join('');
    const isSel = selected === node.uuid;
    let text = label(node, { refs });
    if (color) {
      if (node.isHead) text = `${C.bold}${C.green}${text}${C.reset}`;
      else if (node.kind === 'prompt') text = `${C.cyan}${text}${C.reset}`;
      else text = `${C.dim}${text}${C.reset}`;
    }
    push(`${isSel ? '▸' : ' '}${graph_}${text}`, node.uuid);
  }

  // Where the borrowed history stops and the fork itself would begin. Drawn as
  // a row rather than printed by the caller so the tree and the TUI, which
  // scrolls these rows, cannot disagree about what the last line is.
  if (graph.inheritedFrom) {
    push(` ${paint('╵', C.dim)}`);
    push(` ${paint('fork starts here · waiting for its first prompt', C.dim)}`);
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
    `${graph.nodes.size} nodes · ${prompts} prompts · ${lanes.width} lanes · ${graph.tips.length} tips${
      graph.forks.length ? ` · ${graph.forks.length} forks` : ''
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
