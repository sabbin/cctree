// Phase 3b — the session picker.
//
// Opening straight into a merged tree stops scaling the moment a project has a
// few branches: this one is 24 nodes across 4 sessions and only grows. So the
// TUI opens on a list of conversations, and the tree is what you get after
// choosing one.
//
// The list is not `ls` with nicer columns. ccTree already dedupes by uuid, so it
// can say which sessions are *the same conversation* — a `/branch` copy shares
// its whole prefix — and that relationship is the thing a plain file listing can
// never show you. Pure: entries in, rows out, no I/O.
//
// Direction — which one is the branch — is NOT a subset test, although that is
// the obvious guess. A branch copies its parent's records, so at the moment of
// branching child ⊂ parent; but the parent usually keeps growing, and once it
// outgrows the child the subset points the other way. Measured here: the subset
// rule claimed this session was the ancestor of the very sessions it had been
// branched from. What does hold is that a branch shares its ENTIRE prefix with
// its immediate parent, so among the sessions created before it, the parent is
// the one it shares the most uuids with. That agrees with both branches this
// project witnessed, where `/branch` named the parent explicitly.

/** How long ago, in the shortest form that is still honest. */
function age(ms, now) {
  if (!ms) return '—';
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A conversation reads as its name, with the prompt it left off at trailing
 * behind it. An inherited name is dimmed: it belongs to an ancestor, and looking
 * identical to a name of its own would be a lie about where it came from.
 */
function label(s, width, { DIM, RESET }) {
  const identity = s.divergePrompt ?? s.lastPrompt;
  const tail = truncate(identity, Math.max(16, Math.floor(width / 2)));
  if (!s.name) return truncate(identity, width) || `${DIM}(no prompt)${RESET}`;
  const badge = s.badge && !s.alias ? ` (${s.badge})` : '';
  const name = truncate(s.name, Math.max(16, width - 18 - badge.length));
  // Dimmed when the name belongs to an ancestor: looking identical to a name of
  // its own would misrepresent where it came from.
  const shown = s.nameSource === 'inherited' ? `${DIM}${name}${badge}${RESET}` : `${name}${badge}`;
  return tail ? `${shown}  ${DIM}${tail}${RESET}` : shown;
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The name Claude Code already gave this conversation.
 *
 * Two sidecars carry one, and neither is present on every session: `ai-title` is
 * generated for a normal session, and `/branch` writes `custom-title` instead
 * (`"<first prompt> (Branch 2)"`) while dropping the parent's `ai-title`
 * entirely. Both are keyed by sessionId and appended repeatedly, so the LAST one
 * wins. `custom-title` beats `ai-title` where both exist: it was set
 * deliberately, the other was inferred.
 */
const BRANCH_SUFFIX = /\s*\((Branch(?:\s+\d+)?)\)\s*$/i;
// `/fork` marks its child differently from `/branch`: no `custom-title` at all,
// just the PARENT's `ai-title` with U+2442 (⑂) appended. Measured on a real fork.
// Left in the name it reads as a stray glyph, so it is promoted to a badge for
// the same reason `(Branch)` is — it is the part that distinguishes the arms.
export const FORK_SUFFIX = /\s*\u2442\s*$/;

function titleFrom(records) {
  let ai = null;
  let custom = null;
  for (const r of records) {
    const raw = r.raw;
    if (!raw || r.uuid) continue; // titles are sidecars; a node is never one
    if (typeof raw.customTitle === 'string' && raw.customTitle.trim()) custom = raw.customTitle.trim();
    if (typeof raw.aiTitle === 'string' && raw.aiTitle.trim()) ai = raw.aiTitle.trim();
  }
  return { ai, custom };
}

/**
 * Reduce the two title sidecars to one name plus an optional branch badge.
 *
 * `/branch` writes a `custom-title` of `"<opening prompt> (Branch 2)"`, which is
 * not a title anybody chose — and since every arm of a conversation shares an
 * opening prompt, taking it literally makes four rows read identically while the
 * only distinguishing part, the badge, falls off the end. So an auto-generated
 * custom title is demoted to its badge, and the real name comes from `ai-title`.
 */
function nameFromTitles({ ai, custom }, firstPrompt) {
  const forked = !!ai && FORK_SUFFIX.test(ai);
  if (forked) ai = ai.replace(FORK_SUFFIX, '').trim();
  const badge = custom?.match(BRANCH_SUFFIX)?.[1] ?? (forked ? 'Fork' : null);
  const stripped = custom ? custom.replace(BRANCH_SUFFIX, '').trim() : null;
  // Auto-generated iff what remains is just the opening prompt echoed back.
  const echoesPrompt =
    stripped && firstPrompt && firstPrompt.replace(/\s+/g, ' ').trim().startsWith(stripped.slice(0, 40));
  const chosen = stripped && !echoesPrompt ? stripped : null;
  return { name: chosen ?? ai ?? null, badge, forked };
}

/**
 * @param {{id: string, file: string, records: object[]}[]} entries
 * @param {{now?: number, aliases?: Map<string,string>}} opts
 * @returns {object[]} one row per session, most recently active first
 */
export function describeSessions(entries, { now = 0, aliases = new Map() } = {}) {
  const rows = entries.map((e) => {
    const uuids = new Set();
    let lastActivity = 0;
    const prompts = [];
    for (const r of e.records) {
      if (r.uuid) uuids.add(r.uuid);
      if (r.timestamp && r.timestamp > lastActivity) lastActivity = r.timestamp;
      if (r.kind === 'prompt') prompts.push(r);
    }
    return {
      id: e.id,
      file: e.file,
      // When the file was first written. A branch's records are copies and carry
      // the original timestamps, so only file creation says which came first.
      createdAt: e.createdAt ?? 0,
      uuids,
      prompts: prompts.length,
      firstPrompt: prompts[0]?.preview ?? '',
      // Prompt identity, not just the count: the row label is the first prompt
      // this arm does NOT share with its parent, which needs uuids to find.
      promptList: prompts.map((r) => ({ uuid: r.uuid, preview: r.preview ?? '' })),
      // The LAST prompt is what identifies an arm. Branches of one conversation
      // all share an opening prompt — showing it makes every row look identical,
      // which is exactly the case the picker exists to disambiguate.
      lastPrompt: prompts[prompts.length - 1]?.preview ?? '',
      lastActivity,
      records: e.records.length,
      alias: aliases.get(e.id) ?? null,
      titles: titleFrom(e.records),
      shares: [],
    };
  });

  // Which of these are the same conversation. A `/branch` copy keeps every uuid
  // of the prefix it was cut from, so a non-empty intersection IS the relation —
  // no heuristics, no timestamps, no guessing at direction (the original keeps
  // growing after the branch, so neither side stays a superset for long).
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      let shared = 0;
      const [small, large] =
        rows[i].uuids.size <= rows[j].uuids.size ? [rows[i], rows[j]] : [rows[j], rows[i]];
      for (const u of small.uuids) if (large.uuids.has(u)) shared++;
      if (shared > 0) {
        rows[i].shares.push({ id: rows[j].id, count: shared });
        rows[j].shares.push({ id: rows[i].id, count: shared });
      }
    }
  }

  // Parent = among the sessions created before it, the one it shares the most
  // uuids with. Without creation times there is no direction to be had, and
  // saying nothing beats guessing: `shares` still records the relationship.
  const haveTimes = rows.every((r) => r.createdAt > 0);
  const byAge = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  for (const row of rows) {
    row.parent = null;
    row.children = [];
  }
  if (haveTimes) {
    for (const row of byAge) {
      let best = null;
      for (const other of byAge) {
        if (other === row || other.createdAt >= row.createdAt) continue;
        const share = row.shares.find((sh) => sh.id === other.id);
        if (!share) continue;
        // Most shared prefix wins; a tie goes to the closer ancestor.
        if (!best || share.count > best.count || (share.count === best.count && other.createdAt > best.createdAt)) {
          best = { id: other.id, count: share.count, createdAt: other.createdAt };
        }
      }
      if (best) {
        row.parent = { id: best.id, shared: best.count };
        rows.find((r) => r.id === best.id).children.push(row.id);
      }
    }
  }

  // A fork that has not been used yet has NO records at all — measured: a real
  // `/fork` writes two title sidecars and nothing else until the first prompt
  // lands. With no uuids there is no prefix to share, so the rule above cannot
  // see it and it strands as a root. Its title is the one piece of evidence
  // available, and `/fork` derives it from the parent's verbatim, so an exact
  // match after stripping the glyph is a real link rather than a guess. Scoped
  // as tightly as the evidence: only sessions with nothing else to go on.
  if (haveTimes) {
    const titleOf = (r) => (r.titles.ai ? r.titles.ai.replace(FORK_SUFFIX, '').trim() : null);
    for (const row of rows) {
      if (row.parent || row.uuids.size || !row.titles.ai || !FORK_SUFFIX.test(row.titles.ai)) continue;
      const want = titleOf(row);
      if (!want) continue;
      let best = null;
      for (const other of rows) {
        if (other === row || other.createdAt >= row.createdAt) continue;
        if (other.uuids.size === 0 || titleOf(other) !== want) continue;
        if (!best || other.createdAt > best.createdAt) best = other;
      }
      if (best) {
        row.parent = { id: best.id, shared: 0, via: 'title' };
        best.children.push(row.id);
      }
    }
  }

  // What to call each conversation. A branch has no `ai-title` of its own, so it
  // inherits the nearest ancestor that has one — otherwise every arm of a named
  // conversation would go back to being anonymous.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const own = nameFromTitles(row.titles, row.firstPrompt);
    row.badge = own.badge;
    row.title = own.name;
  }
  for (const row of rows) {
    // A branch has no `ai-title` of its own — `/branch` does not copy it — so it
    // inherits the nearest named ancestor. Without this every arm of a named
    // conversation goes back to being anonymous.
    let inherited = null;
    let hops = 0;
    let cur = row.parent ? byId.get(row.parent.id) : null;
    while (cur && hops++ < 50) {
      if (cur.alias || cur.title) {
        inherited = cur.alias ?? cur.title;
        break;
      }
      cur = cur.parent ? byId.get(cur.parent.id) : null;
    }
    row.inheritedTitle = inherited;
    // Precedence: what you chose, what this session is called, what an ancestor
    // is called, and only then the prompt itself.
    // The badge stays OUT of the name so truncation cannot eat it: with every
    // arm inheriting the same title, `(Branch 2)` is the part that distinguishes
    // them, and it lives at the end where a truncator would reach it first.
    row.name = row.alias ?? row.title ?? inherited ?? '';
    row.nameSource = row.alias ? 'alias' : row.title ? 'title' : inherited ? 'inherited' : 'prompt';
  }

  // What the row shows. Neither end of the prompt list identifies an arm: every
  // branch of one conversation opens with the SAME prompt, and the last prompt
  // only says where it happened to stop. What distinguishes an arm is where it
  // left its parent — the first prompt it does not share — which for a root is
  // simply its opening prompt, the thing you recognise a conversation by.
  const byIdForDiverge = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const parent = row.parent ? byIdForDiverge.get(row.parent.id) : null;
    const diverged = parent ? row.promptList.find((p) => !p.uuid || !parent.uuids.has(p.uuid)) : null;
    // Three cases, and the third is easy to miss. A branch that was cut but
    // never continued shares EVERY prompt with its parent, so it has no
    // divergence to show and falling back to the opening prompt makes it
    // identical to every other arm — the exact failure this replaced. Its last
    // prompt is the point it was cut at, which is both distinct between such
    // branches and the only thing that actually describes one.
    const fallback = parent ? row.promptList[row.promptList.length - 1] : row.promptList[0];
    row.divergePrompt = (diverged ?? fallback)?.preview ?? '';
    row.divergedFromParent = !!diverged;
  }

  rows.sort((a, b) => b.lastActivity - a.lastActivity);
  for (const r of rows) r.ageLabel = age(r.lastActivity, now);
  return rows;
}

/**
 * Render the picker as a forest. Pure — returns rows tagged with the session
 * they carry, the same shape the tree view uses, so selection and scrolling are
 * written once for both views.
 *
 * Drawing the parentage means the `branch of X` / `N branches` labels become
 * redundant, and the width they used goes to the prompt preview instead. Roots
 * are ordered by recent activity (you are usually looking for the conversation
 * you just left); children by creation, so a fork reads in the order it
 * happened. Without creation times nothing has a parent, and this degrades to
 * the flat list it started as.
 *
 * @returns {{text: string, id: string|null}[]}
 */
export function renderSessionRows(sessions, { color = false, width = 100 } = {}) {
  const DIM = color ? '\x1b[2m' : '';
  const CYAN = color ? '\x1b[36m' : '';
  const GREEN = color ? '\x1b[32m' : '';
  const RESET = color ? '\x1b[0m' : '';
  if (!sessions.length) return [{ text: '  no transcripts for this directory', id: null }];

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const latest = sessions.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a), sessions[0]);

  // Depth-first, carrying the vertical bars of the ancestors still to be closed.
  const ordered = [];
  const seen = new Set();
  const walk = (node, prefix, isLast, depth) => {
    if (!node || seen.has(node.id)) return; // a cycle cannot happen, but never hang
    seen.add(node.id);
    ordered.push({
      node,
      prefix: depth === 0 ? '' : `${prefix}${isLast ? '└─' : '├─'}`,
    });
    const kids = (node.children ?? [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt);
    const childPrefix = depth === 0 ? '' : `${prefix}${isLast ? '  ' : '│ '}`;
    kids.forEach((kid, i) => walk(kid, childPrefix, i === kids.length - 1, depth + 1));
  };

  const roots = sessions.filter((s) => !s.parent).sort((a, b) => b.lastActivity - a.lastActivity);
  roots.forEach((r) => walk(r, '', true, 0));
  // Anything unreachable (a parent that is not in this listing) is still shown.
  for (const s of sessions) if (!seen.has(s.id)) walk(s, '', true, 0);

  // The connector must sit immediately left of the id it points at, so the pad
  // goes AFTER the id: padding the prefix itself strands the elbow mid-gutter.
  const prefixW = Math.max(...ordered.map((o) => o.prefix.length));
  const ageW = Math.max(3, ...sessions.map((s) => s.ageLabel.length));
  const promptW = Math.max(...sessions.map((s) => String(s.prompts).length));
  const used = 2 + prefixW + 8 + 2 + ageW + 4 + 2 + promptW + 8 + 2;
  const previewW = Math.max(20, width - used - 10);

  return ordered.map(({ node: s, prefix }) => {
    // The only label left is the one that says direction is unknowable here.
    const rel =
      s.createdAt === 0 && s.shares.length ? `${DIM}  shares history with ${s.shares.length}${RESET}` : '';
    const mark = s.id === latest.id ? `${GREEN}  ← latest${RESET}` : '';
    const text =
      `  ${DIM}${prefix}${RESET}` +
      `${CYAN}${s.id.slice(0, 8)}${RESET}` +
      `${' '.repeat(prefixW - prefix.length)}` +
      `  ${DIM}${s.ageLabel.padStart(ageW)} ago${RESET}` +
      `  ${String(s.prompts).padStart(promptW)} prompts` +
      `  ${label(s, previewW, { DIM, RESET })}` +
      rel +
      mark;
    return { text, id: s.id };
  });
}
