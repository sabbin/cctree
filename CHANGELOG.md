# Changelog

Notable changes to ccTree. Entries record *why* as well as *what*, because most
of what follows was a correction to a wrong idea rather than a new feature, and
the wrong idea is the part worth not repeating.

## [Unreleased]

The TUI redesign (`CCTREE-REDESIGN.md`), plus a run of layout corrections that
came out of testing it against real `/branch` and `/fork` conversations.

### Added

#### Colour depth (`src/palette.js`)

- **One palette, three tiers.** `colorDepth()` detects `NO_COLOR`,
  `FORCE_COLOR`, a pipe, `COLORTERM` and `TERM`, returning 0 / 4 / 8 / 24.
  `makePalette(depth)` renders one semantic vocabulary — `prompt`, `branch`,
  `head`, `graft`, `machine`, `faint` — as truecolor, 256-indexed or basic ANSI.
  Values are deliberately desaturated: a TUI sits on the user's own background
  for hours, and stock ANSI at full saturation is why terminal apps read as
  noisy.
- Renderers take `{ palette }` and **never build an escape themselves**, which
  is what keeps them pure and testable. `color: true` survives as shorthand for
  the 16-colour tier.
- `vlen`, `vtrunc` and `wrap` measure and cut by *visible* width. `vtrunc`
  emits escapes found past the cut — dropping the closing `\x1b[0m` of a span
  that began before it bleeds that colour across the whole pane, which is the
  failure you actually see.
- Nothing is distinguished by colour alone: every state also has a glyph or a
  position, so the 16-colour and no-colour tiers lose polish, not meaning.

#### Session picker (`src/session-list.js`)

- Column header, generated from the same width table the rows use, so a field
  cannot pad itself one way in a row and another way in the header.
- The name gets its own column, so **every preview starts at the same screen
  column**. Invisible at 100 columns, the dominant defect at 200.
- Preview clamped to 20–72 columns; the leftover stays empty, because the right
  margin is what lets a column read as a column.
- ` prompts` and ` ago` dropped from every row — the header says what they are.
- Inherited names take a dim `↳` instead of being dimmed wholesale; the badge
  steps outside the dimming and carries its own hue (branch / graft). Dim plus
  truncation made the name hard to read *and* dimmed the one part that told two
  arms apart.
- `← latest` moved off the right edge, where truncation ate it first, into the
  gutter and the id's colour.
- Blank row between top-level conversations, spent only where a family actually
  exists.

#### Tree view (`src/render-ascii.js`)

- `#N` moved out of the label into a fixed gutter left of the lane art, so the
  numbers line up whatever depth a node sits at.
- The link row is suppressed between a prompt and the reply beneath it; a bar
  before every row spent half the screen on `│` and flattened the tree into one
  texture.
- Fork notes get their own row, indented to the arm they describe.
- HEAD is a green `◆` and a right-aligned `← HEAD` instead of a bold green row
  that drowned every other signal.
- `renderHeader` pluralises (`1 lane`, not `1 lanes`).

#### Split view (`src/tui.js`)

- `enter` toggles detail; `tab` opens the pane. Tree mode docks a node's
  fields; the picker docks the selected conversation's timeline, rendered by
  the same `renderAsciiRows` the printed view uses.
- `detailOf()` and `detailLines()` read one shared field list, so the one-line
  and pane presentations cannot drift.
- **Refused below 120 columns**, never squeezed, and recomputed per frame so a
  resize restores it with no keypress.
- The selection is a background tint that stops at the divider — not reverse
  video, which flattens every colour the picker exists to draw.
- `--once --pane` prints one frame with the pane open.

#### Conversations as trees

- **`f` opens the whole family.** Entering a conversation now loads its root and
  every descendant, not one file. A conversation is usually several transcripts
  — a `/branch` is a copy, a `/fork` is a sibling — and opening one file drew a
  straight line through what the picker was already showing as a tree.
- **An unused `/fork` gets a placed stub.** It has no records at all, so a
  merged view omitted it entirely: a tree claiming to show the whole
  conversation with a limb sawn off. `forkStubs()` synthesises one record,
  attached to the parent's last record at or before the fork's creation time,
  marked `inferred` and rendered as `⑂ fork · no prompt yet · placed by creation
  time`.

### Changed

#### Row order is depth-first, not chronological

Chronology holds *within* a lane; between lanes, structure wins.

The old layout ordered rows by timestamp, so an arm's first node landed wherever
its clock said and its connector met a **column** rather than the row it left. A
branch of a branch was pushed below arms it has nothing to do with, purely
because it was written later — measured on a four-session family, `M/N/O`
branched from `D` rendered ten rows below `Z`, a sibling of `D`'s entire arm.

Depth-first draws each arm whole before the next begins, so an arm's first node
sits directly under its parent and the elbow lands where the split is. The trunk
child is drawn **last**, so the trunk column runs unbroken down the left and ends
at the bottom.

Costs, both real: rows are no longer a timeline, and `#N` counts down the tree
rather than through the clock. Measured against every fixture, the node sequence
is byte-identical for a single transcript — ties inside one file break to the
latest arm, which is what chronological order already produced — so this only
ever moves rows in a merged view, which is the only place it was wrong.

#### The trunk is the oldest transcript, not the one holding HEAD

A `/branch` copy is always younger than what it copied, so the arm still
carrying the original file is the one that was there first. `trunkChildOf()`
picks it, and both the row order and the lane allocator read that one function
so they cannot disagree.

HEAD was the earlier rule: right for one transcript, wrong across several, since
HEAD sits in whichever copy was written last — so the newest `/branch` took the
trunk's column and the original conversation was drawn as an arm off its own
copy. Within one transcript nothing ranks the arms that way, so the tie goes to
the latest, which is where HEAD lands anyway.

#### The lane follows the conversation, not the clock

At a split, the arm on the trunk keeps the parent's column and the others
depart. Previously the *first arm emitted* kept it — and a `/branch` is usually
explored and abandoned before the trunk carries on, so the abandoned arm
inherited the trunk's column and the conversation you were actually in was drawn
as the thing that forked off.

#### `HEAD` is the newest record anywhere in the view

Not the last line of the last file. Those agree for one transcript and stop
agreeing the moment a family is open: files are listed oldest-created-first, so
"the last file" is the copy you made and then left. Measured — a trunk continued
five minutes after its branch file was created still had HEAD sitting in the
branch. Fork stubs are excluded: an unused `/fork` carries its file's creation
time and is routinely the newest thing in a view, but nobody has been there.

#### "Fork" no longer means three different things

A rewind, a `/branch` and a `/fork` all put two children on one node, and the
graph cannot tell which did it. The display now says **split**, never fork, and
`⑂` — the character `/fork` writes into its own session title — is reserved for
a real `/fork`. `graph.forks` became `graph.splits`; `N forks` in the header
became `N splits`.

#### Both arms of a split are labelled

The arm that keeps its parent's column has diverged just as much — nothing about
it *moved*, which is precisely why the layout said nothing about it, and a reader
who had run `/branch` twice off one prompt saw only one branch. The trunk arm
says `#N continues`, never `split`: calling it a split makes the original a
branch of its own copy. The split row itself carries `N arms`.

In a merged view each arm also names the transcript it is (`→ 0f0e0d0c`), since
an arm *is* a session you can resume.

#### A `/branch` from the tip of a session is drawn as a departure

It forks nothing: the original never continues, so its last node has exactly one
child and the chain runs straight on into a different file — a branch you made,
drawn as a continuation, with `(N sessions)` quietly dropping as the only
evidence. `transcriptEnds()` now opens a column there too, and the connector
says `branched after #N → <new> · <old> ends here`. Scoped to linear chains:
at a split every arm holds a subset of its parent's files, so testing the sets
there would call each arm the end of the sessions that went the other way.

`collapse()` no longer merges a run across such a boundary — a run that
swallowed one hid the branch point inside an opaque `assistant · N msgs`.

### Fixed

- Picker rows wrapped at 80 columns: the name and the trailing prompt were
  budgeted independently (`width - 18` plus `width / 2` again on top).
- The name column now reserves room for a badge it may not truncate, and lets
  the preview yield instead of overflowing the row.
- `(N sessions)` was appended after the preview was already truncated, pushing
  merged tree rows past the terminal edge.
- The tree was rendered to the full width and cut to the pane afterwards, which
  pushed `← HEAD` off the end of every row.
- `tab` did nothing with detail off while the keybar advertised `tab pane`.
- The picker's timeline pane loaded one file instead of the family.
- Session boundaries were detected from `node.sessions`, which falls back to the
  *file path* for records with no `sessionId` — a single transcript holding both
  kinds reported a boundary that does not exist, naming half a path where a
  session id belongs.
- TUI status lines emitted raw escapes under `NO_COLOR`.

### Notes for the next person

- The leftward-elbow case is now **unreachable from a real transcript**: every
  column to an arm's left is held for a trunk child not yet emitted, so
  `freeLane` can only return a column to the right. The logic stays because the
  geometry is still wrong if it ever happens, and it is tested through a
  hand-built lane layout rather than a fixture that can no longer produce it.
- `lanes.js` is still pure, but no longer a function of topology alone — it
  reads `trunkRank`, which comes from the order the caller passes files in.
  Callers must pass transcripts **oldest first**.
- Verification that these changes are held to: `frame()` without a pane is
  byte-identical to before the split view; every renderer's depth-0 output is
  byte-identical to its `color: false` output; and all four colour tiers produce
  identical column arithmetic once escapes are stripped.
