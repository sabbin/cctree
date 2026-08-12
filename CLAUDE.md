# ccTree — working context

A git-style graph over Claude Code transcripts. Full design in `cctree-spec.md`;
usage and layout in `README.md`. This file is the part that isn't obvious from
either: why things are the way they are, and what is currently unresolved.

## State

Phases 0, 1, 2a and a first 3 are built and tested. Graft (§5.3) is not started.

- Phase 0 — tolerant JSONL parser (`src/parse.js`)
- Phase 1 — graph builder, lane allocator, ASCII renderer (`src/graph.js`, `src/lanes.js`, `src/render-ascii.js`)
- Phase 2a — programmatic branching (`src/branch.js`, `cctree branch --at N`)
- Phase 3 — companion TUI (`src/tui.js`, `cctree tui`), zero-dependency, plus
  `bin/cctree-go`, which turns browse → branch → `claude -r` into one keystroke
- Phase 3b — session picker (`src/session-list.js`), the TUI's default view
- Plugin glue — `skills/show/SKILL.md`, `hooks/hooks.json`, `bin/cctree`,
  installed for development by symlinking the repo to `~/.claude/skills/cctree`,
  which auto-loads as `cctree@skills-dir` with no marketplace and no publishing

`npm test` regenerates the synthetic fixtures and runs the suite. Keep it green.
The `test/fixtures/real-*.jsonl` skeletons are NOT regenerated — they are
captured evidence of one Claude Code version. Add to them after an upgrade
rather than replacing them.

## Invariants

These are load-bearing. Changing one is a design decision, not a refactor.

**The parser never throws on a transcript.** Unknown record kinds, missing
fields, truncated final lines and outright garbage degrade to a placed node or a
logged issue. The transcript format is internal to Claude Code and changes
between releases; this tolerance plus the fixture corpus is the entire
mitigation. Never add a validation that rejects a record.

**`src/lanes.js` is pure.** `graph -> rows`, no I/O, no rendering, no colour. The
SVG renderer in a later phase must consume its output unchanged.

**Nothing modifies an existing transcript.** Ever. The one write ccTree performs
is `cctree branch`, which CREATES a new `<uuid>.jsonl` beside the original and
never opens an existing file for writing. Reads are otherwise the whole story.

That exception was earned by measurement rather than assumed. A real `/branch`
preserves all uuids and rewrites only `sessionId`, so a branch is reproducible:
copy the records before the cut, rewrite `sessionId`, save under a fresh uuid. A
synthesized branch was then resumed with `claude -r` and carried exactly the
expected history. Rewinding *within the current session* still cannot be done —
that needs the rewind menu, which is interactive-only — so those operations
still degrade to printing a recipe.

**Fixtures carry no content.** `cctree fixture <session>` emits structure
only — uuids, parents, types, timestamps, tool names. Transcripts contain source,
paths, and anything a tool printed, including secrets from `.env` files and error
logs. Real transcripts must never be committed raw.

Structure has since grown to include the enum-ish fields the classifier keys on:
`message.role`, `attachment.type`, `promptSource`, `origin.kind`, and *which*
slash-command tags a record carried (names only, bodies replaced by `redacted`).
Content-bearing payloads — `lastPrompt`, `aiTitle`, `mode`, `snapshot`, `cwd`,
thinking blocks — are dropped. Audit any new fixture by enumerating every string
value in it and accounting for each one before committing.

## Decisions already taken

**Plain ESM JavaScript, zero dependencies.** `bin/` lands on the Bash tool's PATH
when the plugin is enabled, and a build step there means a stale `dist/` can lie
to you. When the Ink companion arrives in phase 3 it can be a separate
TypeScript workspace importing these modules.

**Classification is role-first, and the sidecar gate is `!uuid`.** `type` has
already grown past user/assistant/system/summary, so dispatching on it is how the
classifier fell behind; `message.role` has stayed stable and decides first, with
`type` as the fallback for records that have no `message`. Anything without a
uuid cannot be another record's parent and so cannot be a node — that shape, not
a list of known type names, is what diverts sidecars out of the tree, which is
why nine sidecar types this project has never seen still classify correctly.

**Slash-command plumbing is detected by what survives stripping.** Not by tag
presence. A typed prompt can *embed* an expansion — this project's own opening
prompt is 1424 characters of which 707 survive — so a tag-presence test discards
real prompts. Strip the known tags; if anything is left it is a prompt, and
`promptSource`/`origin.kind` override toward prompt regardless. The regression is
pinned by `test/fixtures/real-2.1.226-aaf4e71a.jsonl`.

**Rewind, `/branch` and `/fork` are three different things.** All three split a
conversation, and they leave such different evidence that ccTree needs a
different mechanism to detect each. Measured end-to-end on one test conversation
(A, B in the trunk; `/branch` after B giving C, D; back to the trunk for E;
`/fork` after E, then F, G):

|                      | rewind (`Esc Esc`)      | `/branch`                       | `/fork`                              |
| -------------------- | ----------------------- | ------------------------------- | ------------------------------------ |
| new transcript file  | no                      | yes                             | yes                                  |
| records copied in    | none — siblings in situ | the whole prefix, uuids intact  | none, the file starts empty          |
| does it move you?    | yes, in place           | **yes**, you continue in the copy | **no**, you stay where you are     |
| title sidecar        | none                    | `custom-title` `"<prompt> (Branch N)"` | `ai-title` + `agent-name` `"<parent title> ⑂"` |
| ccTree links it by   | `parentUuid`            | shared uuids (dedupe)           | title match — nothing else exists    |

The decisive measurement is the third row, and it is the one that misleads
everybody including the author of this file. C and D carry timestamps *after*
the branch and appear only in the child, so `/branch` moved the conversation
into the copy. F and G carry timestamps after the fork and appear only in the
PARENT, so `/fork` did not. `/fork` says so itself, in a record it writes into
the parent: "the fork runs as its own separate session — nothing it does arrives
in this session." That cuts both ways, which is the half that gets missed —
nothing this session does arrives in the fork either. An unused fork is
therefore the normal state of one, not a mistake.

Consequences that fall out, and each is load-bearing somewhere:

- A branch is discoverable from its records; a fork is not, because it has none.
  Hence the title-match nesting and `src/fork-context.js`.
- A branch and its parent merge into one tree for free under `--all`, since they
  share uuids. A fork can never merge — there is nothing to merge — which is why
  its inherited history is *borrowed and labelled* rather than deduped in.
- A rewind is the only one of the three that a single-file view can show. Both
  others need the merged view or the picker to be visible at all.

**No fork-edge concept.** `/branch` copies records verbatim, so deduping by uuid
across session files merges a copy and its original into one tree and the fork
point falls out for free. Spec §3.3's fork edges never need computing.

**Lane reservation.** A rewind arm is usually finished before its sibling starts,
so a naive allocator recycles the trunk column and a fork renders as a straight
line. A column stays reserved until every child of the fork it holds has been
emitted. This is the one non-obvious thing in `lanes.js`.

**Fork rows name their prompt.** Chronological layout means a connector meets a
column, not the fork row. Each `├─┐` carries `forked after #N`.

**The TUI opens on a forest of conversations, not a merged tree.** A merged tree
stops being readable at a handful of branches — this project hit 32 nodes across
6 sessions while building it. The picker draws sessions as a tree, parents above
their branches, so the relationship is shown rather than described. Rows carry
the LAST prompt: every branch of one conversation shares an opening prompt, so
showing that makes every row identical. `--all`, a named session or `--select`
skip the picker for callers that already know what they want.

**Which session is the branch is NOT a subset test.** The obvious guess, and
wrong: a branch copies its parent's records, so child ⊂ parent at the moment of
branching, but the parent keeps growing and eventually contains the child
outright. Measured here — the subset rule declared the live session the ancestor
of the sessions it had itself been branched from. What holds is that a branch
shares its ENTIRE prefix with its immediate parent: **among sessions created
earlier, the parent is the one sharing the most uuids.** Creation order has to
come from the filesystem (`birthtime`), because copied records keep their
original timestamps. Verified against the only ground truth available — the two
`/branch` messages in this project's own history, which name the parent. Where
`birthtime` is unavailable the picker declines to claim direction and falls back
to a flat list.

**Conversations are named, and ccTree writes none of those names into a
transcript.** Claude Code already titles sessions with two sidecars: `ai-title`
(generated, present on normal sessions) and `custom-title` (written by `/branch`
as `"<opening prompt> (Branch 2)"`, and it does NOT copy the parent's
`ai-title`). Both are read, neither is written — appending a title record would
mean writing into a session file. User aliases live in `~/.cctree/sessions.json`
beside what the SessionStart hook records, so there is one durable index.

Precedence is alias > own title > nearest named ancestor > last prompt. Two
things that look like details and are not: `/branch`'s auto title is *demoted to
a badge* because it is the opening prompt echoed back, so taking it literally
makes every arm of a conversation read identically; and the badge is kept OUT of
the name string so truncation cannot eat the one part that distinguishes them.

**The TUI hands a session id back through a file, not stdout.** stdout is the
screen: a caller capturing it gets the whole ANSI frame. `cctree tui --emit PATH`
writes the chosen id there, and `bin/cctree-go` reads it and execs `claude -r`.
It is a script rather than a shell function so it lands on PATH with the plugin —
nothing to source, nothing to drift out of sync with a shell rc. Exec matters
too: the wrapper is replaced by `claude`, leaving no stray shell behind.

**A fork within one `requestId` is an artifact, and is undone before layout.**
Parallel tool calls are written two ways and which one lands is a race between
the result arriving and the next call being recorded:

    linear (8 of 14 runs)        forked (6 of 14 runs)
      use A                        use A ──┬── use B     (sibling, same request)
        └ result A                         └── result A  (dead end, phantom tip)
            └ use B
                └ result B

Both mean one turn issuing two calls. A `requestId` is one API request and the
assistant cannot branch inside one, so the second shape is a write-ordering
artifact — which makes the fix a normalization with a property worth asserting:
the two encodings must produce identical topology. `linearizeTurns()` runs
inside `buildGraph`, before `topoOrder`, tips, forks and lanes, since all of
them derive from `children`. It fires only when a node's children are its own
`tool_result` plus a sibling sharing its `requestId`, so a genuine rewind fork —
whose arms are prompts, carrying no `requestId` at all — cannot match.

Two things measured rather than assumed. First, the scale: the earlier note here
claimed every parallel call in every session produces a phantom fork and that
`forks` overcounted *badly*. It does not. Across 8 transcripts and 689 request
runs there are 14 parallel runs and 4 multi-child nodes total, because a 3-record
run is usually thinking + text + ONE tool_use. Real damage on the merged view was
4 forks → 2 and 10 tips → 8. Second, and the part that bites: the sibling must be
**spliced**, not appended. Whatever already hangs off the end of the turn is the
NEXT turn and belongs after the moved call — appending merely relocates the
phantom fork one node down, which is exactly what the first cut of this did, and
`test/fixtures/real-2.1.228-fa1b5fc0.jsonl` is the transcript that caught it.

`requestId` is now retained by the parser and emitted by `cctree fixture` (an
opaque API id, not content — audited). `buildGraph(records, {linearize: false})`
gives the raw shape back, which is how the tests prove the fork is really in the
file.

**An unused fork strands as a root, and is linked by its title.** It has no
uuids, so the shared-prefix parent rule cannot see it at all. The `⑂` is
promoted to a `(Fork)` badge for the same reason `(Branch)` is — it is the part
that distinguishes the arms — and the name is the parent's title with the glyph
stripped, so an exact match after stripping links them. Scoped hard to sessions
with `uuids.size === 0`: for anything with records the prefix is the real
evidence, and a name collision must never be allowed to invent parentage.

**An unused fork is shown with its parent's history, borrowed and labelled.**
Opening one otherwise draws an empty tree — accurate and useless, since what you
want is what the fork starts from, and that exists in the parent's file. Two
inferences get it (`src/fork-context.js`), and both are named on screen: the
parent comes from the title match already used to nest it, and the cut comes
from the fork file's creation time, since records the parent wrote after that
moment are its own continuation. Verified against a real fork — the split lands
exactly between the prompt before it and the prompt after.

The load-bearing guard is that `inheritedFor()` returns null the moment the fork
has ANY record with a uuid. An inference must never stand in front of real data,
so this applies only while the file is genuinely empty, and stops the instant a
prompt lands. It is also skipped for merged views, where the parent is present
anyway. The dependencies are injected because the rule turns on file creation
times and no API lets a test set one.

**Rows are labelled by where an arm diverged, not by either end of its prompt
list.** This replaces "rows carry the LAST prompt". Both ends answer the wrong
question: every branch shares an opening prompt, so the first makes sibling rows
identical, and the last only says where an arm happened to stop. The first prompt
an arm does NOT share with its parent is distinct across siblings and stable as
the conversation grows. A root has no parent, so its divergence *is* its opening
prompt — which is also what makes a conversation recognisable.

The third case is the one that is easy to miss: a branch cut but never continued
shares EVERY prompt with its parent, so it has no divergence at all. Falling back
to the opening prompt puts it straight back into the failure this replaced, so it
falls back to its LAST prompt — the cut point, which differs between two such
branches of one parent. Pinned by a test with exactly that shape.

**Merging conversations is impossible** and is not a missing feature. Every
`tool_result` references a `tool_use` id from a preceding assistant turn, so
interleaving two lanes orphans those pairs. Graft (spec §5.3) is the replacement:
lossy, one-directional, cherry-pick semantics.

## Record shapes (surveyed against 2.1.226)

Three groups, and the group decides everything:

- **In-tree** — `uuid` + `parentUuid` + `timestamp` all present. `assistant` and
  `user` (content is a string for prompts, an array for `tool_result`), plus
  `attachment`, which has **no `message` key at all** and carries
  `attachment.type` instead. Attachments sit in the parent chain; they are nodes.
- **Sidecar** — no `uuid`, no `parentUuid`, no `timestamp`, keyed by `sessionId`
  and appended repeatedly. Roughly 38% of a real transcript. Observed here:
  `mode`, `permission-mode`, `ai-title`, `last-prompt` (carries `leafUuid`),
  `file-history-snapshot`. A sweep of 3404 transcripts adds nine more, which is
  why the gate is `!uuid` and not a type allowlist.
- **Pointer-only** — `summary`, which has no uuid but names a `leafUuid`.

A `/command` is three user-role records, not one: the `<local-command-caveat>`
(also `isMeta`), the `<command-name>`/`-message`/`-args` invocation, and the
`<local-command-stdout>` capture.

## Open — do not assume these are settled

**Prompt numbering is unverified.** `#N` is chronological across the whole tree.
Whether that matches what `Esc Esc` lists is unconfirmed, and the rewind recipe
depends on it. Verify empirically before anything relies on `#N`.

**Uuid preservation across `/branch` is CONFIRMED** — measured on a real branch of
this project's own session: 291 of 291 uuids shared, and `sessionId` was the only
field rewritten (on all 313 copied records). The content-hash fallback is dead;
drop it from the spec when convenient. `looksForked()` stays as the detector in
case a future release changes its mind, and now implements the test its docstring
always described — same cwd, overlapping time ranges, no shared uuid — instead of
counting sessions.

Related lead, not the same thing: `subagents/agent-*.jsonl` files open with a
`fork-context-ref` record carrying `parentSessionId` + `parentLastUuid`, an
explicit edge from a sidechain back to the node that spawned it. That is the
attachment point a future graft/sidechain view wants.

**Renderer choice for the companion is settled: zero-dependency Node, not Ink.**
Ink would need `npm install` and a build step, and the plugin is installed by
symlinking a working copy onto PATH — where there is no `node_modules` and a
stale `dist/` could lie to you. `src/tui.js` is raw-mode stdin plus ANSI, reusing
`assignLanes()` and `renderAsciiRows()` unchanged, so the printed and interactive
views cannot drift. Revisit only if the UI grows past a list plus a detail line.

## Conventions

- Comments explain *why*, especially where a simpler implementation was rejected.
- New behaviour arrives with a fixture and a test.
- **Drive the TUI through a pty before believing it works.** The pure parts had
  full coverage and still shipped a bug that made it unquittable: stdin hands you
  bytes, not keys, so `jjjq` arrives as one chunk and matching a whole chunk
  against a key table drops every key in it. `printf 'jjjq' | script -qec "cctree
  tui" /dev/null` catches this class in one command; assert on the exit code and
  on the alternate-screen enter/leave pair, not just on what was drawn.
- After upgrading Claude Code, run `cctree stats` before anything else — it
  is the format-drift canary.
- **Always name the session when capturing a fixture.** `cctree fixture` with no
  argument means "newest by mtime", and mtimes on old transcripts do get bumped —
  a no-arg capture here silently produced a skeleton of a *different* session
  than `cctree stats` had just reported. Confirm what you got by uuid overlap
  against the intended file before committing it.
