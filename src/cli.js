import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseTranscript, stats, PLUMBING_TAGS, stripPlumbing, promptText } from './parse.js';
import { planBranch, planBranchTo, buildBranchText } from './branch.js';
import { readAliases, setAlias, STORE_FILE } from './store.js';
import { buildGraph, annotate, collapse, looksForked, headOf } from './graph.js';
import { assignLanes } from './lanes.js';
import { renderAscii, renderAsciiRows, renderHeader } from './render-ascii.js';
import { colorDepth, makePalette } from './palette.js';
import { runTui } from './tui.js';
import { projectDir, listSessions, listSubagents, resolveSession, byCreation } from './sessions.js';
import { describeSessions, familyFiles, renderSessionRows } from './session-list.js';
import { inheritedFor, forkStubs } from './fork-context.js';

const USAGE = `cctree — a git-style graph over Claude Code transcripts

  cctree show [session] [--family | --all] [--raw] [--no-color] [--issues] [--width N] [--json]
      Render the conversation tree. Default session is the most recently
      touched one for the current directory. --family adds the session's
      /branch relatives, as the TUI's f does. --all merges every session in
      the project so /branch copies appear as one tree. --json emits the rows
      with the node each one carries, for callers that act on a selection.

  cctree sessions [--json]
      List transcripts for the current directory. --json emits the TUI
      picker's rows: conversations as a tree, branches under their parent.

  cctree stats [session]
      Record-kind histogram and parser issues. Run this first after a
      Claude Code upgrade — it is the format-drift canary.

  cctree fixture <session> [--out FILE]
      Emit a redacted skeleton (structure only, no content) for test/fixtures.

  cctree tui [session] [--all] [--raw] [--once] [--select N|uuid] [--pane]
      Opens on the list of conversations in this directory; enter opens one as a
      tree, esc goes back, a merges them all. In a tree: arrows/jk move, enter
      toggles detail, b branches at the selected prompt, o resumes, r refreshes,
      q quits. Redraws as the transcript grows, so it can live in a tmux split.
      Naming a session, --all or --select skips straight to the tree. --once
      prints a single frame, for when there is no terminal.

  cctree name [session] [alias] [--clear]
      Give a conversation a name of your own. With no alias, shows the current
      one. Stored in ~/.cctree/sessions.json, never in the transcript — Claude
      Code's own ai-title/custom-title are read but never written.

  cctree branch [session] (--at N | --to UUID | --before UUID) [--dry-run] [--json]
      Create a new session containing everything before prompt #N, so you can
      ask #N differently. Rewind semantics: #N and everything after it is left
      behind. Writes a NEW transcript and never modifies the original; prints
      the claude -r command to enter it.
      --to UUID ends the new session ON that node, on whichever arm it sits;
      --before UUID ends it on the node's parent, to ask that prompt again.

Options:
  --cwd DIR     treat DIR as the project working directory
  --raw         do not collapse assistant/tool runs into single nodes
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) flags[key] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function loadFiles(files, { raw = false } = {}) {
  let records = [];
  const issues = [];
  for (const f of files) {
    const p = parseTranscript(f);
    records.push(...p.records);
    issues.push(...p.issues);
  }
  // An unused `/fork` has no records of its own; borrow the parent's, tagged.
  // Only ever for a single file: in a merged view the parent is already there —
  // and there, the fork gets a placed stub instead so it still has a limb.
  const inherited = files.length === 1 ? inheritedFor(files[0], records) : null;
  if (inherited) records = inherited.records;
  else records = records.concat(forkStubs(files, records));

  const graph = annotate(buildGraph(records), { headUuid: headOf(records) });
  collapse(graph, { enabled: !raw });
  annotate(graph, { headUuid: graph.head });
  if (inherited) {
    graph.inheritedFrom = { parentId: inherited.parentId, count: inherited.records.length };
  }
  return { graph, issues, records };
}

function cmdSessions(flags) {
  const cwd = flags.cwd || process.cwd();
  // The picker as rows, for the Claude Code pane: the same forest the TUI
  // opens on, each row tagged with the session it carries.
  // Each row also says where it hangs and how much hangs under it, so a caller
  // can fold a conversation's branches away: hiding a row's descendants leaves
  // every other row's `├─`/`└─` exactly right, so nothing has to be re-drawn.
  if (flags.json) {
    const palette = makePalette(flags.color === false || flags.noColor ? 0 : colorDepth());
    const sessions = describeProject(cwd);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const under = (s, seen = new Set()) => {
      let n = 0;
      for (const id of s.children ?? []) {
        if (seen.has(id) || !byId.has(id)) continue; // a cycle cannot happen, but never hang
        seen.add(id);
        n += 1 + under(byId.get(id), seen);
      }
      return n;
    };
    const rows = renderSessionRows(sessions, { palette, width: Number(flags.width) || 100 }).map((r) => {
      const s = r.id ? byId.get(r.id) : null;
      return s ? { ...r, parent: s.parent?.id ?? null, descendants: under(s), alias: s.alias } : r;
    });
    return console.log(JSON.stringify({ rows }));
  }
  const dir = projectDir(cwd);
  if (!dir) {
    console.error(`no transcripts found for ${cwd}`);
    process.exit(1);
  }
  console.log(dir);
  for (const s of listSessions(dir)) {
    const age = Math.round((Date.now() - s.mtime) / 60000);
    console.log(`  ${s.id}  ${String(Math.round(s.size / 1024)).padStart(6)}K  ${age}m ago`);
  }
  const subs = listSubagents(dir);
  if (subs.length) console.log(`  (${subs.length} subagent sidechains)`);
}

/** Every session in the project, described the way the picker draws them. */
function describeProject(cwd) {
  const dir = projectDir(cwd);
  const entries = (dir ? listSessions(dir) : []).map((s) => ({
    id: s.id,
    file: s.path,
    records: parseTranscript(s.path).records,
    // Only the filesystem knows which session was created first: a branch's
    // records are verbatim copies and carry the original timestamps.
    createdAt: s.birth,
  }));
  return describeSessions(entries, { now: Date.now(), aliases: readAliases() });
}

/** Which transcripts a command should read, and what to call them. */
function resolveFiles(positional, flags) {
  const cwd = flags.cwd || process.cwd();
  if (flags.all) {
    const dir = projectDir(cwd);
    if (!dir) fail(`no transcripts found for ${cwd}`);
    const files = byCreation(listSessions(dir)).map((s) => s.path);
    return { files, title: `${dir} (${files.length} sessions)` };
  }
  const s = resolveSession(positional[0], cwd);
  if (!s) fail(`no transcript found for ${positional[0] || cwd}`);
  // The conversation this transcript belongs to: its `/branch` ancestors and
  // descendants, which is what the TUI's `f` opens. A branch copy holds its
  // whole prefix, so on its own it draws a straight line through the split
  // that made it — accurate, and exactly the thing you opened the tree to see.
  if (flags.family) {
    const family = familyFiles(describeProject(cwd), s.path);
    if (family && family.length > 1) return { files: family, title: `${s.path} (${family.length} sessions)` };
  }
  return { files: [s.path], title: s.path };
}

function cmdTui(positional, flags) {
  const cwd = flags.cwd || process.cwd();
  const dir = projectDir(cwd);
  // Oldest-CREATED first, so the original keeps the trunk when they are merged.
  const allFiles = dir ? byCreation(listSessions(dir)).map((s) => s.path) : [];

  // The picker is the default entry point: a merged tree is unreadable once a
  // project has a few branches. Naming a session, asking for --all, or aiming
  // with --select all mean the caller already knows what they want to look at.
  let files = null;
  let view = 'sessions';
  if (positional[0]) {
    const s = resolveSession(positional[0], cwd);
    if (!s) fail(`no transcript found for ${positional[0]}`);
    files = [s.path];
    view = 'tree';
  } else if (flags.all) {
    files = allFiles;
    view = 'tree';
  } else if (flags.select != null) {
    const s = resolveSession(undefined, cwd);
    if (!s) fail(`no transcript found for ${cwd}`);
    files = [s.path];
    view = 'tree';
  }
  if (!allFiles.length && !files) fail(`no transcripts found for ${cwd}`);

  // Re-read from disk on every load so `r`, the file watcher and switching
  // views all see a live session grow. Transcripts are small enough that
  // incremental parsing would be complexity without a payoff.
  const load = (fileList) => {
    const list = fileList && fileList.length ? fileList : allFiles;
    const recordsByFile = new Map();
    let records = [];
    for (const f of list) {
      const p = parseTranscript(f);
      recordsByFile.set(f, p.records);
      records.push(...p.records);
    }
    const inherited = list.length === 1 ? inheritedFor(list[0], records) : null;
    if (inherited) records = inherited.records;
    else records = records.concat(forkStubs(list, records));
    const graph = annotate(buildGraph(records), { headUuid: headOf(records) });
    collapse(graph, { enabled: !flags.raw });
    annotate(graph, { headUuid: graph.head });
    if (inherited) {
      graph.inheritedFrom = { parentId: inherited.parentId, count: inherited.records.length };
    }
    const title = list.length === 1 ? list[0] : `${dir} (${list.length} sessions)`;
    return { graph, recordsByFile, title, files: list };
  };

  try {
    runTui(load, {
      once: !!flags.once,
      select: flags.select ?? null,
      emit: typeof flags.emit === 'string' ? flags.emit : null,
      view,
      // Detail docked right rather than a line under the keybar. Needs 120
      // columns; refused below that, never squeezed.
      pane: !!flags.pane,
      files,
      allFiles,
    });
  } catch (err) {
    fail(err.message);
  }
}

function cmdShow(positional, flags) {
  const { files, title } = resolveFiles(positional, flags);
  const { graph, issues } = loadFiles(files, { raw: !!flags.raw });
  const lanes = assignLanes(graph);
  // Colour depth is decided here, at the I/O boundary, and handed to the
  // renderer as data — asking the terminal anything inside a renderer is what
  // would stop it being pure. `--no-color` is the explicit override; everything
  // else (NO_COLOR, a pipe, COLORTERM, TERM) `colorDepth` already knows about.
  const forced = flags.color === false || flags.noColor === true;
  const palette = makePalette(forced ? 0 : colorDepth());

  if (flags.json) return console.log(JSON.stringify(showJson(graph, lanes, { palette, title, width: Number(flags.width) || 0 })));

  console.log(renderHeader(graph, lanes, { file: title }));
  console.log('');
  // `--width` is for callers that are not a terminal but know their width — the
  // Claude Code panel, which renders this output into a pane of its own size.
  console.log(renderAscii(graph, lanes, { palette, width: Number(flags.width) || 0 }));

  const forkWarn = flags.all ? looksForked(graph) : [];
  if (forkWarn.length > 1) {
    console.log(`\n! ${forkWarn.length} disconnected roots — uuids may not survive /branch (spec §10)`);
  }
  if (issues.length && flags.issues) {
    console.log(`\n${issues.length} parse issues:`);
    for (const i of issues.slice(0, 20)) console.log(`  ${i.file}:${i.line} ${i.reason}`);
  } else if (issues.length) {
    console.log(`\n${issues.length} parse issues (--issues to list)`);
  }
}

/**
 * The tree as rows a caller can act on: the same text the printed view draws,
 * each node row tagged with what a branch from it needs. The Claude Code pane
 * is the caller — it lets you pick a row, and a row is only worth picking if it
 * says which transcript holds the node and where its collapsed run ends.
 */
function showJson(graph, lanes, { palette, title, width }) {
  const [summary] = renderHeader(graph, lanes, { file: title }).split('\n');
  const short = (f) => String(f).replace(/^.*[/\\]/, '').replace(/\.jsonl$/, '');
  const rows = renderAsciiRows(graph, lanes, { palette, width }).map(({ text, uuid }) => {
    const n = uuid ? graph.nodes.get(uuid) : null;
    if (!n) return { text };
    return {
      text,
      uuid,
      // A collapsed run is drawn as its first record; the conversation stood at
      // its LAST one, so that is where "continue from here" has to cut.
      end: n.tailUuid ?? uuid,
      kind: n.kind,
      promptNo: n.promptNo ?? null,
      preview: n.preview ?? '',
      isHead: !!n.isHead,
      inferred: !!n.record?.inferred,
      sessions: [...n.files].map(short),
    };
  });
  return { summary, rows };
}

function cmdStats(positional, flags) {
  const s = resolveSession(positional[0], flags.cwd || process.cwd());
  if (!s) fail('no transcript found');
  const parsed = parseTranscript(s.path);
  const st = stats(parsed.records);
  console.log(s.path);
  console.log(JSON.stringify(st, null, 2));
  if (parsed.issues.length) {
    console.log(`\nissues (${parsed.issues.length}):`);
    for (const i of parsed.issues.slice(0, 20)) console.log(`  line ${i.line}: ${i.reason}`);
  }
}

function cmdFixture(positional, flags) {
  const s = resolveSession(positional[0], flags.cwd || process.cwd());
  if (!s) fail('no transcript found');
  const { records } = parseTranscript(s.path);
  // Structure only. Transcripts hold source, paths and anything a tool printed
  // (spec §10), so a fixture must never carry content out of the session.
  //
  // What counts as structure grew with the classifier: the fields it now keys on
  // — message.role, attachment.type, promptSource, origin.kind, and *which*
  // slash-command tags a record carries — must survive redaction or the fixture
  // cannot pin the classification down. All of them are enum-ish harness values,
  // never anything a human or a tool wrote. Payload keys that ARE content
  // (`lastPrompt`, `aiTitle`, `mode`, `snapshot`) are dropped; `type` alone is
  // the sidecar discriminator, and uuids are already deemed safe to carry.
  const lines = records.map((r, i) => {
    const raw = r.raw ?? {};
    const out = {
      uuid: r.uuid,
      parentUuid: r.parentUuid,
      type: r.type,
      timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      isSidechain: r.isSidechain,
      isMeta: raw.isMeta ?? undefined,
      isCompactSummary: raw.isCompactSummary ?? undefined,
      subtype: typeof raw.subtype === 'string' ? raw.subtype : undefined,
      promptSource: typeof raw.promptSource === 'string' ? raw.promptSource : undefined,
      origin: typeof raw.origin?.kind === 'string' ? { kind: raw.origin.kind } : undefined,
      leafUuid: r.leafUuid ?? undefined,
      // Opaque API request id. Not content — no human or tool wrote it — and
      // structure the graph now depends on: it is what proves a fork with the
      // same id on both arms is a write-ordering artifact rather than a branch.
      requestId: r.requestId ?? undefined,
    };
    if (raw.attachment && typeof raw.attachment === 'object') {
      out.attachment = { type: raw.attachment.type };
    }
    if (raw.message && typeof raw.message === 'object') {
      out.message = { role: raw.message.role, content: shapeOf(raw.message.content, i) };
    }
    return JSON.stringify(out);
  });
  const out = lines.join('\n') + '\n';
  if (flags.out) {
    writeFileSync(flags.out, out);
    console.error(`wrote ${records.length} redacted records to ${flags.out}`);
  } else process.stdout.write(out);
}

/**
 * Redact a text body down to its shape. Slash-command tag NAMES are kept (they
 * are fixed harness markers, not content) along with a placeholder for any text
 * that survives stripping — which is exactly the distinction between plumbing
 * and a typed prompt that merely embeds an expansion, and therefore the one
 * thing a fixture has to preserve to pin that rule down.
 */
function redactText(text, i) {
  const present = PLUMBING_TAGS.filter((t) => text.includes(`<${t}`));
  if (!present.length) return `text-${i}`;
  const skeleton = present.map((t) => `<${t}>redacted</${t}>`).join('\n');
  return stripPlumbing(text) ? `${skeleton}\ntext-${i}` : skeleton;
}

function shapeOf(content, i) {
  if (typeof content === 'string') return redactText(content, i);
  if (!Array.isArray(content)) return undefined;
  return content.map((b) => {
    if (!b || typeof b !== 'object') return { type: 'unknown' };
    if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, id: b.id };
    if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id };
    if (b.type === 'text') return { type: 'text', text: redactText(String(b.text ?? ''), i) };
    return { type: b.type };
  });
}

function cmdName(positional, flags) {
  const cwd = flags.cwd || process.cwd();
  // A bare `cctree name "some name"` should name the current conversation, so a
  // single argument is an alias unless it actually resolves to a session.
  let sessionArg = positional[0];
  let alias = positional.slice(1).join(' ');
  if (positional.length === 1 && !resolveSession(positional[0], cwd)) {
    sessionArg = undefined;
    alias = positional[0];
  }

  const s = resolveSession(sessionArg, cwd);
  if (!s) fail(`no transcript found for ${sessionArg || cwd}`);

  if (flags.clear) {
    setAlias(s.id, null);
    console.log(`cleared the alias for ${s.id}`);
    return;
  }
  if (!alias) {
    const current = readAliases().get(s.id);
    console.log(current ? `${s.id}  ${current}` : `${s.id} has no alias (set one: cctree name "${'<name>'}")`);
    return;
  }
  setAlias(s.id, alias);
  console.log(`${s.id} is now "${alias}"`);
  console.log(`  stored in ${STORE_FILE}`);
}

function cmdBranch(positional, flags) {
  const s = resolveSession(positional[0], flags.cwd || process.cwd());
  if (!s) fail('no transcript found');
  const { records } = parseTranscript(s.path);

  // Three ways to name the cut. `--at N` is the original and cuts the file at
  // prompt #N. `--to`/`--before` name a node, which is what a caller holding a
  // selection has — and the only form that is right on an arm other than the
  // trunk, since `#N` counts down the tree while `--at` counts through the file.
  let plan;
  let what;
  let reask = null;
  if (flags.to || flags.before) {
    let to = flags.to;
    if (flags.before) {
      const target = records.find((r) => r.uuid === flags.before);
      if (!target) fail(`no record ${flags.before} in ${s.id}`);
      if (!target.parentUuid) fail('that node opens the conversation — a branch before it would be empty');
      to = target.parentUuid;
      if (target.kind === 'prompt') reask = promptText(target.raw);
    }
    plan = planBranchTo(records, to);
    if (!plan.ok) fail(plan.reason);
    what = flags.before ? `before ${flags.before.slice(0, 8)}` : `at ${to.slice(0, 8)}`;
  } else {
    const at = Number(flags.at);
    if (!Number.isInteger(at) || at < 1) fail('--at N, --to UUID or --before UUID is required');
    plan = planBranch(records, at);
    if (!plan.ok) fail(plan.reason);
    what = `before #${at} "${String(plan.target.preview).replace(/\s+/g, ' ').slice(0, 56)}"`;
  }

  const newId = randomUUID();
  const dest = join(dirname(s.path), `${newId}.jsonl`);
  // A uuid collision here would mean overwriting somebody's conversation.
  if (existsSync(dest)) fail(`refusing to overwrite ${dest}`);

  const source = readFileSync(s.path, 'utf8');
  const { text, kept, rewritten } = buildBranchText(source, {
    cutLine: plan.cutLine,
    keepLines: plan.keepLines,
    newSessionId: newId,
  });
  if (!text) fail('nothing to write — the branch would be empty');

  if (flags.json) {
    if (!flags.dryRun) writeFileSync(dest, text);
    return console.log(JSON.stringify({ id: newId, path: dest, kept, of: records.length, reask, dryRun: !!flags.dryRun }));
  }
  if (flags.dryRun) {
    console.log(`would branch ${what}`);
    console.log(`  keep ${kept} records (of ${records.length})`);
    console.log(`  new session ${newId}`);
    console.log(`  would write ${dest}`);
    return;
  }

  writeFileSync(dest, text);
  console.log(`branched ${what}`);
  console.log(`  kept ${kept} records, rewrote sessionId on ${rewritten}`);
  console.log(`  wrote ${dest}`);
  console.log(`\nEnter it with:\n  claude -r ${newId}`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

export function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift();
  if (flags.help || !cmd || cmd === 'help') return console.log(USAGE);
  switch (cmd) {
    case 'show':
      return cmdShow(positional, flags);
    case 'sessions':
      return cmdSessions(flags);
    case 'stats':
      return cmdStats(positional, flags);
    case 'fixture':
      return cmdFixture(positional, flags);
    case 'branch':
      return cmdBranch(positional, flags);
    case 'tui':
      return cmdTui(positional, flags);
    case 'name':
      return cmdName(positional, flags);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}
