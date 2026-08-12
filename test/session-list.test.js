// Phase 3b — the session picker.
//
// The interesting property is the one a file listing cannot have: because a
// `/branch` copy keeps every uuid of the prefix it was cut from, a uuid
// intersection identifies sessions that are the same conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeSessions, renderSessionRows, familyFiles } from '../src/session-list.js';

const rec = (uuid, kind, ts, preview = '') => ({
  uuid,
  kind,
  timestamp: Date.parse(ts),
  preview,
});

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

const BORN = Date.parse('2026-08-08T09:30:00.000Z');

const entries = () => [
  {
    id: 'original',
    file: '/p/original.jsonl',
    createdAt: BORN,
    records: [
      rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'first question'),
      rec('a1', 'assistant', '2026-08-08T10:01:00.000Z'),
      rec('u2', 'prompt', '2026-08-08T10:02:00.000Z', 'second question'),
    ],
  },
  {
    id: 'branched',
    file: '/p/branched.jsonl',
    // Created after `original`, which is the only reason we can tell which of
    // the two is the branch — their shared records carry identical timestamps.
    createdAt: BORN + 60_000,
    records: [
      // The copied prefix keeps its uuids...
      rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'first question'),
      rec('a1', 'assistant', '2026-08-08T10:01:00.000Z'),
      // ...then diverges.
      rec('b1', 'prompt', '2026-08-08T11:30:00.000Z', 'a different second question'),
    ],
  },
  {
    id: 'unrelated',
    file: '/p/unrelated.jsonl',
    createdAt: BORN - 60_000,
    records: [rec('z1', 'prompt', '2026-08-08T09:00:00.000Z', 'nothing to do with the others')],
  },
];

test('both ends of the prompt list are kept, neither is the label', () => {
  const rows = describeSessions(entries(), { now: NOW });
  const branched = rows.find((r) => r.id === 'branched');
  assert.equal(branched.firstPrompt, 'first question');
  assert.equal(branched.lastPrompt, 'a different second question');
  assert.equal(branched.prompts, 2, 'assistant turns are not prompts');
});

test('a row is labelled by where it left its parent, not either end', () => {
  const rows = describeSessions(entries(), { now: NOW });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // A root has no parent to diverge from, so its identity IS its opening
  // prompt — the thing you recognise a conversation by.
  assert.equal(byId.original.divergePrompt, 'first question');
  assert.equal(byId.original.divergedFromParent, false);
  // A branch shares that opening prompt, so showing it would make the two rows
  // identical. What distinguishes it is the first prompt it does NOT share.
  assert.equal(byId.branched.divergePrompt, 'a different second question');
  assert.equal(byId.branched.divergedFromParent, true);

  const text = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'branched').text;
  assert.match(text, /a different second question/);
});

test('a branch that was cut but never continued falls back to its cut point', () => {
  // It shares EVERY prompt with its parent, so there is no divergence to show
  // and the opening prompt would make it identical to every other arm — the
  // exact failure the divergence label replaced. Two such branches off one
  // parent must still read differently, so the cut point is what distinguishes.
  const parent = {
    id: 'parent',
    file: '/p/parent.jsonl',
    createdAt: 1000,
    records: [
      rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'shared opening'),
      rec('u2', 'prompt', '2026-08-08T10:05:00.000Z', 'cut here for one'),
      rec('u3', 'prompt', '2026-08-08T10:10:00.000Z', 'cut here for the other'),
    ],
  };
  const cutEarly = {
    id: 'cutEarly',
    file: '/p/a.jsonl',
    createdAt: 2000,
    records: parent.records.slice(0, 2),
  };
  const cutLate = { id: 'cutLate', file: '/p/b.jsonl', createdAt: 3000, records: parent.records.slice(0, 3) };
  const rows = describeSessions([parent, cutEarly, cutLate], { now: NOW });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.cutEarly.divergedFromParent, false, 'nothing of its own');
  assert.equal(byId.cutEarly.divergePrompt, 'cut here for one');
  assert.equal(byId.cutLate.divergePrompt, 'cut here for the other');
  assert.notEqual(byId.cutEarly.divergePrompt, byId.cutLate.divergePrompt, 'still tellable apart');
});

test('most recently active first, regardless of when it started', () => {
  const rows = describeSessions(entries(), { now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ['branched', 'original', 'unrelated']);
  assert.equal(rows[0].ageLabel, '30m');
  assert.equal(rows[2].ageLabel, '3h');
});

test('shared uuids identify sessions that are the same conversation', () => {
  const rows = describeSessions(entries(), { now: NOW });
  const original = rows.find((r) => r.id === 'original');
  const branched = rows.find((r) => r.id === 'branched');
  const unrelated = rows.find((r) => r.id === 'unrelated');

  assert.deepEqual(original.shares, [{ id: 'branched', count: 2 }], 'the copied prefix is the evidence');
  assert.deepEqual(branched.shares, [{ id: 'original', count: 2 }], 'and the relation is symmetric');
  assert.deepEqual(unrelated.shares, [], 'a separate conversation shares nothing');
});

test('which sessions are branches, and of what', () => {
  const rows = describeSessions(entries(), { now: NOW });
  const original = rows.find((r) => r.id === 'original');
  const branched = rows.find((r) => r.id === 'branched');
  const unrelated = rows.find((r) => r.id === 'unrelated');

  assert.deepEqual(branched.parent, { id: 'original', shared: 2 }, 'the later file is the branch');
  assert.deepEqual(original.children, ['branched']);
  assert.equal(original.parent, null, 'the origin is nobody\'s branch');
  assert.equal(unrelated.parent, null);
  assert.deepEqual(unrelated.children, [], 'sharing nothing means no relationship');
});

test('the parent is the session sharing the most prefix, not merely an older one', () => {
  // The trap: a parent that keeps growing ends up a SUPERSET of its own child,
  // so a subset test points the wrong way. Measured on this project, where the
  // subset rule claimed the live session was the ancestor of the sessions it had
  // itself been branched from. `grandchild` below shares more with `child`.
  const base = [rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'q1')];
  const rows = describeSessions(
    [
      { id: 'root', file: '/p/root.jsonl', createdAt: 1000, records: base },
      {
        id: 'child',
        file: '/p/child.jsonl',
        createdAt: 2000,
        records: [...base, rec('c1', 'prompt', '2026-08-08T10:05:00.000Z', 'q2')],
      },
      {
        id: 'grandchild',
        file: '/p/grandchild.jsonl',
        createdAt: 3000,
        records: [
          ...base,
          rec('c1', 'prompt', '2026-08-08T10:05:00.000Z', 'q2'),
          rec('g1', 'prompt', '2026-08-08T10:09:00.000Z', 'q3'),
        ],
      },
    ],
    { now: NOW },
  );
  assert.equal(rows.find((r) => r.id === 'grandchild').parent.id, 'child', 'the nearest ancestor, not the root');
  assert.equal(rows.find((r) => r.id === 'child').parent.id, 'root');
  assert.deepEqual(rows.find((r) => r.id === 'root').children, ['child']);
});

test('with no creation times it declines to guess a direction', () => {
  // birthtime is not available on every filesystem. Saying "these share history"
  // is honest; naming a parent from a subset test would not be.
  const rows = describeSessions(
    entries().map((e) => ({ ...e, createdAt: 0 })),
    { now: NOW },
  );
  assert.ok(rows.every((r) => r.parent === null), 'no direction claimed');
  const text = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'branched').text;
  assert.match(text, /shares history with 1/, 'but the relationship is still reported');
});

test('the picker draws the parentage instead of describing it', () => {
  const rows = renderSessionRows(describeSessions(entries(), { now: NOW }), { width: 120 });
  const ids = rows.map((r) => r.id);

  // Depth-first: a parent is always directly above its children.
  assert.ok(ids.indexOf('original') < ids.indexOf('branched'), 'parent precedes child');
  const original = rows.find((r) => r.id === 'original');
  const branched = rows.find((r) => r.id === 'branched');
  const unrelated = rows.find((r) => r.id === 'unrelated');

  assert.match(branched.text, /└─branched/, 'the elbow attaches to the id it points at');
  assert.doesNotMatch(original.text, /[└├]/, 'a root carries no connector');
  assert.doesNotMatch(unrelated.text, /[└├]/, 'nor does a standalone conversation');

  // Drawing the tree makes the prose labels redundant; the width goes to the
  // preview instead.
  assert.doesNotMatch(branched.text, /branch of/);
  assert.doesNotMatch(original.text, /⑂/);

  assert.match(branched.text, /\b30m\b/, 'the age carries no " ago" — the header says AGE');
  assert.doesNotMatch(branched.text, / ago/);
  assert.match(branched.text, /a different second question/);
  assert.match(branched.text, /^▸ /, 'the most recently active arm is marked in the gutter');
  assert.match(original.text, /^ {2}/, 'and only that one');
  assert.doesNotMatch(branched.text, /← latest/, 'never after the preview, where truncation reaches it');
});

test('columns stay aligned once the tree indents rows', () => {
  // Everything after the id lines up, however deep the row sits: the pad goes
  // after the id, because padding the prefix strands the elbow mid-gutter. Each
  // field is right- or left-aligned in a width the header shares, so the check
  // is simply that every row agrees with the header about where a column ends.
  const described = describeSessions(entries(), { now: NOW });
  const all = renderSessionRows(described, { width: 120 });
  const header = all[0].text;
  const rows = all.filter((r) => r.id);

  const ageRight = header.indexOf('AGE') + 'AGE'.length;
  const countRight = header.indexOf('PROMPTS') + 'PROMPTS'.length;
  const nameLeft = header.indexOf('CONVERSATION');
  for (const r of rows) {
    const s = described.find((d) => d.id === r.id);
    assert.equal(r.text.indexOf(s.ageLabel) + s.ageLabel.length, ageRight, `age ragged: ${r.text}`);
    assert.equal(r.text.lastIndexOf(String(s.prompts), countRight) + 1, countRight, `count ragged: ${r.text}`);
    assert.equal(r.text.slice(0, nameLeft).trimEnd().length < nameLeft, true, `name column overrun: ${r.text}`);
  }
});

test('the preview starts at the same column on every row', () => {
  // §1.6. The preview used to start wherever the name happened to end, so the
  // previews formed a ragged second column and the eye had nothing to return
  // to — invisible at 100 columns, the dominant defect at 200.
  const described = describeSessions(entries(), { now: NOW });
  for (const width of [100, 200]) {
    const rows = renderSessionRows(described, { width }).filter((r) => r.id);
    const starts = rows.map((r) => {
      const s = described.find((d) => d.id === r.id);
      return r.text.indexOf(s.divergePrompt.slice(0, 12));
    });
    assert.equal(new Set(starts).size, 1, `preview column ragged at ${width}: ${JSON.stringify(rows)}`);
  }
});

test('the preview is capped, so a wide terminal keeps a right margin', () => {
  // §1.7. Unclamped, a 200-column terminal ran the preview past 120 characters,
  // which is not a scan target — it is a wall.
  const long = 'x'.repeat(300);
  const rows = describeSessions(
    [
      {
        id: 'wide',
        file: '/p/wide.jsonl',
        createdAt: 1000,
        records: [rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', long)],
      },
    ],
    { now: NOW },
  );
  const text = renderSessionRows(rows, { width: 240 }).find((r) => r.id === 'wide').text;
  const preview = text.slice(text.indexOf('x'));
  assert.ok(preview.length <= 72, `preview ${preview.length} > 72`);
  assert.ok(text.length < 240 - 100, 'and the row leaves the right of the screen alone');
});

test('the header names the columns and is not selectable', () => {
  // Dropping the literal " prompts" from every row is what buys the preview its
  // width back; the header is what keeps the bare number readable.
  const rows = renderSessionRows(describeSessions(entries(), { now: NOW }), { width: 120 });
  assert.equal(rows[0].id, null, 'the header is not a session');
  assert.match(rows[0].text, /\bID\b.*\bAGE\b.*\bPROMPTS\b.*\bCONVERSATION\b/);

  const branched = rows.find((r) => r.id === 'branched');
  // The count right-aligns under its header rather than carrying the word.
  assert.equal(
    branched.text.indexOf('2'),
    rows[0].text.indexOf('PROMPTS') + 'PROMPTS'.length - 1,
    'the count sits at the right edge of its column',
  );
  assert.doesNotMatch(branched.text, /\bprompts\b/, 'the word is redundant once the column is named');
});

test('top-level conversations are separated, a parent and its branches are not', () => {
  const rows = renderSessionRows(describeSessions(entries(), { now: NOW }), { width: 120 });
  const blank = rows.map((r, i) => (r.text === '' ? i : -1)).filter((i) => i >= 0);
  assert.equal(blank.length, 1, 'one gap, between the two conversations');
  const at = blank[0];
  assert.equal(rows[at - 1].id, 'branched', 'the gap comes after a family, never inside one');
  assert.equal(rows[at + 1].id, 'unrelated');
  assert.equal(rows[at].id, null, 'and a gap is not selectable');

  const piped = renderSessionRows(describeSessions(entries(), { now: NOW }), { width: 120, group: false });
  assert.ok(!piped.some((r) => r.text === ''), 'grouping is optional for callers that pipe this');
});

test('the badge carries its own colour, and a borrowed name is not dimmed', () => {
  // Both halves of one complaint: dim + truncation made the name hard to read,
  // and the badge — the only part that tells two arms apart — was dimmed with it.
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing, at length, with detail'),
          sidecar({ type: 'ai-title', aiTitle: 'Fix the classifier bug' }),
        ],
      },
      {
        id: 'child',
        file: '/p/child.jsonl',
        createdAt: 2000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing, at length, with detail'),
          rec('c1', 'prompt', '2026-08-08T10:30:00.000Z', 'a different follow-up'),
          sidecar({ type: 'custom-title', customTitle: 'do the thing, at length, with detail (Branch 2)' }),
        ],
      },
    ],
    { now: NOW },
  );
  const text = renderSessionRows(rows, { width: 120, color: true }).find((r) => r.id === 'child').text;
  assert.match(text, /↳ /, 'provenance is a glyph, not a loss of contrast');
  assert.match(text, /\x1b\[2m↳ \x1b\[0mFix the classifier/, 'the name itself is at full brightness');
  assert.match(text, /\x1b\[33m \(Branch 2\)\x1b\[0m/, 'yellow: this is the arm that differs');

  const plain = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'child').text;
  assert.doesNotMatch(plain, /\x1b/, 'and colour: false stays free of escape codes');
});

test('a fork badge is magenta — transplanted history, not another arm', () => {
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation' }),
        ],
      },
      {
        id: 'forked',
        file: '/p/forked.jsonl',
        createdAt: 2000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          rec('f1', 'prompt', '2026-08-08T10:30:00.000Z', 'the forked follow-up'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation \u2442' }),
        ],
      },
    ],
    { now: NOW },
  );
  const text = renderSessionRows(rows, { width: 120, color: true }).find((r) => r.id === 'forked').text;
  assert.match(text, /\x1b\[35m \(Fork\)\x1b\[0m/);
});

test('no row is wider than the terminal it was rendered for', () => {
  // The budget used to be spent twice: the name took `width - 18` and the
  // trailing prompt took half the width again on top of it, so an 80-column
  // terminal wrapped. Every row now fits, at every width, including the one
  // carrying the degraded-mode note.
  const normal = describeSessions(entries(), { now: NOW });
  const noTimes = describeSessions(entries().map((e) => ({ ...e, createdAt: 0 })), { now: NOW });
  for (const width of [80, 100, 200]) {
    for (const rows of [normal, noTimes]) {
      for (const r of renderSessionRows(rows, { width })) {
        assert.ok(r.text.length <= width, `${r.text.length} > ${width}: ${JSON.stringify(r.text)}`);
      }
    }
  }
});

test('a narrow terminal truncates the preview, not the structure', () => {
  const rows = renderSessionRows(describeSessions(entries(), { now: NOW }), { width: 60 }).filter(
    (r) => r.id,
  );
  for (const r of rows) {
    assert.match(r.text, /\w{8}/, 'the id survives');
    assert.match(r.text, /\d+[mhd]|—/, 'so does the age');
  }
  assert.match(rows.find((r) => r.id === 'branched').text, /└─/, 'and so does the tree');
});

// ── naming ──────────────────────────────────────────────────────────────────
const sidecar = (fields) => ({ uuid: null, kind: 'sidecar', raw: { ...fields } });

test('a conversation is called what Claude Code already calls it', () => {
  const rows = describeSessions(
    [
      {
        id: 's1',
        file: '/p/s1.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Fix the classifier bug' }),
        ],
      },
    ],
    { now: NOW },
  );
  assert.equal(rows[0].name, 'Fix the classifier bug');
  assert.equal(rows[0].nameSource, 'title');
});

test("/branch's auto title is demoted to a badge, not used as a name", () => {
  // `/branch` writes `custom-title` as "<opening prompt> (Branch 2)". Taken
  // literally, every arm of a conversation reads identically and the only
  // distinguishing part is the bit a truncator eats first.
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing, at length, with detail'),
          sidecar({ type: 'ai-title', aiTitle: 'Fix the classifier bug' }),
        ],
      },
      {
        id: 'child',
        file: '/p/child.jsonl',
        createdAt: 2000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing, at length, with detail'),
          rec('c1', 'prompt', '2026-08-08T10:30:00.000Z', 'a different follow-up'),
          sidecar({ type: 'custom-title', customTitle: 'do the thing, at length, with detail (Branch 2)' }),
        ],
      },
    ],
    { now: NOW },
  );
  const child = rows.find((r) => r.id === 'child');
  assert.equal(child.badge, 'Branch 2', 'the branch marker is kept');
  assert.equal(child.name, 'Fix the classifier bug', 'but the name comes from the ancestor');
  assert.equal(child.nameSource, 'inherited', 'and is marked as borrowed');

  const text = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'child').text;
  assert.match(text, /\(Branch 2\)/, 'the badge survives truncation — it is the distinguishing part');
});

test('a genuine custom title is used as-is', () => {
  const rows = describeSessions(
    [
      {
        id: 's1',
        file: '/p/s1.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'some opening prompt'),
          sidecar({ type: 'ai-title', aiTitle: 'An inferred title' }),
          sidecar({ type: 'custom-title', customTitle: 'What I actually called it' }),
        ],
      },
    ],
    { now: NOW },
  );
  assert.equal(rows[0].name, 'What I actually called it', 'chosen beats inferred');
});

test('an alias outranks every title, and is not dimmed as borrowed', () => {
  const rows = describeSessions(
    [
      {
        id: 's1',
        file: '/p/s1.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'opening'),
          sidecar({ type: 'ai-title', aiTitle: 'An inferred title' }),
        ],
      },
    ],
    { now: NOW, aliases: new Map([['s1', 'my name for it']]) },
  );
  assert.equal(rows[0].name, 'my name for it');
  assert.equal(rows[0].nameSource, 'alias');
});

test('an unnamed conversation still reads as its last prompt', () => {
  const rows = describeSessions(entries(), { now: NOW });
  assert.equal(rows[0].name, '', 'nothing invented');
  const text = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'branched').text;
  assert.match(text, /a different second question/);
});

test('an empty project renders a row, not a crash', () => {
  const rows = renderSessionRows([], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, null, 'and it is not selectable');
  assert.match(rows[0].text, /no transcripts/);
});


// ── /fork ───────────────────────────────────────────────────────────────────

test('a /fork is badged and named like a branch, from a different marker', () => {
  // Measured on a real `/fork`: no `custom-title` at all, just the PARENT's
  // `ai-title` with U+2442 appended. Left in the name it reads as a stray glyph.
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation' }),
        ],
      },
      {
        id: 'forked',
        file: '/p/forked.jsonl',
        createdAt: 2000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          rec('f1', 'prompt', '2026-08-08T10:30:00.000Z', 'the forked follow-up'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation \u2442' }),
        ],
      },
    ],
    { now: NOW },
  );
  const forked = rows.find((r) => r.id === 'forked');
  assert.equal(forked.badge, 'Fork');
  assert.equal(forked.name, 'Test simple reply conversation', 'the glyph is not part of the name');
  const text = renderSessionRows(rows, { width: 120 }).find((r) => r.id === 'forked').text;
  assert.match(text, /\(Fork\)/);
  assert.doesNotMatch(text, /\u2442/, 'the raw marker never reaches the screen');
});

test('an unused /fork still nests under the session it came from', () => {
  // A real `/fork` writes its two title sidecars and NOTHING else until the
  // first prompt lands, so it has no uuids and the shared-prefix rule cannot
  // see it. Its title is derived from the parent's verbatim, which is the only
  // evidence there is — and enough, since it must match exactly.
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation' }),
        ],
      },
      {
        id: 'empty-fork',
        file: '/p/fork.jsonl',
        createdAt: 2000,
        records: [sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation \u2442' })],
      },
    ],
    { now: NOW },
  );
  const fork = rows.find((r) => r.id === 'empty-fork');
  assert.equal(fork.parent?.id, 'parent');
  assert.equal(fork.parent?.via, 'title', 'linked by the only evidence available');
  assert.equal(fork.prompts, 0);
  assert.ok(rows.find((r) => r.id === 'parent').children.includes('empty-fork'));
});

test('a title match is not enough on its own to claim a parent', () => {
  // The fallback is scoped to sessions with nothing else to go on. A session
  // that HAS records must earn its parent through the shared prefix, or the
  // fallback becomes a way to invent parentage from a coincidence of naming.
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Same name' }),
        ],
      },
      {
        id: 'lookalike',
        file: '/p/other.jsonl',
        createdAt: 2000,
        records: [
          rec('z9', 'prompt', '2026-08-08T10:30:00.000Z', 'unrelated work'),
          sidecar({ type: 'ai-title', aiTitle: 'Same name \u2442' }),
        ],
      },
    ],
    { now: NOW },
  );
  assert.equal(rows.find((r) => r.id === 'lookalike').parent, null, 'shares no uuids, so no claim');
});


// ── one conversation is several files ───────────────────────────────────────

test('a family is the whole component, not just this session and its children', () => {
  // Opening one file draws a straight line through what is really a tree: a
  // `/branch` is a copy in another file, a `/fork` is a sibling in a third.
  // From a branch you want the trunk you left AND the arms you left it beside,
  // so the walk climbs to the root before it descends.
  const rows = describeSessions(entries(), { now: NOW });
  const branch = rows.find((r) => r.id === 'branched');

  const fromBranch = familyFiles(rows, branch.file);
  assert.deepEqual(fromBranch, ['/p/original.jsonl', '/p/branched.jsonl'], 'oldest first, so HEAD lands last');
  assert.deepEqual(familyFiles(rows, '/p/original.jsonl'), fromBranch, 'either end names the same family');

  // A conversation with no relatives is a family of one, which is what tells
  // the caller there is nothing to widen to.
  assert.deepEqual(familyFiles(rows, '/p/unrelated.jsonl'), ['/p/unrelated.jsonl']);
  assert.equal(familyFiles(rows, '/p/not-here.jsonl'), null, 'an unknown file is not a family of one');
});

test('a family includes an unused fork, which shares no uuids with anyone', () => {
  const rows = describeSessions(
    [
      {
        id: 'parent',
        file: '/p/parent.jsonl',
        createdAt: 1000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation' }),
        ],
      },
      {
        id: 'branch',
        file: '/p/branch.jsonl',
        createdAt: 2000,
        records: [
          rec('u1', 'prompt', '2026-08-08T10:00:00.000Z', 'do the thing'),
          rec('b1', 'prompt', '2026-08-08T10:30:00.000Z', 'the branch follow-up'),
        ],
      },
      {
        id: 'fork',
        file: '/p/fork.jsonl',
        createdAt: 3000,
        records: [sidecar({ type: 'ai-title', aiTitle: 'Test simple reply conversation \u2442' })],
      },
    ],
    { now: NOW },
  );
  // The fork is nested by its title alone — it has no uuids to share — and the
  // family has to carry it or the tree view loses the limb entirely.
  assert.deepEqual(familyFiles(rows, '/p/branch.jsonl'), [
    '/p/parent.jsonl',
    '/p/branch.jsonl',
    '/p/fork.jsonl',
  ]);
});
