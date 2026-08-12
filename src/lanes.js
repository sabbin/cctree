// Phase 1b — column allocation. Pure: graph in, rows out, no I/O, no rendering.

import { transcriptEnds, trunkChildOf } from './graph.js';
//
// git log --graph semantics minus the hard part: a conversation tree has no
// merges, so a lane never has to absorb another lane. Lanes only open at a fork
// and close at a tip.
//
// The one wrinkle rewinds introduce: an arm is usually *finished* before its
// sibling starts, so by the time the second arm appears the parent's column has
// already gone quiet. If we let that column be recycled, a fork renders as a
// straight line and the whole point of the tool evaporates. So a lane stays
// reserved — drawn, unrecyclable — until every child of the fork it holds has
// been emitted.
//
// The second wrinkle, and it is the one that makes a tree read backwards: WHICH
// child keeps the parent's column. Chronologically the answer is "whichever came
// first", and that is wrong more often than not — a `/branch` is usually
// explored and abandoned BEFORE the trunk carries on, so the abandoned arm
// inherits the trunk's column and the conversation you are actually in gets
// drawn as the thing that forked off. Measured on this project's own test
// conversation: A, B in the trunk, `/branch` after B giving C and D, then back
// to the trunk for E, F, G — and C, D rendered as the spine.
//
// So the column follows HEAD, exactly as `git log --graph` keeps first-parent on
// the left: at a fork, the child on the path to HEAD keeps the parent's column
// and every other child opens one. Chronological ROW order is untouched — only
// which column a row lands in changes. With no HEAD the old rule stands, since
// then there is no "where you are" to privilege.

/**
 * @param {{nodes: Map, order: string[]}} graph
 * @returns {{rows: Array, width: number, laneOf: Map}}
 *   row = { uuid, lane, through: number[], opensFrom: number|null, closes: boolean }
 *   `through` = lanes that must draw a vertical bar on this row.
 */
export function assignLanes(graph) {
  const { nodes, order } = graph;

  // Which child keeps its parent's column, at every node that has a choice.
  //
  // This used to climb from HEAD, which is right in a single transcript and
  // wrong across several: HEAD sits in whichever copy was written last, so the
  // newest `/branch` took the trunk's column and the original conversation was
  // drawn as an arm off its own copy. `trunkChildOf` prefers the OLDEST
  // transcript and falls back to the latest arm within one — which is where
  // HEAD lands anyway, so the single-file behaviour is unchanged.
  const spineChild = new Map();
  for (const node of nodes.values()) {
    if (node.children.length > 1) spineChild.set(node.uuid, trunkChildOf(nodes, node));
  }

  const emitted = new Set();
  /** Is this parent still holding its column for a spine child yet to come? */
  const awaitingSpine = (parentUuid) =>
    spineChild.has(parentUuid) && !emitted.has(spineChild.get(parentUuid));

  const laneOf = new Map();
  const occupant = []; // occupant[lane] = uuid | null — who is live in this column
  const reserved = []; // reserved[lane] = forks in this column still owing children
  const rows = [];
  let width = 0;

  const live = (i) => occupant[i] != null || reserved[i] > 0;

  const freeLane = () => {
    for (let i = 0; i < occupant.length; i++) if (!live(i)) return i;
    occupant.push(null);
    reserved.push(0);
    return occupant.length - 1;
  };

  for (const uuid of order) {
    const node = nodes.get(uuid);
    const parent = node.parentUuid ? nodes.get(node.parentUuid) : null;
    const parentLane = parent && laneOf.has(parent.uuid) ? laneOf.get(parent.uuid) : null;

    let lane;
    let opensFrom = null;

    // The parent's column goes to its spine child. Any other child opens one,
    // even when it is the first to arrive — that is the whole fix: the column is
    // held open for a spine child that has not been emitted yet.
    const spine = spineChild.get(parent?.uuid ?? null);
    // A child that leaves a transcript behind opens its own column even when it
    // is an only child. `/branch` from the tip of a session forks nothing, so by
    // topology alone this chain is straight — but it is two conversations, and
    // drawing them as one line is what made a branch look like a continuation.
    const claims = (spine == null || spine === uuid) && !transcriptEnds(parent, node);

    if (parentLane != null && occupant[parentLane] === parent.uuid && claims) {
      lane = parentLane;
    } else {
      lane = freeLane();
      if (parentLane != null) {
        opensFrom = parentLane;
        reserved[parentLane] = Math.max(0, reserved[parentLane] - 1);
      }
    }

    const previousOccupant = occupant[lane];
    laneOf.set(uuid, lane);
    occupant[lane] = uuid;
    emitted.add(uuid);
    // Extra children will need columns of their own, later. Hold this one open.
    if (node.children.length > 1) reserved[lane] += node.children.length - 1;

    const through = [];
    for (let i = 0; i < occupant.length; i++) if (i !== lane && live(i)) through.push(i);

    const row = { uuid, lane, through, opensFrom, closes: node.children.length === 0, liveAfter: [] };
    rows.push(row);
    width = Math.max(width, occupant.length);

    if (node.children.length === 0) occupant[lane] = null; // tip: the column dies here
    if (
      parent &&
      parentLane != null &&
      lane !== parentLane &&
      occupant[parentLane] === parent.uuid &&
      // ...unless the spine child is still to come, in which case the column is
      // being kept FOR it. Killing it here is what made the trunk open a new
      // lane and read as the branch.
      !awaitingSpine(parent.uuid)
    ) {
      occupant[parentLane] = null; // parent's line moved on; nothing will inherit it
    }
    void previousOccupant;

    // Columns that still have to draw a vertical bar below this row.
    for (let i = 0; i < occupant.length; i++) if (live(i)) row.liveAfter.push(i);
  }

  return { rows, width, laneOf };
}
