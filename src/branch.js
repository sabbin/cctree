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
 * Produce the branch file's contents.
 * @returns {{text: string, kept: number, rewritten: number}}
 */
export function buildBranchText(sourceText, { cutLine, newSessionId }) {
  const out = [];
  let rewritten = 0;

  const lines = sourceText.split('\n');
  for (let i = 0; i < lines.length && i < cutLine - 1; i++) {
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
