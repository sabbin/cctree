// Phase 1b — column allocation. Pure: graph in, rows out, no I/O, no rendering.
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

/**
 * @param {{nodes: Map, order: string[]}} graph
 * @returns {{rows: Array, width: number, laneOf: Map}}
 *   row = { uuid, lane, through: number[], opensFrom: number|null, closes: boolean }
 *   `through` = lanes that must draw a vertical bar on this row.
 */
export function assignLanes(graph) {
  const { nodes, order } = graph;

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

    if (parentLane != null && occupant[parentLane] === parent.uuid) {
      lane = parentLane; // first child emitted inherits the parent's column
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
    // Extra children will need columns of their own, later. Hold this one open.
    if (node.children.length > 1) reserved[lane] += node.children.length - 1;

    const through = [];
    for (let i = 0; i < occupant.length; i++) if (i !== lane && live(i)) through.push(i);

    const row = { uuid, lane, through, opensFrom, closes: node.children.length === 0, liveAfter: [] };
    rows.push(row);
    width = Math.max(width, occupant.length);

    if (node.children.length === 0) occupant[lane] = null; // tip: the column dies here
    if (parent && parentLane != null && lane !== parentLane && occupant[parentLane] === parent.uuid) {
      occupant[parentLane] = null; // parent's line moved on; nothing will inherit it
    }
    void previousOccupant;

    // Columns that still have to draw a vertical bar below this row.
    for (let i = 0; i < occupant.length; i++) if (live(i)) row.liveAfter.push(i);
  }

  return { rows, width, laneOf };
}
