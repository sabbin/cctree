// Synthetic fixtures. These encode the two branch mechanisms from spec §3.2 so
// the lane allocator has something to chew on before real transcripts arrive.
//
// Replace / supplement these with redacted real transcripts:
//   cctree fixture <session> --out test/fixtures/real-<version>.jsonl

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'fixtures');
mkdirSync(out, { recursive: true });

let t = Date.parse('2026-08-01T10:00:00.000Z');
const tick = () => new Date((t += 30_000)).toISOString();

const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const rec = (uuid, parentUuid, type, extra = {}) => ({
  parentUuid,
  isSidechain: false,
  userType: 'external',
  cwd: '/home/dev/work/demo',
  sessionId: SESSION_A,
  version: '2.1.99',
  gitBranch: 'main',
  type,
  uuid,
  timestamp: tick(),
  ...extra,
});

const prompt = (uuid, parent, text) =>
  rec(uuid, parent, 'user', { message: { role: 'user', content: text } });

const reply = (uuid, parent, text) =>
  rec(uuid, parent, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text }] } });

const toolUse = (uuid, parent, name, id) =>
  rec(uuid, parent, 'assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', name, id }] } });

const toolResult = (uuid, parent, id) =>
  rec(uuid, parent, 'user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } });

// ── session A: linear, then a rewind fork under prompt B ────────────────────
const a = [];
a.push(prompt('u1', null, 'scaffold the manifest'));
a.push(reply('a1', 'u1', 'Created plugin.json.'));
a.push(prompt('u2', 'a1', 'add the jsonl parser'));
a.push(toolUse('a2', 'u2', 'Write', 'tu_1'));
a.push(toolResult('r2', 'a2', 'tu_1'));
a.push(reply('a3', 'r2', 'Parser written.'));

// arm 1 — explored, then abandoned by a rewind
a.push(prompt('u3', 'a3', 'wire up the lane allocator with elkjs'));
a.push(toolUse('a4', 'u3', 'Edit', 'tu_2'));
a.push(toolResult('r4', 'a4', 'tu_2'));
a.push(reply('a5', 'r4', 'elkjs pulled in, 400kb.'));

// arm 2 — rewound to a3, second approach. Sibling under the same parent.
a.push(prompt('u4', 'a3', 'no, hand-roll the lane allocator'));
a.push(toolUse('a6', 'u4', 'Edit', 'tu_3'));
a.push(toolResult('r6', 'a6', 'tu_3'));
a.push(reply('a7', 'r6', 'Hand-rolled, 90 lines, no deps.'));

// ── session B: /branch copy — prefix records keep their uuids ───────────────
const b = a.slice(0, 6).map((r) => ({ ...r, sessionId: SESSION_B }));
b.push(prompt('u5', 'a3', 'try a completely different data model'));
b.push(reply('a8', 'u5', 'Modelling records as an event log instead.'));
b.forEach((r) => (r.sessionId = SESSION_B));

// ── session C: compaction and a dangling parent (expired transcript) ────────
const c = [];
c.push(rec('c0', 'GONE-parent-from-expired-transcript', 'user', {
  isCompactSummary: true,
  message: { role: 'user', content: 'Previous conversation summarized.' },
}));
c.push(prompt('c1', 'c0', 'continue where we left off'));
c.push(reply('c2', 'c1', 'Resuming.'));
c.push({ type: 'summary', summary: 'Lane allocator work', leafUuid: 'c2' });

// ── sessions D/E: one parallel turn, written the two ways a transcript writes
// it. Same conversation, same tool calls, same results — the only difference is
// whether the second call was recorded before or after the first result landed.
// Measured on real transcripts: 8 of 14 parallel runs linear, 6 forked. The
// forked one puts the NEXT turn on the first result, which is what makes a
// naive "append the sibling to the result" fix relocate the fork instead of
// removing it. Both files must produce byte-identical topology.
const REQ = 'req_parallel_turn';
const NEXT = 'req_next_turn';

const say = (uuid, parent, text, requestId) =>
  rec(uuid, parent, 'assistant', { requestId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (uuid, parent, name, id, requestId) =>
  rec(uuid, parent, 'assistant', { requestId, message: { role: 'assistant', content: [{ type: 'tool_use', name, id }] } });

// linear: each call chained onto the previous call's result
const d = [];
d.push(prompt('p1', null, 'read both files'));
d.push(say('t1', 'p1', 'Reading them now.', REQ));
d.push(call('A', 't1', 'Read', 'tu_a', REQ));
d.push(toolResult('rA', 'A', 'tu_a'));
d.push(call('B', 'rA', 'Read', 'tu_b', REQ));
d.push(toolResult('rB', 'B', 'tu_b'));
d.push(say('t2', 'rB', 'Both read.', NEXT));

// forked: the second call chained onto the first CALL, so A has two children —
// its own result and its sibling — and the next turn hangs off the first result
const e = [];
e.push(prompt('p1', null, 'read both files'));
e.push(say('t1', 'p1', 'Reading them now.', REQ));
e.push(call('A', 't1', 'Read', 'tu_a', REQ));
e.push(call('B', 'A', 'Read', 'tu_b', REQ));
e.push(toolResult('rA', 'A', 'tu_a'));
e.push(toolResult('rB', 'B', 'tu_b'));
e.push(say('t2', 'rA', 'Both read.', NEXT));

const write = (name, rows) =>
  writeFileSync(join(out, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

write(`${SESSION_A}.jsonl`, a);
write(`${SESSION_B}.jsonl`, b);
write('cccccccc-0000-4000-8000-000000000003.jsonl', c);
write('parallel-linear.jsonl', d);
write('parallel-forked.jsonl', e);

// Deliberately broken, to prove the parser degrades instead of dying.
writeFileSync(
  join(out, 'broken.jsonl'),
  [
    JSON.stringify(prompt('x1', null, 'ok')),
    '{ not json at all',
    '[]',
    JSON.stringify({ type: 'brand-new-record-kind-from-a-future-release', uuid: 'x2', parentUuid: 'x1' }),
    '{"uuid":"x3","parentUuid":"x2","type":"user","message":{"role":"user","content":"trunc',
  ].join('\n'),
);

console.log(`wrote fixtures to ${out}`);
