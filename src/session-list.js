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

import { PLAIN, makePalette, vlen } from './palette.js';

/**
 * The column headings. `prompts` doubles as the minimum width of its column, so
 * the counts right-align under the word that names them.
 */
const HEAD = { id: 'ID', age: 'AGE', prompts: 'PROMPTS', name: 'CONVERSATION' };

/** The single space between the name column and the preview column. */
const GAP_NAME = 1;

// The preview is clamped at both ends: below 20 it says nothing, and above 72 —
// about a line of prose — it stops being a scan target and becomes a wall.
const PREVIEW_MIN = 20;
const PREVIEW_MAX = 72;
// Past 34 a name is eating width the preview needs more; below 4 characters of
// name the column has stopped saying anything the badge does not.
const NAME_MAX = 34;
const NAME_MIN = 4;

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
 * The name cell: what this conversation is called, and what kind of arm it is.
 *
 * An inherited name used to be dimmed wholesale, which cost twice over: dim plus
 * truncation makes a name genuinely hard to read, and the badge — the ONLY part
 * that tells two arms of one conversation apart — inherited the dimming with it.
 * So the provenance moves to a `↳` glyph, which says "borrowed from an ancestor"
 * in two columns without spending the name's legibility, and the badge steps out
 * of the dimming to carry a colour of its own: branch (this arm differs here) or
 * graft (history was transplanted).
 *
 * @param {object} pal palette from `makePalette`; identity at depth 0
 * @param {number} w visible columns available, or Infinity to measure natural width
 */
function nameParts(s, pal) {
  if (!s.name) return { lead: '', badge: '', fixed: 0, natural: 0 };
  // An alias is what you chose to call it, so it carries neither provenance
  // glyph nor badge: there is nothing borrowed about it.
  const badgeText = s.badge && !s.alias ? ` (${s.badge})` : '';
  const badge = badgeText ? (FORK_BADGE.test(s.badge) ? pal.graft(badgeText) : pal.branch(badgeText)) : '';
  const lead = s.nameSource === 'inherited' ? pal.faint('↳ ') : '';
  // Everything measured with vlen — both pieces carry escape codes, and at
  // truecolor an escape is 19 characters that occupy no columns at all.
  const fixed = vlen(lead) + vlen(badge);
  return { lead, badge, fixed, natural: fixed + s.name.length };
}

function nameCell(s, pal, w = Infinity) {
  const { lead, badge, fixed } = nameParts(s, pal);
  if (!s.name) return '';
  // The badge is protected: truncation eats the name, never the qualifier, since
  // the qualifier is the part that tells two arms of one conversation apart. The
  // column is sized to guarantee the room (see NAME_MIN), so this floor is only
  // ever reached on a terminal too narrow for the picker to be much use anyway.
  const room = w === Infinity ? Infinity : Math.max(NAME_MIN, w - fixed);
  return `${lead}${truncate(s.name, room)}${badge}`;
}

/**
 * The preview cell: the prompt that says where this arm went.
 *
 * Neither end of the prompt list identifies an arm — see `describeSessions` —
 * so this is the divergence prompt, falling back to the last one.
 */
function previewCell(s, pal, w) {
  const identity = s.divergePrompt ?? s.lastPrompt;
  const text = truncate(identity, w);
  if (!text) return s.name ? '' : pal.faint('(no prompt)');
  return pal.machine(text);
}

/** Which badges mean "transplanted history" rather than "another arm". */
const FORK_BADGE = /fork/i;

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
        // Most shared prefix wins. A TIE goes to the OLDER candidate, which is
        // the opposite of the obvious guess and is the whole point: if a child
        // shares exactly the same uuids with two sessions, it was cut at or
        // before the point where those two diverge from EACH OTHER — so it is a
        // sibling of the younger one, not its descendant. Attaching to their
        // common ancestor is what makes them siblings on screen.
        //
        // Measured: branching twice from one conversation gives both copies the
        // same 12-uuid prefix, and "closer ancestor" nested the second copy
        // under the first, which was never its parent.
        if (!best || share.count > best.count || (share.count === best.count && other.createdAt < best.createdAt)) {
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
 * Every file in one conversation: the root of `file`'s family, and everything
 * descended from it. Pure — reads the `parent`/`children` links
 * `describeSessions` already worked out.
 *
 * The whole component, not just this session's own children, because that is
 * what "the tree" means: from a branch you want the trunk you left AND the
 * siblings you left it beside. Oldest first, so a caller merging them still
 * resolves HEAD to the newest file.
 *
 * @returns {string[]|null} null when `file` is not one of these sessions
 */
export function familyFiles(sessions, file) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let root = sessions.find((s) => s.file === file);
  if (!root) return null;
  const climbed = new Set();
  while (root.parent && byId.has(root.parent.id) && !climbed.has(root.id)) {
    climbed.add(root.id);
    root = byId.get(root.parent.id);
  }
  const out = [];
  const walk = (node) => {
    if (!node || out.includes(node)) return; // a cycle cannot happen, but never hang
    out.push(node);
    for (const id of node.children ?? []) walk(byId.get(id));
  };
  walk(root);
  return out.sort((a, b) => a.createdAt - b.createdAt).map((s) => s.file);
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
export function renderSessionRows(
  sessions,
  { color = false, palette = null, width = 100, group = true, selected = null } = {},
) {
  // The renderer never builds an escape: it is handed a palette and calls it.
  // `color: true` resolves to the 16-colour tier, which is what the tests and
  // any caller with no depth detection get.
  const pal = palette ?? (color ? makePalette(4) : PLAIN);
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
      depth,
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
  // That is why prefix and id are ONE field here rather than two.
  const prefixW = Math.max(...ordered.map((o) => o.prefix.length));
  const ageW = Math.max(3, ...sessions.map((s) => s.ageLabel.length));
  // Wide enough for the column header, so the counts right-align under the word
  // that names them. The header is what lets the row drop the literal
  // " prompts", which cost more columns than this floor does.
  const promptsW = Math.max(HEAD.prompts.length, ...sessions.map((s) => String(s.prompts).length));

  // Everything left of the name, per the column table. `used` deliberately stops
  // there, because the name column is the one that varies with the data.
  const USED_MAX = 2 + prefixW + 8 + 2 + ageW + 2 + promptsW + 2;

  // The name gets a column of its own so every preview starts at the same screen
  // column. Without it the previews form a ragged second column and the eye has
  // nothing to return to — invisible at 100 cols, the dominant defect at 200.
  // Capped at 34: past that a name is eating width the preview needs more.
  // Capped three ways: by NAME_MAX, by the longest name there actually is, and
  // by what the row can afford — a long name on a narrow terminal gives way to
  // the preview rather than pushing the row past the screen edge.
  //
  // With one exception, and it is the whole reason this is not a one-liner: the
  // `↳` and the badge cannot be truncated (§1.3), so a column narrower than
  // those plus a few characters of name would overflow and take the preview
  // column with it. Below that point the PREVIEW yields instead, down to
  // nothing — a ragged column is a worse failure than a short one.
  const parts = ordered.map((o) => nameParts(o.node, pal));
  const natural = Math.max(0, ...parts.map((n) => n.natural));
  const floor = Math.max(0, ...parts.map((n) => (n.natural ? n.fixed + NAME_MIN : 0)));
  const affordable = width - USED_MAX - GAP_NAME - PREVIEW_MIN;
  const nameW = Math.max(0, Math.min(NAME_MAX, natural, Math.max(floor, affordable)));

  // Clamped, not merely floored: on a 200-column terminal an unclamped preview
  // runs past 120 characters, which is not a scan target, it is a wall. 72 is
  // about a line of prose. What is left over stays empty — the right margin is
  // what lets the column read as a column.
  // PREVIEW_MIN is a goal, not a floor: when the name column had to keep its
  // badge the remaining width is whatever is left, and 0 is a legitimate answer.
  const previewW = Math.max(0, Math.min(PREVIEW_MAX, width - USED_MAX - nameW - GAP_NAME));

  /** One field: pad to `w` by VISIBLE width, since the text may carry escapes. */
  const cell = (text, w, align = 'left') => {
    const fill = ' '.repeat(Math.max(0, w - vlen(text)));
    return align === 'right' ? `${fill}${text}` : `${text}${fill}`;
  };

  /**
   * The column table, and the only place row geometry is decided.
   *
   * The header is laid out by this same function, so a field cannot pad itself
   * one way in a row and another way in the header — which is exactly how the
   * spacing drifted when each field padded independently.
   *
   * A row with no name lets the preview start in the name column, so the two
   * merge into one field rather than leaving a hole where a name would be.
   */
  const layout = ({ gutter = '', id = '', age = '', prompts = '', name = null, preview = '' }) => {
    const fields = [
      [cell(gutter, 2)],
      [cell(id, prefixW + 8)],
      ['  '],
      [cell(age, ageW, 'right')],
      ['  '],
      [cell(prompts, promptsW, 'right')],
      ['  '],
    ];
    if (name === null) fields.push([cell(preview, nameW + GAP_NAME + previewW)]);
    else {
      fields.push([cell(name, nameW)]);
      if (nameW) fields.push([' '.repeat(GAP_NAME)]);
      fields.push([cell(preview, previewW)]);
    }
    return fields.map(([t]) => t).join('').trimEnd();
  };

  const out = [
    {
      text: pal.machine(
        layout({ id: HEAD.id, age: HEAD.age, prompts: HEAD.prompts, name: HEAD.name, preview: '' }),
      ),
      id: null, // unselectable, like the connector rows in the tree view
    },
  ];

  return out.concat(
    ordered.flatMap(({ node: s, prefix, depth }, i) => {
      // A blank line between top-level conversations, and only there — a parent
      // and its branches are one thing and must stay visually joined. The gap
      // marks where a family ends, so it is spent only where there is a family
      // on one side of it: with no creation times nothing has a parent, and a
      // gap between every row would double the list to show structure that is
      // not there. The option exists so a piped listing can turn it off.
      const family = s.children?.length || ordered[i - 1]?.depth > 0;
      const gap = group && depth === 0 && i > 0 && family ? [{ text: '', id: null }] : [];
      return gap.concat(rowFor(s, prefix));
    }),
  );

  function rowFor(s, prefix) {
    // The one label left is the one that says direction is unknowable here. It
    // is spent from the preview's own budget: the preview is left-aligned, so
    // shortening it moves nothing, while appending past the column would.
    const rel =
      s.createdAt === 0 && s.shares.length ? pal.machine(`  shares history with ${s.shares.length}`) : '';
    const name = nameCell(s, pal, nameW);
    // A nameless row lets the preview start in the name column, so it is budgeted
    // for both columns at once rather than truncating at a boundary that is not
    // being drawn.
    // Capped at PREVIEW_MAX either way: starting in the name column moves where
    // the preview begins, not how long a line of prose is worth reading.
    const room = Math.min(PREVIEW_MAX, name ? previewW : nameW + GAP_NAME + previewW) - vlen(rel);
    const preview = previewCell(s, pal, Math.max(8, room));

    // The most recently active conversation is the one you are most often
    // looking for, and a `← latest` marker appended after the preview was the
    // first thing a narrow terminal ate — the one row you wanted to find was the
    // one whose marker disappeared. So it moves to the two places truncation
    // cannot reach: the gutter (the same column the tree marks its selection in)
    // and the id itself, in the colour that means "you are here".
    const isLatest = s.id === latest.id;
    const isSel = selected != null && s.id === selected;
    // `▸` is the selection signal at EVERY tier — with no colour at all it is
    // the only one there is, which is why it lives in the gutter and not in a
    // background the 16-colour tier cannot paint.
    const gutter = isSel ? '▸' : isLatest ? pal.head('▸') : '';
    const short = s.id.slice(0, 8);
    return {
      text: layout({
        gutter,
        id: `${pal.faint(prefix)}${isLatest ? pal.head(short) : pal.machine(short)}`,
        age: pal.machine(s.ageLabel),
        prompts: String(s.prompts),
        name: name || null,
        preview: `${preview}${rel}`,
      }),
      id: s.id,
    };
  }
}
