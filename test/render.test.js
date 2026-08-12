// Connector geometry.
//
// Lanes are recycled once a tip dies, so a new arm can open in a column to the
// LEFT of the one it forked from. That shape only shows up in a merged
// multi-session view, which is why it survived until the picker was built.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseText } from '../src/parse.js';
import { buildGraph, annotate } from '../src/graph.js';
import { assignLanes } from '../src/lanes.js';
import { renderAscii } from '../src/render-ascii.js';

const at = (m) => `2026-08-08T10:${String(m).padStart(2, '0')}:00.000Z`;
const node = (uuid, parentUuid, minute, role = 'user') =>
  JSON.stringify({
    uuid,
    parentUuid,
    type: role,
    sessionId: 's1',
    timestamp: at(minute),
    message: { role, content: `text for ${uuid}` },
  });

/**
 * u1 forks to a1 (lane 0, dies immediately) and u2 (lane 1). u2 then forks: b1
 * inherits lane 1, and b2 has to open a lane — lane 0 is free again, so it opens
 * to the LEFT of its parent.
 */
const leftwardFork = () =>
  [
    node('u1', null, 1),
    node('a1', 'u1', 2),
    node('u2', 'u1', 3),
    node('b1', 'u2', 4),
    node('b2', 'u2', 5),
  ].join('\n');

test('a lane opening to the left draws its elbow the right way round', () => {
  const graph = annotate(buildGraph(parseText(leftwardFork()).records));
  const lanes = assignLanes(graph);

  const opens = lanes.rows.filter((r) => r.opensFrom != null);
  const leftward = opens.filter((r) => r.lane < r.opensFrom);
  assert.ok(leftward.length >= 1, 'the fixture really does recycle a column leftwards');

  const out = renderAscii(graph, lanes, { color: false });
  // The bug: `──├─`, an elbow pointing back the way the line came from.
  assert.ok(!out.includes('──├'), `elbow points the wrong way:\n${out}`);
  assert.ok(out.includes('┌─') || out.includes('┤'), `expected a leftward elbow:\n${out}`);
});

test('a lane opening to the right still draws the original shape', () => {
  const graph = annotate(
    buildGraph(parseText([node('u1', null, 1), node('c1', 'u1', 2), node('c2', 'u1', 3)].join('\n')).records),
  );
  const lanes = assignLanes(graph);
  const out = renderAscii(graph, lanes, { color: false });
  assert.ok(out.includes('├─'), `expected a rightward elbow:\n${out}`);
  assert.ok(out.includes('┐'), `expected the corner to close:\n${out}`);
});
