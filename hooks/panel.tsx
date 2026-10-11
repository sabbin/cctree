// The tree as a pane inside Claude Code itself, beside the conversation it draws.
//
// The pane does not re-implement the graph. It runs `cctree` — the same binary
// the skill and the terminal use — and draws what it prints, so the printed
// view, the TUI and this pane cannot drift. Two things make that work across
// the boundary: FORCE_COLOR=3 asks for truecolor even though stdout is a pipe,
// and the escapes are turned back into Text spans here, since an element tree
// has no notion of ANSI. `--width` hands the CLI the pane's own width, because a
// pipe has none to ask for.
//
// A hooks module runs with no Node, so importing src/ directly is not an option:
// parse.js and sessions.js read the filesystem through node:fs. Spawning the CLI
// also keeps "nothing modifies an existing transcript" in one place: the only
// write this pane can cause is `cctree branch` creating a NEW file.
//
// It is organised as the TUI is (CLAUDE.md, "Two views, one row model"): a
// picker of conversations drawn as a forest, and a tree. Two deliberate
// differences, both because this sits beside a live conversation rather than
// standing alone. It opens on the TREE of the conversation you are in, not the
// picker. And that tree is the conversation's FAMILY by default, not its one
// transcript: a `/branch` copy holds its whole prefix, so on its own it draws a
// straight line through the very split you made.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Row, Scope, SessionRow, View } from '../types'

const PANE = 'cctree'
const TITLE = 'ccTree'

// Bumped whenever the transcript may have grown. The render hook reads it, so a
// bump redraws the pane; the count itself means nothing.
const tick = atom({ plugin: 'cctree', key: 'tick' } as const, 0)
const view = atom({ plugin: 'cctree', key: 'view' } as const, 'tree' as View)
// `family` draws the conversation with its /branch relatives (the TUI's `f`);
// `session` the one transcript. Never the whole project: unrelated
// conversations merged into one tree is what the picker exists to avoid.
const scope = atom({ plugin: 'cctree', key: 'scope' } as const, 'family' as Scope)
// Which session the tree is about; null follows the one this pane sits beside,
// so a `/resume` moves the tree with you.
const focus = atom({ plugin: 'cctree', key: 'focus' } as const, null as string | null)
// What a click or j/k picked, per view: a node uuid in the tree, a session id in
// the picker. Ids rather than row indexes, so they hold while rows move.
const selected = atom({ plugin: 'cctree', key: 'selected' } as const, null as string | null)
const pickedSession = atom({ plugin: 'cctree', key: 'pickedSession' } as const, null as string | null)
// Picker rows whose branches are folded away, by session id. Mirrored to
// `$.store` under FOLDED so a fold outlives the session: conversations pile up,
// and the ones you folded are the ones you are done looking at.
const folded = atom({ plugin: 'cctree', key: 'folded' } as const, [] as string[])
const FOLDED = 'folded'
// The session whose name is being edited in the picker, if any.
const renaming = atom({ plugin: 'cctree', key: 'renaming' } as const, null as string | null)
// The first line of the window over the body; null follows the end, which is
// where HEAD is drawn (the trunk comes last). See `windowStart`.
const offset = atom({ plugin: 'cctree', key: 'offset' } as const, null as number | null)

// What the last frame laid out, for the wheel: `ui.scroll` needs the window's
// size and the body's length to clamp a move, and only a draw knows them. A
// cache, not state — nothing is drawn from it, and a reload re-learns it.
let layout = { total: 0, height: 0 }

// A re-asked prompt waits here across the `/resume`: the module's own variables
// may not survive the switch, and `$.state` is the session's — which is the
// thing being switched. Keyed by the session it is meant for.
const PENDING = 'pendingFill'

type Span = { text: string; color?: string; bold?: boolean; dim?: boolean }

const BASIC: Record<string, string> = {
  '31': 'red', '32': 'green', '33': 'yellow', '34': 'blue',
  '35': 'magenta', '36': 'cyan', '37': 'white', '90': 'gray',
}

const hex = (n = '0') => Number(n).toString(16).padStart(2, '0')

/** One line of SGR-coloured text as spans. Only what palette.js emits is understood. */
export function spans(line: string): Span[] {
  const out: Span[] = []
  let style: Omit<Span, 'text'> = {}
  // split() with a capture group alternates text, codes, text, codes, ...
  line.split(/\x1b\[([0-9;]*)m/).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) out.push({ text: part, ...style })
      return
    }
    const codes = part.split(';')
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j] ?? ''
      const color = BASIC[c]
      if (c === '' || c === '0') style = {}
      else if (c === '1') style = { ...style, bold: true }
      else if (c === '2') style = { ...style, dim: true }
      else if (c === '38' && codes[j + 1] === '2') {
        style = { ...style, color: `#${hex(codes[j + 2])}${hex(codes[j + 3])}${hex(codes[j + 4])}` }
        j += 4
      } else if (c === '38' && codes[j + 1] === '5') {
        style = { ...style, color: `ansi256(${codes[j + 2]})` }
        j += 2
      } else if (c === '48') j += codes[j + 1] === '2' ? 4 : 2 // backgrounds: the selection fill, unused here
      else if (color) style = { ...style, color }
    }
  })
  return out
}

/**
 * Where the window over `total` lines starts. The pane owns its scrolling so
 * the header and footer can stay put: the frame is drawn exactly as tall as
 * the pane, the engine finds nothing to scroll, and this decides what shows.
 * A null offset follows the end, so new turns arrive in view.
 */
export function windowStart(total: number, height: number, at: number | null): number {
  const last = Math.max(0, total - height)
  return at == null ? last : Math.min(last, Math.max(0, at))
}

/** The start that shows line `at` and the `extra` lines under it, moving as little as it can. */
export function reveal(at: number, extra: number, start: number, height: number): number {
  if (at < start) return at
  if (at + extra >= start + height) return at + extra - height + 1
  return start
}

const bump = ($: EngineInterface) => update($, tick, n => n + 1)
const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

// palette.js, so the chrome speaks the tree's colour vocabulary.
const SELECT_BG = '#282623' // SEL_BG: one step off the terminal's own
const ACCENT = '#7ec4d6' //    `prompt`: what is in front of you
const FAINT = '#4e4a44' //     `faint`: lane art, rules

const cli = ($: EngineInterface, args: string[], env: Record<string, string> = {}) =>
  $.process.run(['node', `${$.plugin.root}/bin/cctree.mjs`, ...args], { env, timeoutMs: 8000 })

/** Runs a `--json` command; a failure comes back as text to show, never thrown. */
async function cliJson<T>($: EngineInterface, args: string[]): Promise<T | string> {
  try {
    const run = await cli($, args, { FORCE_COLOR: '3' })
    if (run.exitCode !== 0) return (run.stderr || run.stdout).trim() || `exit ${run.exitCode}`
    return JSON.parse(run.stdout) as T
  } catch (err) {
    return String((err as Error)?.message ?? err)
  }
}

/** Switch this session to another one, leaving the tree on wherever you land. */
async function resume($: EngineInterface, id: string) {
  await update($, focus, () => null)
  await update($, view, () => 'tree')
  await $.command.run({ command: 'resume', args: id })
}

/**
 * Branch so the conversation stands where `row` is, then switch to it.
 *
 * There is no rewind a plugin can call — `Esc Esc` is interactive-only — so a
 * jump is the next best thing that is real: `cctree branch` writes a NEW session
 * ending on that node (the original is never touched) and `/resume` moves this
 * one into it. `before` cuts on the node's parent instead and hands its prompt
 * back for the composer, which is what asking a prompt differently needs.
 */
async function jump($: EngineInterface, row: Row, how: 'to' | 'before') {
  const session = row.sessions[0]
  const target = how === 'to' ? row.end : row.uuid
  if (!session || !target) return $.ui.toast('ccTree: that node has no transcript to branch from')
  const run = await cli($, ['branch', session, `--${how}`, target, '--json'])
  if (run.exitCode !== 0) return $.ui.toast(`ccTree: ${(run.stderr || run.stdout).trim()}`)
  const made = JSON.parse(run.stdout) as { id: string; reask: string | null }

  if (made.reask) await $.store.set(PENDING, { id: made.id, text: made.reask })
  await update($, selected, () => null)
  $.ui.toast(`ccTree: branched into ${made.id.slice(0, 8)}, resuming`)
  await resume($, made.id)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'cctree',
      description: 'Show the ccTree conversation graph in a pane',
    })
    // Unasked, so the engine seats it only where it fits as a sidebar (144
    // columns and up) and holds it otherwise — never squeezed, as the TUI's
    // own pane is refused below 120 rather than shrunk.
    if (e.isInteractive) void open($)
    const kept = await $.store.get(FOLDED)
    if (Array.isArray(kept)) await update($, folded, () => kept.filter((x): x is string => typeof x === 'string'))
    return started
  })

  on('command.run', { command: 'cctree' }, async $ => {
    await open($)
    await bump($)
    return { text: 'ccTree pane opened.' }
  })

  // `session.start` does not fire for a `/resume` — the classic hook does, and
  // it is the one moment the new session exists: redraw for it, and put back a
  // prompt that a re-ask carried over.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    await bump($)
    const pending = (await $.store.get(PENDING)) as { id: string; text: string } | undefined
    if (pending && pending.id === e.session_id) {
      await $.store.delete(PENDING)
      await $.prompt.fill({ text: pending.text })
    }
    return done
  }).catch(($, e, next) => next(e))

  // The transcript grows at both ends of a turn. A prompt adds the node that
  // will become HEAD; the turn's end adds everything the assistant did.
  // Observing only: a failed redraw must never cost the person their prompt,
  // so the handler replays whatever `next` settled to.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    await bump($)
    return done
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // HEAD is drawn near the bottom (the trunk is drawn last): a finished turn
    // puts the window back on the end, wherever it had been moved to.
    await update($, offset, () => null)
    await bump($)
    return done
  })

  // The wheel. The engine has nothing to scroll — the frame fits the pane by
  // construction — so its ask is turned into a move of the pane's own window.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { total, height } = layout
    if (total > height) {
      await update($, offset, at => {
        const moved = windowStart(total, height, at) + e.by
        // Back at the end is following again, so new turns keep arriving.
        return moved >= total - height ? null : Math.max(0, moved)
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Naming needs a text field, and the mobile surface draws none yet: there
    // the rename action is simply not offered.
    const Input = 'Input' in els ? els.Input : null
    await read($, tick)
    const showing = await read($, view)
    const at = await read($, offset)
    const width = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    const room = e.props.scroll?.bodyRows ?? 0
    const isDocked = e.props.placement === 'dock'
    const current = await $.session.id()

    /** One printed row, its escapes as spans; `isPicked` paints the selection. */
    const line = (text: string, isPicked = false) => (
      <Text wrap="truncate" backgroundColor={isPicked ? SELECT_BG : undefined}>
        {spans(text).map(s => (
          <Text color={s.color} bold={s.bold || isPicked} dimColor={s.dim}>
            {s.text}
          </Text>
        ))}
      </Text>
    )
    const rule = (key: string) => (
      <Text key={key} color={FAINT} wrap="truncate">
        {'─'.repeat(width)}
      </Text>
    )

    /**
     * A choice of two drawn as tabs: the one in force is a label, the other is
     * the button that switches to it — so a key never reads as the state it is
     * about to leave, which is what `f: family` beside a family tree did.
     */
    const tabs = (key: string, hotkey: string, [one, two]: [string, string], isOne: boolean, onPress: () => unknown) => (
      <Box key={`tabs-${key}`} flexDirection="row" gap={1}>
        <Text bold color={ACCENT}>{`▸ ${isOne ? one : two}`}</Text>
        <Button key={key} hotkey={hotkey} plain dimColor onPress={onPress}>
          {isOne ? two : one}
        </Button>
      </Box>
    )
    const viewTabs = tabs('view', 's', ['tree', 'sessions'], showing === 'tree', () =>
      update($, view, v => (v === 'tree' ? 'sessions' : 'tree')),
    )

    /** A body line: what it draws, and the id a click or j/k selects it by. */
    type Item = { key: string; el: RenderChildren; id?: string }

    /**
     * Header, a window onto the body, footer — exactly as tall as the pane, so
     * the engine never scrolls it and both ends stay put. Every line is one row
     * (`wrap="truncate"` throughout), which is what lets lines be counted.
     *
     * `base` is the body without the picked row's action line; `actions` is
     * that line, drawn under `picked`. j/k and clicks reveal a pick in base
     * coordinates with one line reserved under it, so its actions show too.
     */
    const frame = (o: {
      top: RenderChildren[]
      base: Item[]
      picked: string | null
      actions: (id: string) => RenderChildren
      info: string
      select: (id: string | null) => Promise<unknown>
    }) => {
      const body: Item[] = []
      for (const item of o.base) {
        body.push(item)
        if (item.id && item.id === o.picked) body.push({ key: 'actions', el: o.actions(item.id) })
      }
      const chrome = o.top.length + 1 + 2 // the header, its rule, the footer's rule and line
      const height = room > chrome ? (isDocked ? room - chrome : Math.min(body.length, room - chrome)) : body.length
      const start = windowStart(body.length, height, at)
      layout = { total: body.length, height }

      const ids = o.base.flatMap(i => (i.id ? [i.id] : []))
      const indexOf = (id: string) => o.base.findIndex(i => i.id === id)
      const show = async (id: string | null) => {
        await o.select(id)
        if (!id) return
        const moved = reveal(indexOf(id), 1, start, height)
        if (moved !== start) await update($, offset, () => moved)
      }
      const step = (by: number) => () => {
        const from = o.picked ? ids.indexOf(o.picked) : by > 0 ? -1 : ids.length
        return show(ids[Math.min(ids.length - 1, Math.max(0, from + by))] ?? null)
      }
      const where = body.length > height ? ` · ${start + 1}–${Math.min(body.length, start + height)} of ${body.length}` : ''

      return {
        show,
        el: (
          <Box flexDirection="column">
            {o.top}
            {rule('rule-top')}
            <Box flexDirection="column" height={height}>
              {body.slice(start, start + height).map(i => (
                <Box key={i.key}>{i.el}</Box>
              ))}
            </Box>
            {rule('rule-bottom')}
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text dimColor wrap="truncate">{o.info + where}</Text>
              <Box flexDirection="row" gap={1} flexShrink={0}>
                <Button key="down" hotkey="j" plain dimColor onPress={step(1)}>
                  next
                </Button>
                <Button key="up" hotkey="k" plain dimColor onPress={step(-1)}>
                  prev
                </Button>
                <Button key="refresh" hotkey="r" plain dimColor onPress={() => bump($)}>
                  refresh
                </Button>
              </Box>
            </Box>
          </Box>
        ),
      }
    }

    // --- the picker: every conversation in this directory, as a forest -------
    if (showing === 'sessions') {
      const got = await cliJson<{ rows: SessionRow[] }>($, ['sessions', '--json', '--width', String(width)])
      const rows = typeof got === 'string' ? [] : got.rows
      const picked = await read($, pickedSession)
      const openTree = (id: string) => async () => {
        await update($, focus, () => (id === current ? null : id))
        await update($, offset, () => null)
        await update($, view, () => 'tree')
      }

      const shut = new Set(await read($, folded))
      const editing = await read($, renaming)
      const fold = (id: string) => async () => {
        const next = await update($, folded, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
        await $.store.set(FOLDED, next)
      }
      const rename = (id: string) => async (name: string) => {
        const alias = name.trim()
        const run = await cli($, alias ? ['name', id, alias] : ['name', id, '--clear'])
        if (run.exitCode !== 0) $.ui.toast(`ccTree: ${(run.stderr || run.stdout).trim()}`)
        await update($, renaming, () => null)
        await bump($)
      }

      // A row is hidden when any session above it is folded. Its own glyphs need
      // no redraw: a subtree vanishes whole, and every `├─`/`└─` left is still true.
      const parentOf = new Map(rows.flatMap(r => (r.id ? [[r.id, r.parent ?? null] as const] : [])))
      const isHidden = (id: string) => {
        for (let up = parentOf.get(id), hops = 0; up && hops < 64; up = parentOf.get(up), hops++) {
          if (shut.has(up)) return true
        }
        return false
      }

      // `show` is the frame's, and the rows' buttons need it: a late binding.
      let show: (id: string | null) => Promise<unknown> = async () => {}
      const base: Item[] = []
      rows.forEach((r, i) => {
        if (!r.id) return void base.push({ key: `gap-${i}`, el: line(r.text) })
        const id = r.id
        if (isHidden(id)) return
        const under = r.descendants ?? 0
        const isShut = shut.has(id)
        base.push({
          key: `s-${id}`,
          id,
          el: (
            <Box flexDirection="row">
              {/* The fold column: − open, +N folded with how many it hides. */}
              <Box width={4} flexShrink={0}>
                {under > 0 ? (
                  <Button key={`fold-${id}`} plain dimColor={!isShut} onPress={fold(id)}>
                    {isShut ? `+${under}` : '−'}
                  </Button>
                ) : (
                  <Text> </Text>
                )}
              </Box>
              <Button key={id} plain onPress={() => show(id === picked ? null : id)}>
                {line(r.text, id === picked)}
              </Button>
            </Box>
          ),
        })
      })
      if (typeof got === 'string') base.unshift({ key: 'error', el: <Text color="error" wrap="truncate">{got}</Text> })
      const byId = new Map(rows.flatMap(r => (r.id ? [[r.id, r] as const] : [])))

      const built = frame({
        top: [<Box key="tabs" flexDirection="row" gap={1}>{viewTabs}</Box>],
        base,
        picked,
        actions: id => {
          const r = byId.get(id)
          // Naming takes the action line over: one field, Enter saves, an empty
          // name clears the alias and the title Claude Code gave it shows again.
          if (editing === id && Input) {
            return (
              <Box flexDirection="row" gap={2} paddingLeft={4}>
                <Input
                  key="name"
                  label="name:"
                  value={r?.alias ?? ''}
                  placeholder="empty clears it"
                  submitLabel="save"
                  autoFocus
                  onSubmit={rename(id)}
                />
                <Button key="cancel" plain dimColor onPress={() => update($, renaming, () => null)}>
                  cancel
                </Button>
              </Box>
            )
          }
          return (
            <Box flexDirection="row" gap={2} paddingLeft={4}>
              <Button key="open" hotkey="t" plain onPress={openTree(id)}>
                show its tree
              </Button>
              {id === current ? (
                <Text dimColor>you are here</Text>
              ) : (
                <Button key="resume" hotkey="o" plain onPress={() => resume($, id)}>
                  resume it
                </Button>
              )}
              {Input && (
                <Button key="rename" hotkey="n" plain onPress={() => update($, renaming, () => id)}>
                  rename
                </Button>
              )}
              {(r?.descendants ?? 0) > 0 && (
                <Button key="fold" hotkey="z" plain dimColor onPress={fold(id)}>
                  {shut.has(id) ? 'unfold' : 'fold'}
                </Button>
              )}
            </Box>
          )
        },
        info: `${rows.filter(r => r.id).length} conversations in this directory`,
        select: async id => {
          await update($, renaming, () => null)
          await update($, pickedSession, () => id)
        },
      })
      show = built.show
      return built.el
    }

    // --- the tree: one conversation, its family by default --------------------
    const which = await read($, scope)
    const about = (await read($, focus)) ?? current
    const args = ['show', '--json', '--width', String(width), about, ...(which === 'family' ? ['--family'] : [])]
    const got = await cliJson<{ rows: Row[]; summary: string }>($, args)
    const rows = typeof got === 'string' ? [] : got.rows
    const summary = typeof got === 'string' ? '' : got.summary
    const picked = await read($, selected)
    const toggle = async () => {
      await update($, offset, () => null)
      await update($, scope, s => (s === 'family' ? 'session' : 'family'))
    }
    // Where you already are is not somewhere to jump to.
    const here = (r: Row) => r.isHead && r.sessions.includes(current)
    const byId = new Map(rows.flatMap(r => (r.uuid ? [[r.uuid, r] as const] : [])))

    let show: (id: string | null) => Promise<unknown> = async () => {}
    const base: Item[] = rows.map((r, i) => {
      const key = r.text.includes('← HEAD') ? 'head' : `row-${i}`
      if (!r.uuid || r.inferred) return { key, el: line(r.text) }
      const uuid = r.uuid
      return {
        key,
        id: uuid,
        el: (
          <Button key={uuid} plain onPress={() => show(uuid === picked ? null : uuid)}>
            {line(r.text, uuid === picked)}
          </Button>
        ),
      }
    })
    if (typeof got === 'string') base.unshift({ key: 'error', el: <Text color="error" wrap="truncate">{got}</Text> })

    const top: RenderChildren[] = [
      <Box key="tabs" flexDirection="row" gap={1}>
        {viewTabs}
        <Text color={FAINT}>│</Text>
        {tabs('scope', 'f', ['family', 'transcript'], which === 'family', toggle)}
      </Box>,
    ]
    if (about !== current) {
      top.push(
        <Box key="away" flexDirection="row" gap={2}>
          <Text color="warning" wrap="truncate">viewing {about.slice(0, 8)}, not this session</Text>
          <Button key="resume" hotkey="o" plain onPress={() => resume($, about)}>
            resume it
          </Button>
          <Button key="home" hotkey="h" plain dimColor onPress={() => update($, focus, () => null)}>
            back to mine
          </Button>
        </Box>,
      )
    }

    const built = frame({
      top,
      base,
      picked,
      actions: id => {
        const r = byId.get(id)
        if (!r) return null
        return (
          <Box flexDirection="row" gap={2} paddingLeft={6}>
            {here(r) ? (
              <Text dimColor>you are here</Text>
            ) : (
              <Button key="continue" hotkey="c" plain onPress={() => jump($, r, 'to')}>
                continue from here
              </Button>
            )}
            {r.kind === 'prompt' && (
              <Button key="reask" hotkey="e" plain onPress={() => jump($, r, 'before')}>
                ask this again
              </Button>
            )}
            <Text dimColor wrap="truncate">{r.sessions.map(s => s.slice(0, 8)).join(', ')}</Text>
          </Box>
        )
      },
      // Sidecars are records the tree correctly leaves out; in a pane that is
      // bookkeeping, not something to read.
      info: summary.replace(/ · \d+ sidecar\b/, ''),
      select: id => update($, selected, () => id),
    })
    show = built.show
    return built.el
  })
}
