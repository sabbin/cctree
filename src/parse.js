// Phase 0 — tolerant transcript reader.
//
// Contract: never throw on a transcript. Unknown record kinds, missing fields,
// truncated final lines and outright garbage all degrade to a record we can
// still place in the graph (or to a logged issue), never to a crash.
//
// Retained fields per the spec: uuid, parentUuid, type, timestamp, plus any
// checkpoint reference we can find. Everything else stays in `raw` and opaque.

import { readFileSync } from 'node:fs';

const CHECKPOINT_KEY = /checkpoint|snapshot|restore|filehistory|commit/i;

// Slash commands do not arrive as one record. A single `/foo` expands into a run
// of user-role records — a caveat, the invocation, and the captured stdout — each
// wrapped in one of these tags. Surveyed against 2.1.226; see the note in
// isCommandPlumbing() for why presence of a tag is NOT the test.
export const PLUMBING_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
];

const TAG_ALT = PLUMBING_TAGS.join('|');
const PLUMBING_ANY = new RegExp(`<(?:${TAG_ALT})\\b`, 'i');
// Paired block, self-closing, then unterminated-to-end-of-string. The last
// alternative matters: a transcript's final line can be half-flushed while the
// session is live, and a half-written tag must still strip cleanly.
const PLUMBING_STRIP = new RegExp(
  `<(${TAG_ALT})\\b[^>]*>[\\s\\S]*?<\\/\\1>` +
    `|<(?:${TAG_ALT})\\b[^>]*\\/>` +
    `|<(?:${TAG_ALT})\\b[^>]*>[\\s\\S]*$`,
  'gi',
);

/** Concatenated plain text of a message body, whatever shape it arrived in. */
function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function stripPlumbing(text) {
  return String(text).replace(PLUMBING_STRIP, '').trim();
}

/**
 * Is this record nothing but slash-command machinery?
 *
 * The obvious test — "contains <command-name>" — is wrong, and wrong in a way
 * that eats real data. A typed prompt can embed a slash-command expansion: this
 * project's own opening prompt is 1424 characters of which 707 survive
 * stripping, and tag-presence detection silently discards it. So the test is
 * whether anything the human wrote SURVIVES stripping. Human-origin markers
 * (`promptSource`, `origin.kind`) are absent on all plumbing records and
 * present on all real prompts, so they override outright.
 */
function isCommandPlumbing(raw) {
  if (raw?.promptSource === 'typed' || raw?.origin?.kind === 'human') return false;
  const text = plainText(raw?.message?.content);
  if (!text || !PLUMBING_ANY.test(text)) return false;
  return stripPlumbing(text) === '';
}

/** Classify a record for display without depending on undocumented shapes. */
function classify(raw) {
  const type = typeof raw?.type === 'string' ? raw.type : 'unknown';

  // Checked ahead of the no-uuid gate below: summaries also carry no uuid, but
  // they carry `leafUuid` and already have a consumer that attaches them to it.
  if (type === 'summary') return 'summary';

  // The tree is uuid-linked, so a record with no uuid can never be another
  // record's parent and therefore cannot be a node. Every session-level state
  // record looks like this — mode, permission-mode, ai-title, last-prompt,
  // file-history-snapshot — 38% of a real transcript. Gating on shape rather
  // than a type allowlist means a sidecar kind invented by a future release
  // lands here automatically instead of rendering as an orphan row.
  if (typeof raw?.uuid !== 'string') return 'sidecar';

  if (raw?.isCompactSummary === true) return 'compact';
  if (raw?.subtype === 'compact_boundary') return 'compact';

  // Role first. `type` has already grown values outside user/assistant/system/
  // summary (attachment, plus five sidecar kinds), so dispatching on it is how
  // the classifier fell behind in the first place. `message.role` has stayed
  // stable, and a future rename of `type` that keeps the message shape should
  // not cost us the whole tree. `type` is only the fallback now.
  const content = raw?.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const has = (t) => blocks.some((b) => b && b.type === t);
  const role = raw?.message?.role;

  if (role === 'assistant' || (role === undefined && type === 'assistant')) {
    return has('tool_use') ? 'tool_use' : 'assistant';
  }
  if (role === 'user' || (role === undefined && type === 'user')) {
    if (has('tool_result')) return 'tool_result';
    // Before isMeta: the caveat record carries both, and grouping all three
    // plumbing records under one kind lets a whole /command collapse to one row.
    if (isCommandPlumbing(raw)) return 'command';
    if (raw?.isMeta === true) return 'meta';
    return 'prompt';
  }

  // No usable role. Attachments are in-chain machinery with no `message` at all
  // (uuid, parentUuid and timestamp are all present), so they are real nodes —
  // detected by shape, since `attachment` as a `type` value is undocumented.
  if (raw?.attachment && typeof raw.attachment === 'object') return 'attachment';
  if (type === 'system') return 'system';
  return 'unknown';
}

/** The finer-grained flavour, where a kind has one. Never content. */
function subkind(raw, kind) {
  if (kind === 'sidecar') return typeof raw?.type === 'string' ? raw.type : 'unknown';
  if (kind === 'attachment') {
    return typeof raw?.attachment?.type === 'string' ? raw.attachment.type : 'unknown';
  }
  return null;
}

/** Best-effort one-line preview. Never assumes a shape. */
function preview(raw, kind) {
  const content = raw?.message?.content;

  if (kind === 'summary' && typeof raw?.summary === 'string') return raw.summary;
  // Sidecar previews stay at the type name on purpose: `lastPrompt` and
  // `aiTitle` are content, and nothing that leaves this function should be.
  if (kind === 'sidecar' || kind === 'attachment') return subkind(raw, kind);
  if (kind === 'command') {
    const text = plainText(content);
    const name = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
    if (name) return name[1];
    const tag = text.match(new RegExp(`<(${TAG_ALT})\\b`, 'i'));
    return tag ? tag[1] : 'command';
  }

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const names = content
      .filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => b.name);
    if (names.length) return names.join(', ');

    const t = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (t) text = t.text;
    else if (content.some((b) => b && b.type === 'tool_result')) return 'tool result';
  }

  // A real prompt may carry an embedded expansion (see isCommandPlumbing).
  // Preview what the human wrote, not the caveat boilerplate in front of it.
  if (kind === 'prompt') {
    const residual = stripPlumbing(text);
    if (residual) text = residual;
    else {
      const cmd = String(text).match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
      if (cmd) return cmd[1];
    }
  }

  return String(text).replace(/\s+/g, ' ').trim();
}

/** Any key that smells like a checkpoint/working-tree reference (phase 5 fodder). */
function checkpointRefs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const found = {};
  for (const [k, v] of Object.entries(raw)) {
    if (CHECKPOINT_KEY.test(k) && v != null && typeof v !== 'object') found[k] = v;
  }
  return Object.keys(found).length ? found : null;
}

/**
 * Tool-call identity, kept so the graph can tell a turn's own result apart from
 * the next tool call of the same turn. Both are children of the same record and
 * only these ids distinguish them; see linearizeTurns() in graph.js.
 */
function toolIds(raw) {
  const content = raw?.message?.content;
  if (!Array.isArray(content)) return { uses: null, resultFor: null };
  const uses = [];
  const resultFor = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use' && typeof b.id === 'string') uses.push(b.id);
    else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultFor.push(b.tool_use_id);
  }
  return { uses: uses.length ? uses : null, resultFor: resultFor.length ? resultFor : null };
}

function normalize(raw, { line, file }) {
  const kind = classify(raw);
  const tools = toolIds(raw);
  return {
    uuid: typeof raw?.uuid === 'string' ? raw.uuid : null,
    parentUuid: typeof raw?.parentUuid === 'string' ? raw.parentUuid : null,
    type: typeof raw?.type === 'string' ? raw.type : 'unknown',
    kind,
    subkind: subkind(raw, kind),
    timestamp: Date.parse(raw?.timestamp) || null,
    // Contextual, all optional — absence is never an error.
    sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : null,
    cwd: typeof raw?.cwd === 'string' ? raw.cwd : null,
    gitBranch: typeof raw?.gitBranch === 'string' ? raw.gitBranch : null,
    version: typeof raw?.version === 'string' ? raw.version : null,
    isSidechain: raw?.isSidechain === true,
    leafUuid: typeof raw?.leafUuid === 'string' ? raw.leafUuid : null,
    // One API request. An assistant cannot branch inside one, which is what
    // makes a fork within a single requestId provably an artifact.
    requestId: typeof raw?.requestId === 'string' ? raw.requestId : null,
    toolUseIds: tools.uses,
    toolResultFor: tools.resultFor,
    checkpoint: checkpointRefs(raw),
    preview: preview(raw, kind),
    file,
    line,
    raw,
  };
}

/**
 * Parse one .jsonl transcript.
 * @returns {{records: object[], issues: object[], file: string}}
 */
export function parseTranscript(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { records: [], issues: [{ file, line: 0, reason: `unreadable: ${err.code || err.message}` }], file };
  }
  return parseText(text, file);
}

export function parseText(text, file = '<memory>') {
  const records = [];
  const issues = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      // A partially-flushed last line is normal while a session is live.
      issues.push({
        file,
        line: i + 1,
        reason: i === lines.length - 1 ? 'truncated final line (session may be live)' : 'malformed json',
      });
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ file, line: i + 1, reason: 'not an object' });
      continue;
    }
    records.push(normalize(raw, { line: i + 1, file }));
  }

  return { records, issues, file };
}

/** Format-drift canary: what kinds did we see, and how many had no uuid? */
export function stats(records) {
  const kinds = {};
  const types = {};
  const subkinds = {};
  let noUuid = 0;
  let noTimestamp = 0;
  const versions = new Set();
  for (const r of records) {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    types[r.type] = (types[r.type] || 0) + 1;
    if (r.subkind) subkinds[r.subkind] = (subkinds[r.subkind] || 0) + 1;
    if (!r.uuid) noUuid++;
    if (!r.timestamp) noTimestamp++;
    if (r.version) versions.add(r.version);
  }
  // `unknown` is the drift signal to watch: it means a record has a uuid, so it
  // belongs in the tree, but nothing about its shape said what it is.
  return { total: records.length, kinds, types, subkinds, noUuid, noTimestamp, versions: [...versions] };
}
