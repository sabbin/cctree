# ccTree

A git-style graph over Claude Code transcripts. See `cctree-spec.md` for the design.

**Built so far: phases 0 and 1.** Tolerant parser, graph builder, lane allocator,
ASCII renderer, plus enough plugin glue to run it from inside a session.

## Try it without installing anything

```bash
npm test                 # regenerates fixtures, runs 11 tests
./bin/cctree show test/fixtures/aaaaaaaa-0000-4000-8000-000000000001.jsonl
```

```
 ●   #1 "scaffold the manifest"
 │
 ○   assistant Created plugin.json.
 │
 ●   #2 "add the jsonl parser"
 │
 ○   assistant · 2 msgs, 1 tools
 │
 ○   assistant Parser written.
 │
 ●   #3 "wire up the lane allocator with elkjs"
 │
 ◇   assistant · 3 msgs, 1 tools
 ├─┐  forked after #2 add the jsonl parser
 │ ● #4 "no, hand-roll the lane allocator"
 │ │
 │ ◆ assistant · 3 msgs, 1 tools ← HEAD
```

## Run it against your own sessions

```bash
./bin/cctree sessions          # transcripts for the current directory
./bin/cctree show              # newest session
./bin/cctree show --all        # every session in the project, merged
./bin/cctree stats             # kind histogram + parser issues
./bin/cctree tui               # pick a conversation, then browse/branch its tree
./bin/cctree branch --at 4     # new session holding everything before prompt #4
./bin/cctree name "the refactor"   # give this conversation a name
./bin/cctree-go                # browse, branch, and land in the new session
```

`cctree-go` is the one that closes the loop: browse the graph, press `b` to
branch at the selected prompt, `o` to open it, and the wrapper execs
`claude -r <id>` so you end up *in* the branch. Pressing `o` without branching
opens the session the selected node belongs to, which is how you move between
arms that already exist. Quitting with `q` launches nothing.

`--all` matters for `/branch`: copied records keep their uuids — measured, 291 of
291 on a real branch — so merging the files by uuid makes the fork point appear
on its own. If `--all` reports disconnected roots, that has broken; see *Risks*.

`branch` is the only command that writes, and it only ever *creates* a file:
everything before prompt `#N` is copied to a new `<uuid>.jsonl` with `sessionId`
rewritten, which is precisely what `/branch` does. Claude Code resumes the result
with `claude -r <id>`. Run `--dry-run` first — it reports what would be kept and
dropped without touching the disk.

## Load it as a plugin

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
hooks/hooks.json        SessionStart → record transcript path in ~/.cctree
test/                   fixtures + 11 tests
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

**Fork rows name their prompt.** In a chronological layout the connector meets a
column rather than the fork row, which is ambiguous exactly where it matters. So
each `├─┐` carries `forked after #N` — and `#N` is the number you need for the
rewind recipe.

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
- [ ] Phase 4 — graft, compare, `UserPromptSubmit` delivery.
- [ ] Phase 5 — working-tree awareness via checkpoint refs (already retained by the parser).
