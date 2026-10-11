// `cctree show --family` and `--all` against a real project directory layout.
//
// The shape is the one that exposed the bug: a → b, `/branch`, then i in the
// copy — and AFTERWARDS az written into the original. The original is now the
// most recently MODIFIED file, so any ordering by mtime hands the trunk to the
// copy and draws the original conversation as an arm off its own branch. Only
// creation order (birthtime) says which came first, because a copy's records
// carry the original timestamps.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify } from '../src/sessions.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cctree.mjs');
const at = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;
const line = (sessionId, o) => JSON.stringify({ sessionId, ...o }) + '\n';
const user = (s, uuid, parentUuid, text, n) =>
  line(s, { type: 'user', uuid, parentUuid, timestamp: at(n), message: { role: 'user', content: text } });
const said = (s, uuid, parentUuid, n) =>
  line(s, { type: 'assistant', uuid, parentUuid, timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

const ORIG = 'aaaaaaaa-1111-4000-8000-000000000001';
const COPY = 'bbbbbbbb-2222-4000-8000-000000000002';
const STRANGER = 'cccccccc-3333-4000-8000-000000000003';

// Files written in the same instant share a birthtime, and then nothing says
// which came first. A real `/branch` is seconds apart; a test has to wait.
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

const homes = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

/** A project dir holding the original, its branch, and an unrelated session. */
function project() {
  const home = mkdtempSync(join(tmpdir(), 'cctree-family-'));
  homes.push(home);
  const cwd = '/work/demo';
  const dir = join(home, 'projects', slugify(cwd));
  mkdirSync(dir, { recursive: true });
  const prefix = (s) => user(s, 'a', null, 'test a', 1) + said(s, 'a1', 'a', 2) + user(s, 'b', 'a1', 'test b', 3) + said(s, 'b1', 'b', 4);

  writeFileSync(join(dir, `${ORIG}.jsonl`), prefix(ORIG)); // created first
  tick();
  writeFileSync(join(dir, `${COPY}.jsonl`), prefix(COPY) + user(COPY, 'i', 'b1', 'test i', 5) + said(COPY, 'i1', 'i', 6));
  tick();
  writeFileSync(join(dir, `${STRANGER}.jsonl`), user(STRANGER, 'z', null, 'unrelated', 7) + said(STRANGER, 'z1', 'z', 8));
  tick();
  // Back in the original, after the branch: now it is the newest by mtime.
  appendFileSync(join(dir, `${ORIG}.jsonl`), user(ORIG, 'az', 'b1', 'test az', 9) + said(ORIG, 'az1', 'az', 10));
  return { home, cwd };
}

const show = ({ home, cwd }, ...args) =>
  execFileSync('node', [BIN, 'show', '--no-color', '--cwd', cwd, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    encoding: 'utf8',
  });

test('the original stays the trunk under --all, however recently it was written', () => {
  const out = show(project(), '--all');
  assert.match(out, /split after #2 test b → bbbbbbbb/, 'the copy is the arm');
  assert.match(out, /#2 continues → aaaaaaaa/, 'the original carries on');
});

test('--family draws the branch point from inside the copy, and leaves strangers out', () => {
  const p = project();
  // On its own the copy is a straight line a → b → i: it holds its whole prefix.
  assert.doesNotMatch(show(p, COPY), /split/);

  const out = show(p, COPY, '--family');
  assert.match(out, /\(2 sessions\)/);
  assert.match(out, /split after #2 test b → bbbbbbbb/);
  assert.match(out, /#2 continues → aaaaaaaa/);
  assert.doesNotMatch(out, /unrelated/, 'a family is one conversation, not the project');
});

test('a switch never swallows the session named after it', () => {
  const p = project();
  // `--no-color` and `--family` are switches; the id after them is the session.
  // Read as their value, the CLI fell back to the newest transcript instead.
  const out = show(p, '--family', COPY);
  assert.match(out, /bbbbbbbb-2222/);
  assert.match(out, /split after #2 test b/);
});
