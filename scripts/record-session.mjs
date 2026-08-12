#!/usr/bin/env node
// SessionStart: remember which transcript belongs to which session.
//
// Two reasons this is worth a hook. The transcript path is handed to us
// authoritatively here, so we never have to guess how a cwd maps to a directory
// under ~/.claude/projects. And transcripts expire (cleanupPeriodDays, 30 by
// default) while ~/.cctree does not, so this is the first brick of the
// durable index the spec asks for.
//
// Never fails loudly: a hook that breaks a session start is worse than no hook.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.cctree');
const FILE = join(DIR, 'sessions.json');

function read() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(input || '{}');
    const id = ev.session_id;
    if (!id) process.exit(0);
    mkdirSync(DIR, { recursive: true });
    const db = read();
    const prev = db.sessions[id] || {};
    db.sessions[id] = {
      ...prev,
      transcriptPath: ev.transcript_path ?? prev.transcriptPath ?? null,
      cwd: ev.cwd ?? prev.cwd ?? null,
      source: ev.source ?? prev.source ?? null,
      firstSeen: prev.firstSeen ?? new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch {
    /* never block a session start */
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 2000).unref();
