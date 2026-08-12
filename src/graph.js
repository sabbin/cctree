// Phase 1a — records -> tree.
//
// Cross-session note: `/branch` copies the prefix records verbatim, so the same
// uuid appears in two files. We dedupe by uuid and keep the set of sessions a
// node appears in; the fork point then falls out of the tree for free, with no
// separate "fork edge" concept and no uuid-intersection pass.
//
// Risk (spec §10): if a future release rewrites uuids on copy, dedupe silently
// stops working and the two lanes render as disconnected roots. `looksForked()`
// below is the detector for that case.

/**
 * @param {object[]} records normalized records, possibly from several files
 * @returns {{nodes: Map, roots: string[], order: string[], orphans: object[],
 *            summaries: object[], sidecars: object[]}}
 */
export function buildGraph(records, { linearize = true } = {}) {
  const nodes = new Map();
  const summaries = [];
  const sidecars = [];
  let synthetic = 0;

  for (const r of records) {
    // Summary records point at a leaf and carry no uuid of their own.
    if (r.kind === 'summary' && !r.uuid) {
      summaries.push(r);
      continue;
    }

    // Session-level state (mode, permission-mode, ai-title, last-prompt,
    // file-history-snapshot). Kept — they are the phase-5 checkpoint trail and a
    // drift canary — but they are not conversation nodes. Before this bucket
    // existed they took synthetic uuids and rendered as a stack of orphan tips,
    // which was 19 of the 32 rows on a real single-session project.
    if (r.kind === 'sidecar') {
      sidecars.push(r);
      continue;
    }

    // Belt and braces. With the sidecar gate in classify() nothing uuid-less
    // should reach here; a hand-built record still must not collide or throw.
    const uuid = r.uuid || `synthetic-${synthetic++}-${r.file}:${r.line}`;
    const existing = nodes.get(uuid);
    if (existing) {
      // Same node seen in another file (a /branch copy). Keep the first, record
      // the extra session, and prefer a non-null parent if we have one.
      existing.sessions.add(r.sessionId || r.file);
      existing.files.add(r.file);
      if (!existing.parentUuid && r.parentUuid) existing.parentUuid = r.parentUuid;
      continue;
    }

    nodes.set(uuid, {
      uuid,
      parentUuid: r.parentUuid,
      kind: r.kind,
      subkind: r.subkind,
      type: r.type,
      timestamp: r.timestamp,
      preview: r.preview,
      checkpoint: r.checkpoint,
      isSidechain: r.isSidechain,
      inherited: r.inherited === true,
      requestId: r.requestId,
      toolUseIds: r.toolUseIds,
      toolResultFor: r.toolResultFor,
      sessions: new Set([r.sessionId || r.file]),
      files: new Set([r.file]),
      line: r.line,
      children: [],
      record: r,
    });
  }

  // Link. A parentUuid pointing at nothing we have (expired transcript, /clear,
  // partial read) makes the node a root rather than an error.
  const orphans = [];
  for (const node of nodes.values()) {
    if (!node.parentUuid) continue;
    const parent = nodes.get(node.parentUuid);
    if (!parent) {
      orphans.push({ uuid: node.uuid, missingParent: node.parentUuid });
      node.danglingParent = node.parentUuid;
      node.parentUuid = null;
      continue;
    }
    parent.children.push(node.uuid);
  }

  const cmp = (a, b) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    return (na.timestamp ?? 0) - (nb.timestamp ?? 0) || na.line - nb.line;
  };
  for (const node of nodes.values()) node.children.sort(cmp);

  // Before anything reads the shape of the tree. topoOrder, tips, forks and the
  // lane allocator all derive from children, so a phantom fork left in place
  // here is one the whole pipeline believes.
  const relinked = linearize ? linearizeTurns(nodes, cmp) : [];

  const roots = [...nodes.values()].filter((n) => !n.parentUuid).map((n) => n.uuid).sort(cmp);

  // Attach summary records to the leaf they name.
  for (const s of summaries) {
    const leaf = s.leafUuid && nodes.get(s.leafUuid);
    if (leaf) leaf.summary = s.preview;
  }

  return { nodes, roots, orphans, summaries, sidecars, relinked, order: topoOrder(nodes, roots) };
}

/**
 * Undo the phantom fork that parallel tool calls write.
 *
 * A turn that issues several tool calls is one API request, and the assistant
 * cannot branch inside one — so a fork whose arms share a requestId is an
 * artifact of write ordering, not a decision anyone made. Measured on this
 * project's own transcripts: the same parallel turn is written two ways, and
 * which one you get is a race between the result arriving and the next call
 * being recorded.
 *
 *   linear (8 of 14 runs)        forked (6 of 14 runs)
 *     use A                        use A ──┬── use B     (sibling, same request)
 *       └ result A                         └── result A  (dead end, phantom tip)
 *           └ use B
 *               └ result B
 *
 * Both mean the same thing, so we normalize the second into the first: the
 * sibling call is re-chained onto the result of the call it followed. The test
 * is deliberately narrow — the arms must share a requestId AND one of them must
 * be the result answering a tool_use this very node issued — because a genuine
 * rewind fork has neither property (a prompt carries no requestId at all).
 * Anything that fails the test is left exactly where the transcript put it.
 *
 * Mutates `nodes` in memory only. Transcripts are never rewritten.
 *
 * @returns {Array<{parent: string, moved: string, onto: string}>} what was moved
 */
export function linearizeTurns(nodes, cmp) {
  // A tool_result carries no requestId of its own, so turn membership is "same
  // requestId, or answers a call this run issued". Built once, for all runs.
  const issuedBy = new Map();
  for (const n of nodes.values()) {
    if (!n.requestId || !n.toolUseIds) continue;
    let ids = issuedBy.get(n.requestId);
    if (!ids) issuedBy.set(n.requestId, (ids = new Set()));
    for (const id of n.toolUseIds) ids.add(id);
  }
  const inTurn = (n, rq) =>
    !!n && (n.requestId === rq || !!n.toolResultFor?.some((id) => issuedBy.get(rq)?.has(id)));

  // Walk to the end of a turn's chain: follow in-turn children only, so the walk
  // stops at the boundary where the next turn takes over.
  const endOfChain = (from, rq) => {
    let at = from;
    const seen = new Set([at.uuid]);
    for (;;) {
      const next = at.children.map((u) => nodes.get(u)).find((c) => inTurn(c, rq));
      if (!next || seen.has(next.uuid)) return at;
      seen.add(next.uuid);
      at = next;
    }
  };

  const relinked = [];
  for (const parent of nodes.values()) {
    if (parent.children.length < 2 || !parent.requestId || !parent.toolUseIds) continue;
    const rq = parent.requestId;
    const issued = new Set(parent.toolUseIds);

    let result = null;
    const siblings = [];
    for (const uuid of parent.children) {
      const child = nodes.get(uuid);
      if (!child) continue;
      if (!result && child.toolResultFor?.some((id) => issued.has(id))) result = child;
      else if (child.requestId === rq) siblings.push(child);
    }
    if (!result || !siblings.length) continue;

    for (const sibling of siblings) {
      const tail = endOfChain(result, rq);

      // A corrupt file could put the sibling above the tail, and re-chaining
      // then closes a loop. Cheap to rule out, and the parser's contract is that
      // no transcript makes us throw.
      let hop = tail;
      let cyclic = false;
      while (hop) {
        if (hop.uuid === sibling.uuid) { cyclic = true; break; }
        hop = hop.parentUuid ? nodes.get(hop.parentUuid) : null;
      }
      if (cyclic) continue;

      // Splice, do not append. Whatever already hangs off the end of the turn is
      // the NEXT turn, and it belongs after the call being moved, not beside it —
      // appending here merely relocates the phantom fork one node down, which is
      // what the first cut of this did.
      const follow = tail.children.filter((u) => !inTurn(nodes.get(u), rq));

      parent.children = parent.children.filter((u) => u !== sibling.uuid);
      tail.children = tail.children.filter((u) => !follow.includes(u));
      tail.children.push(sibling.uuid);
      tail.children.sort(cmp);
      sibling.parentUuid = tail.uuid;

      const spliceEnd = endOfChain(sibling, rq);
      for (const u of follow) {
        const node = nodes.get(u);
        if (!node) continue;
        node.parentUuid = spliceEnd.uuid;
        spliceEnd.children.push(u);
      }
      spliceEnd.children.sort(cmp);

      relinked.push({ parent: parent.uuid, moved: sibling.uuid, onto: tail.uuid });
    }
  }
  return relinked;
}

/** Chronological order that never emits a child before its parent. */
export function topoOrder(nodes, roots) {
  const out = [];
  const ready = [...roots];
  const seen = new Set();

  const pick = () => {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = nodes.get(ready[i]);
      const b = nodes.get(ready[best]);
      if ((a.timestamp ?? 0) - (b.timestamp ?? 0) < 0) best = i;
    }
    return ready.splice(best, 1)[0];
  };

  while (ready.length) {
    const uuid = pick();
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    out.push(uuid);
    ready.push(...nodes.get(uuid).children);
  }
  // Anything left (cycle from a corrupt file) gets appended rather than dropped.
  for (const uuid of nodes.keys()) if (!seen.has(uuid)) out.push(uuid);
  return out;
}

/** Tips, HEAD, fork points, prompt numbering. */
export function annotate(graph, { headUuid = null } = {}) {
  const { nodes, order } = graph;
  const tips = [];
  const forks = [];
  let promptNo = 0;

  for (const uuid of order) {
    const n = nodes.get(uuid);
    if (n.children.length === 0) tips.push(uuid);
    if (n.children.length > 1) forks.push(uuid);
    if (n.kind === 'prompt') n.promptNo = ++promptNo;
  }
  // HEAD defaults to the most recent tip.
  const head =
    headUuid && nodes.has(headUuid)
      ? headUuid
      : tips.slice().sort((a, b) => (nodes.get(b).timestamp ?? 0) - (nodes.get(a).timestamp ?? 0))[0] || null;

  for (const t of tips) nodes.get(t).isTip = true;
  if (head) nodes.get(head).isHead = true;
  graph.tips = tips;
  graph.forks = forks;
  graph.head = head;
  return graph;
}

/**
 * Collapse linear runs of non-prompt machinery into a single node.
 * Never collapses across a fork, a prompt, a tip, or a compaction marker.
 */
export function collapse(graph, { enabled = true } = {}) {
  if (!enabled) return graph;
  const { nodes } = graph;
  // `attachment` and `command` join the machinery set: a session opens with a
  // run of three attachments, and one slash command expands into three records.
  // Left uncollapsed they push the actual conversation off the screen.
  const COLLAPSIBLE = new Set([
    'assistant',
    'tool_use',
    'tool_result',
    'system',
    'meta',
    'attachment',
    'command',
  ]);
  const collapsible = (n) => !!n && COLLAPSIBLE.has(n.kind);

  const absorbed = new Set();
  for (const n of nodes.values()) {
    if (absorbed.has(n.uuid) || !collapsible(n)) continue;
    let span = 1;
    let cur = n;
    const parts = [n.kind];
    while (cur.children.length === 1) {
      const next = nodes.get(cur.children[0]);
      if (!collapsible(next) || next.children.length > 1 || next.summary) break;
      absorbed.add(next.uuid);
      parts.push(next.kind);
      span++;
      cur = next;
    }
    if (span > 1) {
      n.collapsedInto = span;
      n.collapsedKinds = parts;
      n.children = cur.children;
      for (const c of cur.children) nodes.get(c).parentUuid = n.uuid;
      if (cur.isTip) n.isTip = true;
      if (cur.isHead) n.isHead = true;
      n.tailUuid = cur.uuid;
      if (!n.preview && cur.preview) n.preview = cur.preview;
    }
  }
  for (const uuid of absorbed) nodes.delete(uuid);
  graph.order = graph.order.filter((u) => !absorbed.has(u));
  graph.tips = (graph.tips || []).filter((u) => !absorbed.has(u));
  if (graph.head && absorbed.has(graph.head)) {
    graph.head = [...nodes.values()].find((n) => n.tailUuid === graph.head)?.uuid ?? graph.head;
  }
  return graph;
}

/**
 * Drift detector for spec §10: two session files that share no uuids but whose
 * roots have the same cwd and overlapping timestamps probably ARE forks whose
 * uuids were rewritten. Report, don't guess.
 *
 * This used to count distinct sessions among the roots, which is not the test
 * the paragraph above describes and fired on any project with two unrelated
 * sessions — a guaranteed false positive rather than a drift signal. Two things
 * had to be true before it could ever be right:
 *
 *   - sidecar records no longer become synthetic roots (they inflated the count)
 *   - a root per session is NORMAL. Sessions are usually independent, and even
 *     within one session a slash command's caveat record has parentUuid: null
 *     and so starts a root of its own.
 *
 * So the pair, not the count, is what gets examined: same cwd, overlapping time
 * ranges, and no shared uuid. Sharing a uuid means dedupe already merged them
 * and there is nothing to warn about; disjoint time ranges mean they are
 * sequential sessions, not a copy of a common prefix. Absent cwd (a redacted
 * fixture) is not evidence, so it warns about nothing.
 */
export function looksForked(graph) {
  const sessions = new Map();
  for (const n of graph.nodes.values()) {
    for (const key of n.sessions) {
      let e = sessions.get(key);
      if (!e) sessions.set(key, (e = { uuids: new Set(), cwds: new Set(), min: Infinity, max: -Infinity }));
      e.uuids.add(n.uuid);
      if (n.record?.cwd) e.cwds.add(n.record.cwd);
      if (n.timestamp) {
        if (n.timestamp < e.min) e.min = n.timestamp;
        if (n.timestamp > e.max) e.max = n.timestamp;
      }
    }
  }
  if (sessions.size < 2) return [];

  const keys = [...sessions.keys()];
  const suspects = new Set();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = sessions.get(keys[i]);
      const b = sessions.get(keys[j]);

      let shares = false;
      for (const u of a.uuids) {
        if (b.uuids.has(u)) {
          shares = true;
          break;
        }
      }
      if (shares) continue; // dedupe already merged them: working as designed

      const sameCwd = [...a.cwds].some((c) => b.cwds.has(c));
      const overlaps = a.min <= b.max && b.min <= a.max;
      if (sameCwd && overlaps) {
        suspects.add(keys[i]);
        suspects.add(keys[j]);
      }
    }
  }
  return [...suspects];
}
