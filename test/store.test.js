// ccTree's memory: ~/.cctree/sessions.json.
//
// Shared with the SessionStart hook, which writes transcript paths into the same
// file. An alias must never clobber what the hook recorded, and a store that has
// gone missing or been corrupted must degrade rather than throw — it sits in the
// startup path of every command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readStore, writeStore, readAliases, setAlias } from '../src/store.js';

const tempStore = () => join(mkdtempSync(join(tmpdir(), 'cctree-store-')), 'sessions.json');

test('a missing or corrupt store degrades to an empty one', () => {
  assert.deepEqual(readStore(join(tmpdir(), 'definitely-not-here-cctree.json')), { sessions: {} });

  const file = tempStore();
  writeFileSync(file, 'not json at all');
  assert.deepEqual(readStore(file), { sessions: {} }, 'garbage is not an error');

  writeFileSync(file, '{"unexpected":"shape"}');
  assert.deepEqual(readStore(file), { sessions: {} }, 'nor is a shape we do not recognise');
  rmSync(file, { force: true });
});

test('an alias never clobbers what the hook recorded', () => {
  const file = tempStore();
  // Exactly what scripts/record-session.mjs writes at SessionStart.
  writeStore(
    {
      sessions: {
        s1: { transcriptPath: '/p/s1.jsonl', cwd: '/work', source: 'startup', firstSeen: 'then' },
      },
    },
    file,
  );

  setAlias('s1', 'the refactor', file);
  const entry = readStore(file).sessions.s1;
  assert.equal(entry.alias, 'the refactor');
  assert.equal(entry.transcriptPath, '/p/s1.jsonl', 'the hook fields survive');
  assert.equal(entry.cwd, '/work');
  assert.equal(entry.firstSeen, 'then');
  rmSync(file, { force: true });
});

test('setting, trimming and clearing an alias', () => {
  const file = tempStore();
  setAlias('s1', '  padded name  ', file);
  assert.equal(readAliases(file).get('s1'), 'padded name', 'stored trimmed');

  setAlias('s1', null, file);
  assert.equal(readAliases(file).has('s1'), false, 'null clears it');
  assert.ok('s1' in readStore(file).sessions, 'but the entry itself remains');

  setAlias('s2', 'named', file);
  setAlias('s2', '   ', file);
  assert.equal(readAliases(file).has('s2'), false, 'whitespace clears it too');
  rmSync(file, { force: true });
});

test('aliases for sessions that were never named are absent, not empty strings', () => {
  const file = tempStore();
  writeStore({ sessions: { s1: { alias: 'named' }, s2: { cwd: '/x' }, s3: { alias: '' } } }, file);
  const aliases = readAliases(file);
  assert.deepEqual([...aliases.keys()], ['s1']);
  rmSync(file, { force: true });
});
