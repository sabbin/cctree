// The Claude Code pane (hooks/panel.tsx). Run with `claude plugin test .` — not
// by `npm test`, since it needs the engine's test kit rather than node:test.
//
// Nothing here spawns the real CLI: the kit's `on` sits beneath the plugin, so
// it answers `$.process.run` with what `cctree show --json` and `cctree branch
// --json` print. The CLI side of both is covered by test/branch.test.js.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { reveal, windowStart } from '../hooks/panel'

const ESC = '\x1b'
const node = (o: Record<string, unknown>) => ({
  kind: 'prompt', promptNo: null, preview: '', isHead: false, inferred: false, sessions: ['abc'], ...o,
})
const SHOWN = JSON.stringify({
  summary: '4 nodes · 2 prompts · 1 lane · 1 tip',
  rows: [
    node({ text: ` #1  ● ${ESC}[38;2;126;196;214m"hello"${ESC}[0m`, uuid: 'p1', end: 'p1', promptNo: 1 }),
    node({ text: '     ○ assistant · 3 msgs', uuid: 'a1', end: 'a1-tail', kind: 'assistant' }),
    { text: '     │' },
    node({ text: ` #2  ● ${ESC}[38;2;126;196;214m"again"${ESC}[0m`, uuid: 'p2', end: 'p2', promptNo: 2 }),
    node({ text: `     ◆ assistant · 2 msgs   ${ESC}[38;2;126;196;140m← HEAD${ESC}[0m`, uuid: 'a2', end: 'a2', kind: 'assistant', isHead: true }),
  ],
})

const PICKER = JSON.stringify({
  rows: [
    { text: '            ID          AGE  PROMPTS  CONVERSATION', id: null },
    { text: '  95f6fa50     1m        3  test a', id: 'orig', parent: null, descendants: 3, alias: null },
    { text: '  ├─abc        3m        5  test i', id: 'abc', parent: 'orig', descendants: 1, alias: null },
    { text: '  │ └─deep     2m        6  test j', id: 'deep', parent: 'abc', descendants: 0, alias: null },
    { text: '  └─45d790c9   1m        3  test az', id: 'other', parent: 'orig', descendants: 0, alias: 'the az one' },
  ],
})

const PANE = {
  plugin: 'cctree',
  component: 'Pane',
  requestId: 'cctree',
  props: {
    title: 'ccTree',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ran = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** The engine beneath the plugin: a session `abc`, a CLI, and a log of both. */
function engine(on: On) {
  const cli: string[][] = []
  const commands: string[] = []
  on('session.id', async () => ({ value: 'abc' }))
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    cli.push(argv)
    if (argv.includes('branch')) {
      const reask = argv.includes('--before') ? 'again' : null
      return ran(JSON.stringify({ id: 'new-session', path: '/x/new-session.jsonl', kept: 9, of: 12, reask }))
    }
    if (argv.includes('sessions')) return ran(PICKER)
    if (argv.includes('name')) return ran('')
    return ran(SHOWN)
  })
  on('command.run', async (_$, e) => {
    commands.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  return { cli, commands }
}

test('the pane draws what cctree show prints, coloured, without its path header', async ($, on) => {
  const { cli } = engine(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The CLI is asked for this session's FAMILY, at the pane's own width: a
    // /branch copy on its own is a straight line through the split it made.
    expect(cli.at(-1)).toEqual(expect.arrayContaining(['show', '--json', 'abc', '--family', '--width', '60']))

    expect((await ui.find({ key: 'head' }))?.text).toContain('← HEAD')
    expect(await ui.find({ type: 'Text', text: /4 nodes/ })).toBeDefined()

    // The escape became a colour, not text.
    const prompt = await ui.find({ type: 'Text', text: /^"hello"$/ })
    expect(prompt?.props.color).toBe('#7ec4d6')
    expect(await ui.find({ type: 'Text', text: /\x1b/ })).toBeUndefined()

    // `f` narrows to the one transcript and widens back. Never to the whole
    // project: --all merges conversations that have nothing to do with this one.
    await ui.press({ key: 'scope' })
    expect(cli.at(-1)).toContain('abc')
    expect(cli.at(-1)).not.toContain('--family')
    await ui.press({ key: 'scope' })
    expect(cli.at(-1)).toContain('--family')
    expect(cli.flat()).not.toContain('--all')

    await ui.unmount()
  }
})

test('the header shows what is in force, and the keys name what they switch TO', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: '▸ tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ family' })).toBeDefined()
  expect((await ui.find({ key: 'scope' }))?.text).toBe('transcript')
  expect((await ui.find({ key: 'view' }))?.text).toBe('sessions')

  await ui.press({ key: 'scope' })
  expect(await ui.find({ type: 'Text', text: '▸ transcript' })).toBeDefined()
  expect((await ui.find({ key: 'scope' }))?.text).toBe('family')

  // A fragment inside a row lays out as a column: every key on its own line.
  expect(JSON.stringify(await ui.drawn())).not.toContain('Fragment')
  await ui.unmount()
})

test('a node row is a button: pressing it selects, pressing again lets go', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'continue' })).toBeUndefined()
  await ui.press({ key: 'p2' })
  expect(await ui.find({ key: 'continue' })).toBeDefined()
  expect(await ui.find({ key: 'reask' })).toBeDefined()

  await ui.press({ key: 'p2' })
  expect(await ui.find({ key: 'continue' })).toBeUndefined()
  await ui.unmount()
})

test('j and k walk the nodes, skipping connector rows', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'down' }) // nothing picked yet: the first node
  await ui.press({ key: 'down' })
  await ui.press({ key: 'down' }) // past the `│` row to #2
  // Only a prompt can be asked again, so its button says which row is picked.
  expect(await ui.find({ key: 'reask' })).toBeDefined()
  await ui.press({ key: 'up' })
  expect(await ui.find({ key: 'reask' })).toBeUndefined()
  expect(await ui.find({ key: 'continue' })).toBeDefined()
  await ui.unmount()
})

test('continue from here branches to the END of a collapsed run, then resumes it', async ($, on) => {
  const { cli, commands } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'a1' })
  await ui.press({ key: 'continue' })

  expect(cli.find(a => a.includes('branch'))).toEqual(
    expect.arrayContaining(['branch', 'abc', '--to', 'a1-tail', '--json']),
  )
  expect(commands).toEqual(['/resume new-session'])
  await ui.unmount()
})

test('HEAD offers no jump: it is where you already are', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'a2' })
  expect(await ui.find({ key: 'continue' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'you are here' })).toBeDefined()
  await ui.unmount()
})

test('ask this again branches before the prompt and hands it back to the composer', async ($, on) => {
  const { cli, commands } = engine(on)
  mock.store(on)
  on('classic.SessionStart', async () => ({}))
  const filled: string[] = []
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, box: { text: e.text } } as never
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'p2' })
  await ui.press({ key: 'reask' })
  expect(cli.find(a => a.includes('branch'))).toEqual(expect.arrayContaining(['--before', 'p2']))
  expect(commands).toEqual(['/resume new-session'])

  // The prompt waits for the session it belongs to, and only that one.
  await $.classic.SessionStart({ source: 'resume', session_id: 'some-other-session' })
  expect(filled).toEqual([])
  await $.classic.SessionStart({ source: 'resume', session_id: 'new-session' })
  expect(filled).toEqual(['again'])
  await ui.unmount()
})

test('s opens the picker; a conversation picked there opens as a tree, or is resumed', async ($, on) => {
  const { cli, commands } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'view' })
  expect(cli.at(-1)).toEqual(expect.arrayContaining(['sessions', '--json']))
  expect(await ui.find({ type: 'Text', text: /test az/ })).toBeDefined()

  // The session you are in offers no resume: you are already there.
  await ui.press({ key: 'abc' })
  expect(await ui.find({ key: 'resume' })).toBeUndefined()

  // Another one opens as ITS tree, flagged as not where you are.
  await ui.press({ key: 'other' })
  await ui.press({ key: 'open' })
  expect(cli.at(-1)).toEqual(expect.arrayContaining(['show', 'other', '--family']))
  expect(await ui.find({ type: 'Text', text: /viewing other/ })).toBeDefined()

  await ui.press({ key: 'resume' })
  expect(commands).toEqual(['/resume other'])
  // A resume follows you: the tree is the session you landed in again.
  expect(cli.at(-1)).toEqual(expect.arrayContaining(['show', 'abc']))
  await ui.unmount()
})

test('a CLI failure is shown in the pane rather than drawing an empty tree', async ($, on) => {
  on('session.id', async () => ({ value: 'abc' }))
  on('process.run', async () => ran('', 1, 'no transcript found for abc'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no transcript found/ })).toBeDefined()
  await ui.unmount()
})

test('the window follows the end until moved, and clamps', () => {
  expect(windowStart(100, 20, null)).toBe(80) // following: the end is in view
  expect(windowStart(10, 20, null)).toBe(0) // fits: nothing to move
  expect(windowStart(100, 20, 95)).toBe(80) // past the end lands at the end
  expect(windowStart(100, 20, -3)).toBe(0)
  // A pick above the window pulls it up; one at the bottom edge pushes it down
  // far enough to show the action line under it too.
  expect(reveal(5, 1, 40, 20)).toBe(5)
  expect(reveal(59, 1, 40, 20)).toBe(41)
  expect(reveal(45, 1, 40, 20)).toBe(40)
})

test('a tree taller than the pane keeps its footer: the body is a window that follows HEAD', async ($, on) => {
  const long = JSON.stringify({
    summary: '60 nodes',
    rows: Array.from({ length: 60 }, (_, i) =>
      node({
        text: i === 59 ? `     ◆ last   ${ESC}[38;2;126;196;140m← HEAD${ESC}[0m` : `     ○ node ${i}`,
        uuid: `n${i}`,
        end: `n${i}`,
        kind: 'assistant',
        isHead: i === 59,
      }),
    ),
  })
  on('session.id', async () => ({ value: 'abc' }))
  on('process.run', async () => ran(long))
  // 14 rows: tabs + rule above, rule + footer below, 10 for the tree.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } } })

  expect(await ui.find({ key: 'head' })).toBeDefined()
  expect(await ui.find({ key: 'n0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /51–60 of 60/ })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()

  // j with nothing picked takes the first node, and the window goes to it.
  await ui.press({ key: 'down' })
  expect(await ui.find({ key: 'n0' })).toBeDefined()
  expect(await ui.find({ key: 'head' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1–10 of 61/ })).toBeDefined() // + its action line
  await ui.unmount()
})

test('folding a conversation hides every branch under it, at any depth, and remembers', async ($, on) => {
  engine(on)
  const stored = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', async (_$, e) => (stored.set(e.key, e.value), { value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view' })

  expect(await ui.find({ key: 'deep' })).toBeDefined()
  expect((await ui.find({ key: 'fold-orig' }))?.text).toBe('−')
  expect(await ui.find({ key: 'fold-other' })).toBeUndefined() // a leaf has nothing to fold

  await ui.press({ key: 'fold-orig' })
  expect(await ui.find({ key: 'abc' })).toBeUndefined()
  expect(await ui.find({ key: 'deep' })).toBeUndefined() // a grandchild goes too
  expect((await ui.find({ key: 'fold-orig' }))?.text).toBe('+3')
  expect(stored.get('folded')).toEqual(['orig'])

  await ui.press({ key: 'fold-orig' })
  expect(await ui.find({ key: 'deep' })).toBeDefined()
  expect(stored.get('folded')).toEqual([])
  await ui.unmount()
})

test('rename names a conversation through cctree name; an empty name clears it', async ($, on) => {
  const { cli } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view' })

  await ui.press({ key: 'other' })
  await ui.press({ key: 'rename' })
  // The field opens on the name it already has.
  expect((await ui.find({ key: 'name' }))?.props.value).toBe('the az one')

  await ui.input({ key: 'name', text: '  az experiment  ' })
  expect(cli.find(a => a.includes('name'))).toEqual(expect.arrayContaining(['name', 'other', 'az experiment']))
  expect(await ui.find({ key: 'name' })).toBeUndefined() // saved: back to the actions

  await ui.press({ key: 'rename' })
  await ui.input({ key: 'name', text: '' })
  expect(cli.at(-2)).toEqual(expect.arrayContaining(['name', 'other', '--clear']))
  await ui.unmount()
})
