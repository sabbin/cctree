# ccTree

A git-style graph of your Claude Code conversations. Rewinds, `/branch` copies
and `/fork` siblings are drawn as one tree, in a pane docked beside the session
you are in, and you can jump to any point of it. See `cctree-spec.md` for the
design.

**Version 0.1.0-pre-alpha.** Built: a tolerant transcript parser, the graph and
lane layout, an ASCII renderer, programmatic branching, a standalone TUI, and
the in-app pane. Not yet: graft, compare, working-tree awareness (see *Next*).

## Install

At the Claude Code prompt:

```
/plugin install cctree --marketplace sabbin/cctree
```

Answer `y` to add the marketplace, then pick a scope. That brings the whole
plugin: the pane (`/cctree`, docked beside the session from 144 columns), the
`show` skill, and the `cctree` CLI on the Bash tool's PATH. The pane runs the
CLI with `node`, so Node 18+ has to be on PATH. Pre-alpha: expect it to change.

Updates arrive as a new `version` in `.claude-plugin/plugin.json`; pick one up
with `claude plugin update cctree`.

## The pane

`/cctree` opens it; from 144 columns it opens by itself, docked to the right of
the conversation. It draws the conversation you are in **with its family**, so
a `/branch` shows as an arm off the session it was cut from rather than as a
straight line.

| key | in the tree | in the session list |
| --- | --- | --- |
| click, `j` / `k` | pick a node | pick a conversation |
| `c` | continue from here | |
| `e` | ask this prompt again | |
| `t` / `o` | | show its tree / resume it |
| `n` | | rename it |
| `−` / `+N`, `z` | | fold its branches away, or back |
| `s` | switch to the session list | switch to the tree |
| `f` | this transcript only ↔ family | |
| `r` | refresh | refresh |

Keys work once the pane has focus: click it, or press `ctrl+x tab`.

**Jumping is branching.** No plugin can drive the rewind menu, so `c` and `e`
write a new session ending at that node — the original is never touched — and
`/resume` you into it. `e` also puts the prompt back in the input box, ready to
edit. Names you give live in
`~/.cctree/sessions.json`, never in a transcript.

The pane redraws as the conversation grows, and keeps its header and footer in
place by drawing exactly its own height and scrolling the tree inside it.

## Try it without installing anything

```bash
npm test                 # regenerates fixtures, runs the CLI/TUI suite
claude plugin test .     # the pane's tests, against Claude Code's own test kit
./bin/cctree show test/fixtures/aaaaaaaa-0000-4000-8000-000000000001.jsonl
```

```
 #1  ●   "scaffold the manifest"
     ○   assistant Created plugin.json.
     │
 #2  ●   "add the jsonl parser"
     ○   assistant · 2 msgs, 1 tools
     │
     ○   assistant Parser written. 2 arms
     ├─┐
       split after #2 add the jsonl parser
 #3  │ ● "wire up the lane allocator with elkjs"
     │ ◇ assistant · 3 msgs, 1 tools
     │
     #2 continues
 #4  ●   "no, hand-roll the lane allocator"
     ◆   assistant · 3 msgs, 1 tools ← HEAD
```

## Run it against your own sessions

```bash
./bin/cctree sessions          # transcripts for the current directory
./bin/cctree show              # newest session
./bin/cctree show --family     # newest session with its /branch relatives
./bin/cctree show --all        # every session in the project, merged
./bin/cctree stats             # kind histogram + parser issues
./bin/cctree tui               # pick a conversation, then browse/branch its tree
./bin/cctree branch --at 4     # new session holding everything before prompt #4
./bin/cctree branch --to <uuid>   # new session ending ON that node, on its own arm
./bin/cctree name "the refactor"   # give this conversation a name
./bin/cctree-go                # browse, branch, and land in the new session
```

`cctree-go` is the one that closes the loop: browse the graph, press `b` to
branch at the selected prompt, `o` to open it, and the wrapper execs
`claude -r <id>` so you end up *in* the branch. Pressing `o` without branching
opens the session the selected node belongs to, which is how you move between
arms that already exist. Quitting with `q` launches nothing.

`--family` and `--all` matter for `/branch`: copied records keep their uuids —
measured, 291 of 291 on a real branch — so merging the files by uuid makes the
branch point appear on its own. `--family` merges one conversation's sessions,
`--all` every session in the project. If `--all` reports disconnected roots,
that has broken; see *Risks*.

`branch` is the only command that writes, and it only ever *creates* a file:
the records are copied to a new `<uuid>.jsonl` with `sessionId` rewritten, which
is precisely what `/branch` does. `--at N` copies the file up to prompt `#N`;
`--to`/`--before <uuid>` follow the node's own arm instead, which is what is
right after a rewind, when the lines above a prompt can belong to another arm. Claude Code resumes the result
with `claude -r <id>`. Run `--dry-run` first — it reports what would be kept and
dropped without touching the disk.

## Load it as a plugin (development)

```bash
claude plugin validate .
claude --plugin-dir . # this session only
```

Then `/cctree:show` inside the session, or just ask for the conversation
tree. `bin/` goes on the Bash tool's PATH while the plugin is enabled, so Claude
can run `cctree show` directly.

To keep it loaded across sessions, either add a marketplace entry pointing here,
or symlink into a skills directory:

```bash
ln -s ~/work/mine/cctree ~/.claude/skills/cctree   # loads as cctree@skills-dir
```

Note that changes to `hooks/` and `.claude-plugin/` need `/reload-plugins`;
`SKILL.md` edits take effect immediately.

## Layout

```
bin/cctree          sh wrapper → cctree.mjs (on PATH when enabled)
bin/cctree-go       browse → branch → exec claude -r (the loop closer)
hooks/panel.tsx         the in-app pane: a Claude Code mod that runs the CLI
types/index.d.ts        the pane's state contract (checked by plugin validate)
src/branch.js           phase 2a — copy records, rewrite sessionId, new file
src/tui.js              phase 3 — raw-mode TUI; pure parts exported for tests
src/session-list.js     phase 3b — the picker; derives which session branched
                        from which, and draws them as a forest
src/store.js            ~/.cctree/sessions.json — the durable index and aliases
src/parse.js            phase 0 — tolerant JSONL reader, five retained fields
src/graph.js            records → tree; cross-session dedupe; collapsing
src/lanes.js            pure Node[] → LaneAssignment[]; no I/O
src/render-ascii.js     one of two renderers over the lane model
src/sessions.js         ~/.claude/projects discovery, with a cwd-matching fallback
skills/show/SKILL.md    /cctree:show
hooks/hooks.json        SessionStart → record transcript path; loads the pane
.claude-plugin/         plugin.json, and marketplace.json for /plugin install
test/                   fixtures; *.test.js (npm test), panel.test.ts (pane)
```

## Decisions taken while building

**Plain ESM JavaScript, zero dependencies.** `bin/` lands on the Bash tool's
PATH, and a build step there means a stale `dist/` is one forgotten `npm run
build` away from lying to you. Phases 0–1 are ~600 lines and renderer-agnostic;
when the Ink companion arrives in phase 3 it can be its own TypeScript workspace
importing these modules unchanged.

**No fork-edge concept.** Deduping by uuid across session files makes a
`/branch` copy and its original into one tree automatically, so §3.3's fork
edges never need to be computed or drawn separately.

**Lane reservation.** Rewind arms are usually finished before their sibling
starts, so a naive allocator recycles the trunk column and the fork renders as a
straight line. A column now stays reserved until every child of the fork it
holds has been emitted. This is the one non-obvious thing in `lanes.js`.

**Parallel tool calls do not make a fork.** One turn issuing several tool calls
is written two ways — the next call chained onto the previous *result*, or onto
the previous *call* — and which one lands is a race. The second shape leaves the
first call with two children and renders a `├─┐` nobody created, plus a dead-end
`tool_result` counted as a tip. Since a `requestId` is one API request and the
assistant cannot branch inside one, `linearizeTurns()` re-chains the run into the
single line the other encoding already produces, in memory, before layout. A
genuine rewind fork has prompts on its arms and no `requestId`, so it never
matches. Measured on this project: 4 forks → 2 and 10 tips → 8 across 8 sessions.

**Three ways a conversation splits, and none of them look alike on disk.**

| | rewind (`Esc Esc`) | `/branch` | `/fork` |
| --- | --- | --- | --- |
| new file | no | yes | yes |
| records copied | none — siblings in place | whole prefix, uuids kept | none, starts empty |
| moves you there | yes | **yes** | **no** |
| marked by | — | `(Branch N)` title | `⑂` on the title |
| found by | `parentUuid` | shared uuids | its title |

The row that catches people is the third. After `/branch` you are *in* the copy,
so what you type next lands there. After `/fork` you are still where you were,
so what you type next lands in the ORIGINAL and the fork stays empty until you
resume it — which is the normal state of a fork, not a mistake.

That is why only a rewind shows up in a single-session view. A branch appears
when the files are merged (`--all`), and a fork appears only in the picker,
since it has no records to merge.

**Rows show where an arm diverged.** Not its first prompt (every branch shares
one, so the rows go identical) and not its last (that only says where it
stopped), but the first prompt it does not share with its parent — falling back
to the cut point for a branch that was never continued.

**Split rows name their prompt.** Each `├─┐` carries `split after #N`, and the
arm that carries on says `#N continues`. The word is *split*, never *fork*: a
rewind, a `/branch` and a `/fork` all put two children on one node and the
graph cannot tell which did it, so `⑂` is kept for a real `/fork`.

**The original is the trunk, and "original" means created first.** A `/branch`
copy keeps the original's timestamps, so only the file's birth time says which
came first. Ordering by modification time looked equivalent until you went back
to the original after branching it: one prompt there made it the newest file,
and the copy took the trunk.

**The pane runs the CLI rather than reimplementing it.** A pane's code runs
inside Claude Code with no Node and no filesystem, so it asks `cctree show
--json` for the rows and draws them. That keeps one renderer: the pane, the
printed view and the TUI cannot drift apart.

## Risks being tracked

- **Format drift.** `cctree stats` is the canary; `test/fixtures/` is the
  regression net. `cctree fixture <session> --out test/fixtures/x.jsonl`
  writes a *structure-only* skeleton — uuids, parents, types, timestamps, tool
  names, no content — so real transcripts can be committed without leaking
  source, paths, or anything a tool printed.
- **Uuid preservation across `/branch`** is confirmed — 291 of 291 on a real
  branch — but `--all` still warns when it sees disconnected roots, which is how
  a future release changing its mind would surface.
- **Prompt numbering** is chronological across the whole tree and is *not yet
  verified* against what the rewind menu shows. Check this before anyone relies
  on `#N` as a recipe.

## Next

- [x] Phase 2 — file watcher, redraw on append; `cctree branch --at N`.
- [x] Phase 3 — `cctree tui`: selection, arrow keys, branch from the graph.
- [x] The in-app pane — the tree beside the session; jump, re-ask, rename, fold.
- [ ] Phase 4 — graft, compare, `UserPromptSubmit` delivery.
- [ ] Phase 5 — working-tree awareness via checkpoint refs (already retained by the parser).
