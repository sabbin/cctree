---
name: show
description: Show the ccTree graph — a git-style view of this conversation's tree, including branches created by rewinding that the TUI no longer displays. Use when the user asks to see the conversation tree, graph, branches, lanes, forks, or wants to know what other arms of this conversation exist.
---

# Show the conversation graph

Run the bundled binary. It is on PATH whenever this plugin is enabled.

```bash
cctree show --no-color
```

Useful variants:

- `cctree show --all --no-color` — merge every session in this project directory, so `/branch` forks appear as one tree rather than several.
- `cctree show --raw --no-color` — do not collapse assistant/tool runs into single nodes.
- `cctree sessions` — list transcripts for this directory, newest first.
- `cctree stats` — record-kind histogram and parser issues. Run this after upgrading Claude Code; it is the format-drift canary.

## Branching

`cctree branch --at N` creates a new session holding everything *before* prompt
`#N`, so the user can ask `#N` differently. Rewind semantics: `#N` and everything
after it is left behind. It writes a new transcript and never touches the
original, then prints a `claude -r <id>` command.

Always run `--dry-run` first and show the user what would be kept and dropped.
Creating a session is cheap but it is still their conversation history — do not
branch without being asked to.

## Naming

`cctree name [session] "<alias>"` gives a conversation a name; `--clear` removes
it; with no alias it prints the current one. Aliases live in
`~/.cctree/sessions.json`, never in the transcript.

Most conversations are already named without you doing anything: ccTree reads
Claude Code's `ai-title`, and a branch inherits its nearest named ancestor plus a
`(Branch 2)` badge. Suggest an alias only when a conversation is genuinely
mislabelled — do not rename the user's history unprompted.

## Interactive view

`cctree tui` opens on the **conversations in this directory, drawn as a tree** —
branches nested under the session they were cut from, each row showing id, age,
prompt count and the prompt it left off at, with `← latest` on the most recently
active. The parentage is derived, not guessed: a `/branch` copy shares its whole
prefix, so the parent is the earlier-created session sharing the most uuids.
`enter` opens one as a tree, `n` names it, `esc` goes back, `a` merges them all.

Inside a tree: arrows/`jk` move, `enter` toggles detail, `b` branches at the
selected prompt, `o` resumes, `r` refreshes, `q` quits. It redraws as the
transcript grows, so it belongs in a tmux split beside the session.

`cctree tui --once --select N` aims a single frame at prompt `#N` (or a uuid
prefix) and prints its detail line. That is how you navigate the graph on the
user's behalf from inside a chat — re-run it as they move around.

`cctree-go` is the same TUI, but pressing `o` execs `claude -r` so the user lands
in the selected session. Recommend it when they want to *act* on an arm rather
than read it.

**Do not run `cctree tui` or `cctree-go` yourself** — both need a terminal and
will hold the session open waiting for keys that never arrive. Use
`cctree tui --once` or `cctree show`. Suggest the interactive forms and let the
user run them in their own terminal.

## Reading the output

| Glyph | Meaning |
|---|---|
| `●` | user prompt, numbered `#N` |
| `○` | assistant turn (tool runs collapsed) |
| `◆` | HEAD — where the session is now |
| `◇` | a tip that is not HEAD — an arm you rewound away from and can still return to |
| `⊙` | compaction or summary marker |
| `▪` | slash-command plumbing (the caveat/invocation/stdout records of a `/command`) |
| `?` | a record with a uuid whose shape is unrecognised — report it, it means format drift |

A `├─┐  forked after #N` row means a lane diverged after prompt `#N`. Treat these
with suspicion for now: parallel tool calls in one assistant turn also produce a
structural fork, so not every fork is a rewind (see CLAUDE.md, Open).

The header ends with `· N sidecar` (session-state records, correctly kept out of
the tree) and, if anything went unclassified, `· N UNKNOWN` — the drift alarm.

## Reporting back

Print the graph verbatim in a fenced block — it is aligned monospace art and
reflowing it destroys it. Then, briefly:

- Name the arms that are not HEAD, using their first prompt.
- If the user wants to get back to one, give the recipe rather than claiming to
  do it: `Esc Esc`, pick prompt `#N`, choose *restore conversation*. The rewind
  menu is interactive-only and cannot be driven programmatically.

Do not paraphrase node counts from memory; re-run the command instead.
