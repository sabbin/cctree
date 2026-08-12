# ccTree

A git-style graph view of Claude Code conversations, with navigation, branching, and cross-branch grafting.

Status: design complete, unbuilt. Two assumptions confirmed empirically (see §9).

---

## 1. What it is

Claude Code's transcript is append-only and its records link by `parentUuid`. That makes every session a tree, not a list — but the TUI renders only the path from root to HEAD. Rewind to an earlier prompt and continue, and the abandoned messages stay on disk, unreachable from the interface.

ccTree is the reflog for that tree, plus the graph. It shows the branches Claude Code has stopped showing you, lets you move between them, and lets you carry findings from one branch into another.

The A/B case is the motivating workflow: rewind to a decision point, try a second approach, then judge both from a neutral third lane.

## 2. Constraints

These are fixed and shape everything below.

**No TUI extension point.** Plugins ship skills, agents, hooks, MCP/LSP servers, monitors, and `bin/` executables. They cannot draw a pane, own a keymap, or intercept keys inside a session. ccTree is therefore a *companion process* — a tmux split or browser tab with its own keyboard — and the plugin half is glue.

**The rewind menu is interactive-only.** `Esc Esc` / `/rewind` cannot be driven programmatically. Any operation requiring it degrades to "show the recipe, copy to clipboard."

**Transcript format is internal.** Documented as changing between releases; scripts parsing it directly can break on any update. The tolerant parser (§7, phase 0) is the entire mitigation.

**Transcripts expire.** 30 days by default (`cleanupPeriodDays`). The ccTree index must be the durable store, not a cache.

**Merging conversations is impossible.** Every `tool_result` references a `tool_use` id from a preceding assistant turn; interleaving two lanes orphans those pairs and the API rejects the request outright. Separately, two diverged conversations share a prefix but their suffixes are independent continuations, not edits to a common object — there is no base to three-way merge against. Graft (§5.3) is the replacement, and it is lossy and one-directional by design.

## 3. Data model

### 3.1 Nodes

One node per transcript record. Retained fields: `uuid`, `parentUuid`, `type`, `timestamp`, plus any checkpoint reference found. Everything else stays opaque.

Display types:

| Glyph | Meaning |
|---|---|
| `●` | user prompt |
| `○` | assistant turn (tool clusters collapsed into one node) |
| `◆` | lane tip / HEAD |
| `◇` | lane tip, not current |
| `⊙` | compaction or summarize marker |
| `⊕` | graft |

Subagents live in separate `subagents/agent-<id>.jsonl` files and render as collapsible subtrees.

### 3.2 Two branch mechanisms

Identical in the graph, different on disk:

| | `/branch` | rewind-branch |
|---|---|---|
| Session id | new | same |
| Storage | new `.jsonl` | siblings in one file |
| Named | yes, in the session picker | no |
| Fork point | tip only | any prior prompt |
| Resumable from TUI | `/resume <name>` | rewind menu |

Rewind-branches are the primary mechanism — they're where arbitrary-point forking lives. `/branch` is the named, portable variant.

### 3.3 Edges

- **Parent edges** — `parentUuid`, solid.
- **Fork edges** — for `/branch`, the last uuid common to both files. Solid.
- **Graft edges** — provenance only, dashed, drawn from each source range to the `⊕` node.

### 3.4 Refs

ccTree maintains its own name→node map, invisible to Claude Code. Rewind-branches have no names at all, so without this an A/B comparison is two uuids staring at each other. Fast-forward is a pointer move in this map and nothing else.

## 4. Navigation

| Key | Action | Underlying |
|---|---|---|
| `↑` `↓` | walk parent/child | selection only |
| `←` `→` | cycle siblings | selection only |
| `⏎` | jump to node | rewind menu recipe, or `claude --resume <id>` |
| `n` | name the selected lane | ccTree refs |
| `d` | diff working-tree state between siblings | checkpoint refs |

Selection is free; only `⏎` touches Claude Code.

## 5. Operations

### 5.1 Branch out — `b`

At a lane tip: `/branch <name>` or `claude --resume <id> --fork-session`, both scriptable.

At any other node: requires rewinding first, which cannot be automated. ccTree prints the recipe (`Esc Esc` → prompt #N → restore conversation → `/branch`) and copies it. Accepted friction.

### 5.2 Fast-forward — `f`

Legal only when the target lane has no nodes after the fork point. Pure metadata: the ref moves, no transcript is touched. Covers the common case where you branched, explored, and never returned to the original.

### 5.3 Graft — `y` / `p`

Yank and put, not merge. Nothing closes; source lanes stay open and resumable forever.

**Yank the delta.** Compute the common ancestor between the yanked node and the target HEAD, and summarize only the range between. The target already holds the shared prefix; regrafting it wastes context.

**Summarize statelessly.** Do not resume the source session — `--resume` lands at its tip, useless for a range ending mid-lane. Instead slice the parsed records, render to text, and pipe to a fresh cheap-model call:

```
claude -p --output-format json < rendered-range.txt
```

Any range from any lane becomes summarizable, including ranges already rewound past. No risk of writing into the source.

**Templates.** Chosen at yank time: `findings` (what we learned), `decisions` (what we chose, what we rejected), `artifacts` (files touched, commands that worked).

**Deliver.** Three mechanisms, escalating:
1. Clipboard — zero machinery, works when the target isn't running. Ship first.
2. Pending file + `UserPromptSubmit` hook — ccTree writes `~/.cctree/pending/<session-id>.md`, the hook prepends and deletes. The graft rides along with a real message. This is the good version.
3. `claude -p --resume <target> "<block>"` — costs a response you didn't ask for. Only for targets you aren't sitting in.

The target must be at HEAD; injecting mid-history requires rewinding first.

### 5.4 Compare — `c`

Multi-source graft into a neutral lane. Grafting one arm's summary into the other and asking for a verdict is biased: the incumbent lane has full fidelity, the challenger has a paragraph, and richness wins. So `c` forks a fresh lane from the common ancestor and stages every arm's summary there.

Steps: yank each arm's delta against the shared ancestor → summarize all with the *same* template → fork from that ancestor → stage all blocks in one pending file.

Rendered format, working against position bias:

```
Two independent approaches were explored from the same
starting point. Neither is the current path.

── Approach: <label A> ──
<summary>

── Approach: <label B> ──
<summary>
```

Labels come from the refs map. Never "first/second" or "original/alternative" — those leak a preference. Shuffle order, record the seed; rerunning with the order inverted is the cheapest bias check available.

Cap at three or four arms. Beyond that, suggest a tournament — pairwise compares whose winners advance.

## 6. Graft records

```
{
  id, targetSession, targetAnchor, template, createdAt, orderSeed,
  sources: [
    { session, rangeStart, rangeEnd, mergeBase, label, digest }
  ]
}
```

One record, one `⊕` node, N dashed edges. Single-source graft is the n=1 case.

- `digest` = hash of `session + rangeStart + rangeEnd`. Repeat grafts warn rather than silently duplicate.
- `targetAnchor` = the turn the graft landed on, so the edge redraws correctly after the target grows.
- **Contamination guard**: once E–F is grafted into D, D is no longer independent. Before a compare, check whether any candidate arm contains a graft descended from another candidate; refuse or warn. Silent otherwise.
- **Staleness**: grafting from node X then continuing in the source leaves the edge pointing at X — correct, and it should stay correct. Show `⊕ 4 behind` so a refresh is discoverable. These are cherry-pick semantics: a snapshot, not a link.
- **No common ancestor** (e.g. a lane starting after `/clear`): summarize the whole source lane and flag it, since the block will be much larger.

## 7. Architecture

```
cctree/
├── .claude-plugin/plugin.json
├── bin/cctree              # graph build + render + companion
├── skills/show/SKILL.md        # /cctree:show
└── hooks/hooks.json            # SessionStart, SessionEnd, UserPromptSubmit
```

The plugin launches the companion, keeps the index warm, and delivers pending grafts. All real work is in `bin/`.

Persistent state at `~/.cctree/`: `index.json` (graph + refs + graft records), `pending/` (staged grafts).

## 8. Phases

**Phase 0 — Reader.** Tolerant JSONL parser. Read the five retained fields, treat everything else as opaque, never throw on unknown record kinds. Ship with a fixture corpus of real transcripts so format drift surfaces as a failing test, not a crash. Everything rests on this.

**Phase 1 — Graph and lanes.** Topo-sort by timestamp, allocate columns, free a column when its tip dies. Pure function, `Node[] → LaneAssignment[]`, no I/O, fully unit-testable. Two renderers over one model: ASCII and SVG.

**Phase 2 — Live companion.** File watcher on the project directory, redraw on append. Read-only. Useful on its own.

**Phase 3 — Navigation.** Selection state and the arrow keys. Every action resolves to a *command*; ship clipboard delivery first, since it's honest about what's happening and cannot corrupt a session.

**Phase 4 — Graft and compare.** Range extraction, stateless summarization, pending-file delivery via hook, graft records and provenance edges. Compare last.

**Phase 5 (later) — Working-tree awareness.** Sibling arms that used *restore code and conversation* sit on different file states, so two arms may hold conflicting edits to the same files, and whichever you rewound to last is what's on disk. For A/B on implementation approaches this is the likeliest thing to bite. Retain checkpoint references from phase 0 so this stays available.

## 9. Confirmed behaviour

- Rewinding to B and continuing produces a sibling under B; C and D remain on disk and remain listed in the rewind menu. Both arms stay reachable indefinitely.
- Grafting back into D after exploring E–F works: rewind to D, then the pending graft rides the next prompt.

## 10. Open risks

**Format drift.** Mitigated by phase 0 tolerance plus the fixture corpus. Accept that a release can still break rendering; make it degrade to "unknown node" rather than crash.

**Uuid preservation across `/branch`.** Fork-point detection assumes copied records keep their uuids. If not, fall back to a content hash or timestamp heuristic. Affects `/branch` lanes only — rewind-branches are unaffected.

**Session data is sensitive.** Transcripts contain source, paths, and anything a tool printed, including secrets from `.env` files or error logs. Any share or export feature needs redaction designed in from the start, not added later.

**Renderer choice deferred.** Ink versus localhost SPA. Phases 0–1 are renderer-independent, so this can wait until there's a graph to look at. Ink is the default assumption — living in a tmux split beside the session is the point, and a browser tab breaks that.

## Appendix — probe commands

```bash
F=~/.claude/projects/<project>/<session>.jsonl

# node shape
jq -r '[.uuid, .parentUuid, .type] | @tsv' "$F" | head -50

# any parent with 2+ children is a fork
jq -r '.parentUuid' "$F" | sort | uniq -d

# uuid overlap between a /branch pair — the last common one is the fork point
comm -12 <(jq -r '.uuid' "$ORIG" | sort) <(jq -r '.uuid' "$FORK" | sort) | wc -l
```
