// thinking-flow: the type contract of its session state ($.state).

/** The kind of work an action is. 'think' holds the session's own planning tools (the to-do list). */
export type Lane = 'think' | 'look' | 'change' | 'run' | 'delegate' | 'talk'

/** One tool call: its name, a short target, its kind, and how it ended. */
export type Action = {
  id: string
  name: string
  target: string
  lane: Lane
  outcome: 'running' | 'ok' | 'error' | 'denied'
}

/** One model request of the main loop, numbered from 1 within its turn. */
export type Step = {
  n: number
  /** The thinking text as the session showed it, cut short; '' when hidden. */
  thinking: string
  thinkingChars: number
  thinkingBlocks: number
  actions: Action[]
  /** Model requests made inside subagents this step started. */
  subSteps: number
  /** Characters of visible text the step wrote. */
  wroteChars: number
}

/** One box of the flow: a plain-word label, a short detail, the steps it covers. */
export type Stage = { label: string; detail: string; steps: number[] }

export type Flow = {
  /** Who worded it: the small model, or the built-in rules. */
  by: 'haiku' | 'rules'
  stages: Stage[]
  /** The answer in a short line. */
  answer: string
  /** Why the rules were used, when they were. */
  note?: string
}

export type Turn = {
  id: string
  prompt: string
  answer: string
  startedAt: number
  endedAt?: number
  reason?: string
  steps: Step[]
  flowState: 'open' | 'pending' | 'working' | 'done'
  flow?: Flow
}

/** Which turn the pane shows: null follows the latest. */
export type View = { turn: number | null; details?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'thinking-flow': { turns: Turn[]; view: View }
  }
}
