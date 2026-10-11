export type Scope = 'session' | 'family'
export type View = 'tree' | 'sessions'

/** One row of `cctree sessions --json`: the picker's forest. */
export type SessionRow = {
  text: string
  id: string | null
  /** The session it was branched from, as the picker drew it. */
  parent?: string | null
  /** How many sessions hang under it, at any depth: what folding it hides. */
  descendants?: number
  /** The user's own name for it, from ~/.cctree/sessions.json. */
  alias?: string | null
}

/**
 * One row of `cctree show --json`. Connector rows carry `text` alone; a node
 * row carries what acting on it needs.
 */
export type Row = {
  text: string
  uuid?: string
  /** Where a collapsed run ends: the conversation stood here after this row. */
  end: string
  kind: string
  promptNo: number | null
  preview: string
  isHead: boolean
  inferred: boolean
  /** Transcripts holding the node, by session id, oldest first. */
  sessions: string[]
}

declare module 'claude-code' {
  interface PluginState {
    cctree: {
      tick: number
      view: View
      scope: Scope
      focus: string | null
      selected: string | null
      pickedSession: string | null
      offset: number | null
      folded: string[]
      renaming: string | null
    }
  }
}
