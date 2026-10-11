// Locating transcripts. The encoding of a project path into a directory name
// under ~/.claude/projects is undocumented, so we try the obvious slug first and
// fall back to reading the `cwd` field out of candidate files.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const PROJECTS_DIR = join(CLAUDE_HOME, 'projects');

export function slugify(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function firstCwd(file) {
  try {
    const head = readFileSync(file, 'utf8').split('\n', 5);
    for (const line of head) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (typeof o?.cwd === 'string') return o.cwd;
      } catch {
        /* tolerant */
      }
    }
  } catch {
    /* tolerant */
  }
  return null;
}

/** Directory holding transcripts for a working directory. */
export function projectDir(cwd = process.cwd()) {
  const direct = join(PROJECTS_DIR, slugify(cwd));
  if (existsSync(direct)) return direct;
  if (!existsSync(PROJECTS_DIR)) return null;

  for (const entry of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, entry);
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files.slice(0, 3)) {
      if (firstCwd(join(dir, f)) === cwd) return dir;
    }
  }
  return null;
}

/**
 * When a transcript was first written. Not every filesystem records a birth
 * time; 0 means "unknown", and callers then decline to claim a direction
 * rather than inventing one.
 */
export function birthOf(file) {
  try {
    const st = statSync(file);
    return st.birthtimeMs > 0 ? st.birthtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * Oldest-CREATED first: the order the trunk rule needs (see `trunkRank` in
 * graph.js). Not mtime — writing into the original after branching it makes
 * the original the most recently modified, and sorting on that hands the trunk
 * to the copy. Falls back to mtime only where birth times are unknown.
 */
export const byCreation = (sessions) =>
  [...sessions].sort((a, b) => (a.birth && b.birth && a.birth !== b.birth ? a.birth - b.birth : a.mtime - b.mtime));

/** Sessions in a project dir, newest first. Includes subagent sidechains separately. */
export function listSessions(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      return { id: basename(f, '.jsonl'), path, mtime: st.mtimeMs, birth: st.birthtimeMs > 0 ? st.birthtimeMs : 0, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function listSubagents(dir) {
  const sub = join(dir || '', 'subagents');
  if (!dir || !existsSync(sub)) return [];
  return readdirSync(sub)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: basename(f, '.jsonl'), path: join(sub, f) }));
}

/** Resolve a --session argument: a path, a bare uuid, or nothing (= newest). */
export function resolveSession(arg, cwd = process.cwd()) {
  if (arg && (arg.includes('/') || arg.endsWith('.jsonl'))) {
    return { path: arg, id: basename(arg, '.jsonl'), dir: null };
  }
  const dir = projectDir(cwd);
  const sessions = listSessions(dir);
  if (!sessions.length) return null;
  if (!arg) return { ...sessions[0], dir };
  const hit = sessions.find((s) => s.id === arg || s.id.startsWith(arg));
  return hit ? { ...hit, dir } : null;
}
