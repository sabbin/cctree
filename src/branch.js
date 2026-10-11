// Phase 2a — programmatic branching.
//
// `/branch` turns out not to be a privileged TUI operation. Measured against a
// real branch of this project's own session: all 291 uuids survive the copy, and
// the ONLY field that changes is `sessionId`, rewritten to the new id on every
// record. `uuid` and `parentUuid` are preserved verbatim, which is exactly why
// graph.js can dedupe a copy against its original and recover the fork point.
//
// So a branch is: take the records before the chosen prompt, rewrite sessionId,
// write a new <uuid>.jsonl beside the original. Nothing existing is modified —
// this creates a file, it never opens one for writing.
//
// Lines are re-serialised from the parsed object rather than rebuilt from our
// normalized records: the parser deliberately keeps only the fields it
// understands, and a branch must preserve everything, including fields this
// build has never heard of.

/** Session-id keys seen in the wild. Both appear on real records. */
const SESSION_KEYS = ['sessionId', 'session_id'];

/**
 * Work out what a branch at prompt #N would contain.
 *
 * Semantics are the rewind menu's, not "continue after N": the new session holds
 * everything STRICTLY BEFORE prompt #N, so you land back at the moment you typed
 * it and can ask something else instead. Branching at #1 would yield an empty
 * conversation, which is refused rather than silently written.
 *
 * @param {object[]} records normalized, from one transcript, in file order
 * @param {number} atPromptNo 1-based prompt number as shown by `cctree show`
 */
export function planBranch(records, atPromptNo) {
  const prompts = records.filter((r) => r.kind === 'prompt');
  const target = prompts[atPromptNo - 1];
  if (!target) {
    return {
      ok: false,
      reason: `no prompt #${atPromptNo} (this session has ${prompts.length})`,
      available: prompts.length,
    };
  }
  if (atPromptNo === 1) {
    return {
      ok: false,
      reason: 'branching before #1 would produce an empty session',
      available: prompts.length,
    };
  }
  return {
    ok: true,
    target,
    cutLine: target.line, // 1-based; everything before this line is kept
    keptLines: target.line - 1,
    droppedPrompts: prompts.length - (atPromptNo - 1),
  };
}

/**
 * Work out a branch that ends exactly at one node: the conversation as it stood
 * the moment `uuid` was written, on whichever arm it sits.
 *
 * `planBranch` cuts the FILE, which is right only on the trunk. After a rewind
 * the lines just before a prompt can belong to the arm that was abandoned, so a
 * prefix of the file ends on the wrong arm and a resume continues that one. The
 * arm is the parentUuid chain, so this keeps the chain and nothing it did not
 * lead to — plus two things the chain alone would lose:
 *
 *   - tool_results hanging off a kept tool_use. The forked encoding of parallel
 *     calls (see linearizeTurns) puts the result of the first call BESIDE the
 *     chain, not on it; dropping it leaves a tool_use with no result, which the
 *     API refuses.
 *   - sidecars before the cut, except those naming a leaf (`last-prompt`,
 *     `summary`): those point at wherever the original ended, not here.
 *
 * Ancestry follows `logicalParentUuid` across a compaction boundary as well,
 * which the boundary record carries in place of a parent.
 *
 * @param {object[]} records normalized, from one transcript, in file order
 * @param {string} uuid the node the branch ends on, inclusive
 */
export function planBranchTo(records, uuid) {
  const byUuid = new Map();
  for (const r of records) if (r.uuid && !byUuid.has(r.uuid)) byUuid.set(r.uuid, r);
  const target = byUuid.get(uuid);
  if (!target) return { ok: false, reason: `no record ${uuid} in this transcript` };

  const chain = new Set();
  for (let cur = target; cur && !chain.has(cur.uuid); ) {
    chain.add(cur.uuid);
    const up = cur.parentUuid ?? (typeof cur.raw?.logicalParentUuid === 'string' ? cur.raw.logicalParentUuid : null);
    cur = up ? byUuid.get(up) : null;
  }

  const keepLines = new Set();
  for (const r of records) {
    if (r.line > target.line) continue;
    const keep = r.uuid
      ? chain.has(r.uuid) || (r.toolResultFor?.length > 0 && chain.has(r.parentUuid))
      : !r.leafUuid && r.kind !== 'summary';
    if (keep) keepLines.add(r.line);
  }
  return { ok: true, target, keepLines, chainLength: chain.size };
}

/**
 * Produce the branch file's contents.
 * @returns {{text: string, kept: number, rewritten: number}}
 */
export function buildBranchText(sourceText, { cutLine = Infinity, keepLines = null, newSessionId }) {
  const out = [];
  let rewritten = 0;

  const lines = sourceText.split('\n');
  for (let i = 0; i < lines.length && i < cutLine - 1; i++) {
    // `keepLines` (1-based, from planBranchTo) selects an arm; without it the
    // whole prefix is kept, which is what `/branch` itself does.
    if (keepLines && !keepLines.has(i + 1)) continue;
    const line = lines[i];
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      // The tolerance rule applies here too: an unparseable line is carried
      // across untouched rather than dropped. It was in the original.
      out.push(line);
      continue;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      let touched = false;
      for (const k of SESSION_KEYS) {
        if (typeof raw[k] === 'string') {
          raw[k] = newSessionId;
          touched = true;
        }
      }
      if (touched) rewritten++;
      out.push(JSON.stringify(raw));
    } else {
      out.push(line);
    }
  }

  return { text: out.length ? out.join('\n') + '\n' : '', kept: out.length, rewritten };
}
