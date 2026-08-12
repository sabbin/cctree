// ccTree's own memory: ~/.cctree/sessions.json.
//
// The SessionStart hook already creates this file to record which transcript
// belongs to which session, for the reason in scripts/record-session.mjs:
// transcripts expire (cleanupPeriodDays, 30 by default) and this does not. User
// aliases live in the same place, so there is one durable index rather than two.
//
// Deliberately NOT stored in the transcript. Claude Code has its own title
// sidecars (`ai-title`, `custom-title`) and appending our own would mean writing
// into a session file — the one thing this project does not do. Reading theirs
// and layering ours on top keeps that invariant intact.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STORE_DIR = process.env.CCTREE_HOME || join(homedir(), '.cctree');
export const STORE_FILE = join(STORE_DIR, 'sessions.json');

/** Never throws: a corrupt or missing store degrades to an empty one. */
export function readStore(file = STORE_FILE) {
  try {
    const db = JSON.parse(readFileSync(file, 'utf8'));
    if (db && typeof db === 'object' && db.sessions && typeof db.sessions === 'object') return db;
  } catch {
    /* missing, unreadable, or garbage — all the same to us */
  }
  return { sessions: {} };
}

export function writeStore(db, file = STORE_FILE) {
  // dirname(file), not STORE_DIR: callers may point elsewhere (tests do), and
  // creating a directory nobody asked for is a side effect waiting to confuse.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(db, null, 2)}\n`);
  return db;
}

/** Aliases as a plain id -> name map, for the render path. */
export function readAliases(file = STORE_FILE) {
  const db = readStore(file);
  const out = new Map();
  for (const [id, entry] of Object.entries(db.sessions)) {
    if (entry && typeof entry.alias === 'string' && entry.alias.trim()) out.set(id, entry.alias.trim());
  }
  return out;
}

/**
 * Set or clear one alias, preserving whatever the hook recorded alongside it.
 * @param {string|null} alias null or '' clears it
 */
export function setAlias(id, alias, file = STORE_FILE) {
  const db = readStore(file);
  const prev = db.sessions[id] || {};
  const next = String(alias ?? '').trim();
  if (next) prev.alias = next;
  else delete prev.alias;
  db.sessions[id] = prev;
  writeStore(db, file);
  return next || null;
}

export function storeExists(file = STORE_FILE) {
  return existsSync(file);
}
