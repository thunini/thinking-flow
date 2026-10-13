// thinking-flow: pure logic, no engine calls. Classifies tool calls, builds the record a small
// model words into a flow, checks the model's reply, groups steps by rules when it cannot, names
// each stage's kind of work, and draws the flow (an SVG for the desktop, numbered lines elsewhere).
import type { Action, Flow, Lane, Stage, Step, Turn } from '../types'

// ---------- actions ----------

const LOOK = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ToolSearch', 'Skill',
  'ListMcpResources', 'ReadMcpResource', 'TaskOutput', 'BashOutput',
])
const CHANGE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// The session's own to-do list is planning: it changes nothing of the person's.
const PLAN = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const DELEGATE = new Set(['Agent', 'Task', 'Workflow', 'SendMessage'])
const TALK = new Set(['AskUserQuestion', 'SendUserFile', 'Artifact', 'ExitPlanMode', 'PushNotification'])
// Word lists that sort tool calls by the command text or tool name they start with. They are
// only matched against text; the mod never runs any of them.
const READONLY_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sed -n', 'awk',
  'git log', 'git diff', 'git status', 'git show', 'git blame', 'git grep', 'git ls-files', 'git rev-parse', 'git fetch',
  'pwd', 'echo', 'which', 'command -v', 'stat', 'file', 'du', 'tree', 'jq', 'shasum', 'date', 'curl -s',
]
const MCP_LOOK_VERBS = ['get', 'list', 'read', 'search', 'find', 'query', 'fetch', 'describe', 'view', 'lookup', 'status', 'download']
const MCP_CHANGE_VERBS = [
  'create', 'update', 'delete', 'send', 'post', 'set', 'write', 'edit',
  'upload', 'add', 'remove', 'apply', 'label', 'move', 'share', 'trash',
]

/** A regex alternation of a word list; a space inside an entry matches any run of spaces. */
function anyOf(words: readonly string[]): string {
  return words.map(w => w.split(' ').join('\\s+')).join('|')
}

// A shell call counts as looking when it starts with a read-only command, after an optional `cd <dir> &&`.
const READONLY_SHELL = new RegExp(`^\\s*(cd\\s+\\S+\\s*(&&|;)\\s*)?(${anyOf(READONLY_COMMANDS)})\\b`)
const MCP_LOOK = new RegExp(`^(${anyOf(MCP_LOOK_VERBS)})`, 'i')
const MCP_CHANGE = new RegExp(`^(${anyOf(MCP_CHANGE_VERBS)})`, 'i')
// The in-app browser and Claude in Chrome: reading and moving around a page is looking.
const BROWSER = /^mcp__(Claude_Browser|claude-in-chrome|remote-devices__Claude_Browser)__/
const BROWSER_CHANGE = /^(form_input|file_upload)$/i
const BROWSER_RUN = /^(javascript_tool|javascript_exec|preview_stop)$/i

function field(input: unknown, key: string): string {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  return ''
}

export function laneOf(name: string, input: unknown): Lane {
  if (PLAN.has(name)) return 'think'
  if (LOOK.has(name)) return 'look'
  if (CHANGE.has(name)) return 'change'
  if (DELEGATE.has(name)) return 'delegate'
  if (TALK.has(name)) return 'talk'
  if (name === 'Bash' || name === 'PowerShell') return READONLY_SHELL.test(field(input, 'command')) ? 'look' : 'run'
  if (BROWSER.test(name)) {
    const verb = name.split('__').pop() ?? ''
    return BROWSER_CHANGE.test(verb) ? 'change' : BROWSER_RUN.test(verb) ? 'run' : 'look'
  }
  if (name.startsWith('mcp__')) {
    const verb = name.split('__').pop() ?? ''
    if (MCP_LOOK.test(verb)) return 'look'
    if (MCP_CHANGE.test(verb)) return 'change'
  }
  return 'run'
}

export function short(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function tailPath(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/')
}

/** A short target for a tool call: the file, pattern, command, URL or task it names. */
export function targetOf(name: string, input: unknown): string {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = field(input, key)
    if (v) return short(tailPath(v))
  }
  for (const key of ['pattern', 'url', 'query', 'command', 'skill', 'description', 'subagent_type', 'prompt', 'action']) {
    const v = field(input, key)
    if (v) return short(v)
  }
  return name.startsWith('mcp__') ? short(name.split('__').slice(1).join(' ')) : ''
}

export function describeAction(a: Action): string {
  const end = a.outcome === 'error' ? ' (failed)' : a.outcome === 'denied' ? ' (refused)' : ''
  return `${a.name}${a.target ? ` ${a.target}` : ''}${end}`
}

// ---------- the record a small model words ----------

export const MAX_TRACE_STEPS = 40

/** True when there is nothing to word: one step that only wrote the answer. */
export function isTrivial(turn: Turn): boolean {
  return turn.steps.length <= 1 && turn.steps.every(s => s.actions.length === 0 && s.subSteps === 0)
}

/** The visible record of a turn as compact JSON: request, steps (thinking as shown, actions), answer. */
export function traceFor(turn: Turn): string {
  const steps = turn.steps.length > MAX_TRACE_STEPS
    ? [...turn.steps.slice(0, MAX_TRACE_STEPS / 2), ...turn.steps.slice(-MAX_TRACE_STEPS / 2)]
    : turn.steps
  return JSON.stringify({
    request: short(turn.prompt, 700),
    steps: steps.map(s => ({
      step: s.n,
      thinking_as_shown: s.thinking ? short(s.thinking, 300) : s.thinkingBlocks > 0 ? '(hidden)' : '',
      actions: [
        ...s.actions.slice(0, 8).map(describeAction),
        ...(s.actions.length > 8 ? [`and ${s.actions.length - 8} more`] : []),
        ...(s.subSteps > 0 ? [`subagents took ${s.subSteps} steps`] : []),
      ],
      wrote_text: s.wroteChars > 0,
    })),
    ...(turn.steps.length > MAX_TRACE_STEPS ? { note: `${turn.steps.length - MAX_TRACE_STEPS} middle steps left out` } : {}),
    answer: short(turn.answer, 700),
  })
}

export const SYSTEM = [
  'You turn the record of how an AI assistant handled one request into a short flow that a reader can follow.',
  'Use only what the record shows. Never state a reason, a finding or a result that the record does not show.',
  'Write plain words, in the past tense, for a reader who knows neither the tools nor the project: "Read the routine settings", not "Read routines.json"; "Compared the two versions", not "Diffed".',
  'Avoid tool words such as diff, grep, snapshot, commit, prepend or repo unless the reader needs them.',
].join(' ')

export function promptFor(turn: Turn): string {
  const n = turn.steps.length
  return [
    'The record:',
    traceFor(turn),
    '',
    `Group the ${n} steps into 2 to 6 stages, in order. Each stage covers consecutive steps, and together the stages cover every step from 1 to ${n} exactly once.`,
    'For each stage give: "label", a verb phrase of at most 6 words saying what was done; "detail", at most 14 words on what that stage found or decided, or "" when the record does not show it; "steps", the step numbers it covers.',
    'Also give "answer": the answer in at most 12 words.',
    'Reply with JSON only, in this shape: {"stages":[{"label":"...","detail":"...","steps":[1,2]}],"answer":"..."}',
  ].join('\n')
}

/** Reads the model's reply and accepts it only when the stages cover steps 1..n once, in order. */
export function parseFlow(text: string, n: number): Flow | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const raw = (data as { stages?: unknown }).stages
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return null
  const stages: Stage[] = []
  const seen: number[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const label = field(item, 'label')
    const detail = field(item, 'detail')
    const steps = (item as { steps?: unknown }).steps
    if (!label || !Array.isArray(steps) || steps.length === 0) return null
    if (!steps.every(x => typeof x === 'number' && Number.isInteger(x))) return null
    seen.push(...(steps as number[]))
    stages.push({ label: short(label, 60), detail: short(detail, 110), steps: steps as number[] })
  }
  if (seen.length !== n || seen.some((x, i) => x !== i + 1)) return null
  const answer = field(data, 'answer')
  return { by: 'haiku', stages, answer: short(answer || '', 120) }
}

// ---------- kinds of work ----------

// When steps did several kinds of work, the strongest names them: a change matters most to the
// reader, then a command, a subagent, a lookup, words to the person, and thinking last.
const STRENGTH: readonly Lane[] = ['change', 'run', 'delegate', 'look', 'talk', 'think']

/** The strongest kind of work in some steps. A refused call never ran, so it does not count. */
function strongest(steps: Step[]): Lane {
  const seen = new Set<Lane>()
  for (const s of steps) {
    for (const a of s.actions) if (a.outcome !== 'denied') seen.add(a.lane)
    if (s.actions.length === 0 && s.subSteps > 0) seen.add('delegate')
    if (s.wroteChars > 0) seen.add('talk')
  }
  return STRENGTH.find(lane => seen.has(lane)) ?? 'think'
}

/** What a stage box shows by its border color. Writing to the person counts with thinking: neither works outside the conversation. */
export type Kind = 'think' | 'look' | 'change' | 'run' | 'delegate'

export function kindOf(turn: Turn, stage: Stage): Kind {
  const lane = strongest(turn.steps.filter(s => stage.steps.includes(s.n)))
  return lane === 'talk' ? 'think' : lane
}

// ---------- rules, when the model is not used or fails ----------

function keyOf(step: Step): Lane {
  return strongest([step])
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function ruleLabel(key: Lane, steps: Step[]): Stage {
  const actions = steps.flatMap(s => s.actions).filter(a => a.outcome !== 'denied')
  const targets = [...new Set(actions.map(a => a.target).filter(Boolean))]
  const detail = short(targets.slice(0, 3).join(', ') + (targets.length > 3 ? `, and ${targets.length - 3} more` : ''), 110)
  const n = steps.map(s => s.n)
  const label =
    key === 'look' ? `Looked at ${plural(actions.filter(a => a.lane === 'look').length, 'source', 'sources')}`
    : key === 'change' ? `Changed ${plural(new Set(actions.filter(a => a.lane === 'change').map(a => a.target)).size, 'file', 'files')}`
    : key === 'run' ? `Ran ${plural(actions.filter(a => a.lane === 'run').length, 'command', 'commands')}`
    : key === 'delegate' ? `Handed work to subagents`
    : key === 'talk' ? 'Wrote to you'
    : 'Thought it through'
  return { label, detail: key === 'think' ? short(steps.map(s => s.thinking).filter(Boolean).join(' '), 110) : detail, steps: n }
}

/** Groups consecutive steps of the same kind of work, labelled by fixed rules. */
export function rulesFlow(turn: Turn, note?: string): Flow {
  const stages: Stage[] = []
  let run: Step[] = []
  let key: Lane | null = null
  for (const step of turn.steps) {
    const k = keyOf(step)
    if (key !== null && k !== key) {
      stages.push(ruleLabel(key, run))
      run = []
    }
    key = k
    run.push(step)
  }
  if (key !== null) stages.push(ruleLabel(key, run))
  return { by: 'rules', stages, answer: short(turn.answer || '(no answer text)', 120), ...(note ? { note } : {}) }
}

// ---------- drawing ----------

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Splits text into at most `max` lines of about `width` characters, by words. */
export function wrap(text: string, width: number, max: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width && line) {
      lines.push(line)
      line = w
      if (lines.length === max) break
    } else line = (line + ' ' + w).trim()
  }
  if (lines.length < max && line) lines.push(line)
  const used = lines.join(' ').length
  if (used < text.replace(/\s+/g, ' ').trim().length && lines.length) {
    lines[lines.length - 1] = short(lines[lines.length - 1] + ' …', width)
  }
  return lines
}

// The drawing's own coordinate space is narrow (VIEW_W units); the markup declares a much larger
// width (DECLARED_W px) so the pane's box takes the full panel width ("the markup's own width up
// to the slot") and the drawing scales up to it. Text sizes below are in coordinate units, so a
// wider panel shows proportionally larger text.
const VIEW_W = 400
const DECLARED_W = 1600
const PAD = 10
const BOX_X = PAD
const BOX_W = VIEW_W - 2 * PAD
const GAP = 22
const TITLE = { size: 15, line: 19, chars: 40, lines: 2 }
const BODY = { size: 13, line: 17, chars: 50, lines: 3 }
const TOOLS = { size: 11, line: 14, chars: 60, lines: 2 }
// The palette: a deep charcoal canvas, navy-black stage boxes with white text and colored outlines,
// a white card for the question and a lemon-yellow card for the answer.
const CANVAS = '#121212'
const BOX = '#0D1137'
const WHITE = '#FDFDFD'
const INK = { title: WHITE, body: '#CDCED5', tools: '#9193A4', dark: BOX }
const QUESTION = WHITE
const ANSWER = '#E2D810'
/** Stage kinds in the order the color key lists them: outline color, dashed or solid, and label. */
export const KINDS: readonly Kind[] = ['think', 'look', 'change', 'run', 'delegate']
// Four outline colors stay distinct, also for color-blind readers; subagents share white, dashed.
export const KIND: Record<Kind, { color: string; dashed: boolean; label: string }> = {
  think: { color: WHITE, dashed: false, label: 'Thought or wrote to you' },
  look: { color: '#12A4D9', dashed: false, label: 'Looked at files or the web' },
  change: { color: '#E52165', dashed: false, label: 'Made changes' },
  run: { color: '#CCA800', dashed: false, label: 'Ran commands or tools' },
  delegate: { color: WHITE, dashed: true, label: 'Handed work to subagents' },
}
// The legend, titled "Color key": a card above the flow, two entries per row.
const LEGEND = { size: 11, row: 17, col: 184 }

/** The color key card for the kinds a flow uses, drawn at y; returns its markup and height. */
function legendCard(kinds: Kind[], y: number): { svg: string; h: number } {
  if (kinds.length === 0) return { svg: '', h: 0 }
  const left = BOX_X + 12
  const h = 25 + Math.ceil(kinds.length / 2) * LEGEND.row
  const entries = kinds.map((k, i) => {
    const x = left + (i % 2) * LEGEND.col
    const ry = y + 17 + LEGEND.row * (Math.floor(i / 2) + 1)
    const dash = KIND[k].dashed ? ' stroke-dasharray="3 2"' : ''
    return `<rect x="${x}" y="${ry - 9}" width="16" height="11" rx="3" fill="${BOX}" stroke="${KIND[k].color}" stroke-width="2"${dash} />` +
      `<text x="${x + 22}" y="${ry}" font-size="${LEGEND.size}" fill="${INK.body}">${escapeXml(KIND[k].label)}</text>`
  })
  const svg = `<g><rect x="${BOX_X}" y="${y}" width="${BOX_W}" height="${h}" rx="8" fill="${BOX}" stroke="${INK.tools}" stroke-opacity="0.5" stroke-width="1" />` +
    `<text x="${left}" y="${y + 17}" font-size="${LEGEND.size}" font-weight="600" fill="${INK.tools}">Color key</text>${entries.join('')}</g>`
  return { svg, h }
}

/** A short display name for a tool: "Read", "Browser navigate", "Slack send_message". */
export function toolName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  const server = parts[1] ?? ''
  const tool = parts[parts.length - 1] ?? name
  const label = /Claude_Browser/i.test(server) ? 'Browser' : /claude-in-chrome/i.test(server) ? 'Chrome' : server.replace(/^[0-9a-f-]{20,}$/i, 'Connector')
  return `${label} ${tool}`
}

/** The tool calls of some steps as "Read ×3, Bash ×2", in order of first use, plus failures and subagent steps. */
export function toolSummary(steps: Step[]): string {
  const counts = new Map<string, number>()
  let failed = 0
  for (const s of steps) {
    for (const a of s.actions) {
      const n = toolName(a.name)
      counts.set(n, (counts.get(n) ?? 0) + 1)
      if (a.outcome === 'error' || a.outcome === 'denied') failed += 1
    }
  }
  const subs = steps.reduce((a, s) => a + s.subSteps, 0)
  const bits = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  if (subs > 0) bits.push(`${subs} subagent steps`)
  if (failed > 0) bits.push(`${failed} failed`)
  return bits.join(', ')
}

/** The flow as a vertical SVG that fills the pane's width: a color key, then question, stages, answer, with arrows. */
export function svgFlow(turn: Turn, flow: Flow): { source: string; alt: string; width: number; height: number } {
  type Box = {
    fill: string
    stroke: string | null
    dashed: boolean
    ink: { title: string; body: string }
    title: string
    body: string[]
    tools: string[]
    tip: string
  }
  const onCard = { title: INK.dark, body: INK.dark }
  const onBox = { title: INK.title, body: INK.body }
  const boxes: Box[] = []
  const used = new Set<Kind>()
  const said: string[] = []
  boxes.push({ fill: QUESTION, stroke: null, dashed: false, ink: onCard, title: 'Question', body: wrap(turn.prompt, BODY.chars, BODY.lines), tools: [], tip: turn.prompt })
  for (const stage of flow.stages) {
    const kind = kindOf(turn, stage)
    used.add(kind)
    said.push(`${stage.label} (${KIND[kind].label.toLowerCase()})`)
    const steps = turn.steps.filter(s => stage.steps.includes(s.n))
    const acts = steps.flatMap(s => s.actions.map(describeAction))
    const subs = steps.reduce((a, s) => a + s.subSteps, 0)
    const thought = steps.map(s => s.thinking).filter(Boolean).join(' ')
    const tip = [
      `Steps ${stage.steps[0]}${stage.steps.length > 1 ? `–${stage.steps[stage.steps.length - 1]}` : ''}`,
      ...acts.slice(0, 12),
      ...(acts.length > 12 ? [`and ${acts.length - 12} more`] : []),
      ...(subs > 0 ? [`${subs} steps inside subagents`] : []),
      ...(thought ? [`Thinking as shown: ${short(thought, 240)}`] : []),
    ].join('\n')
    const summary = toolSummary(steps)
    boxes.push({
      fill: BOX,
      stroke: KIND[kind].color,
      dashed: KIND[kind].dashed,
      ink: onBox,
      title: stage.label,
      body: stage.detail ? wrap(stage.detail, BODY.chars, BODY.lines) : [],
      tools: summary ? wrap(`Tools: ${summary}`, TOOLS.chars, TOOLS.lines) : [],
      tip,
    })
  }
  boxes.push({ fill: ANSWER, stroke: null, dashed: false, ink: onCard, title: 'Answer', body: wrap(flow.answer, BODY.chars, BODY.lines), tools: [], tip: short(turn.answer, 600) })

  const parts: string[] = []
  const cx = BOX_X + BOX_W / 2
  const left = BOX_X + 12
  let y = PAD
  const legend = legendCard(KINDS.filter(k => used.has(k)), y)
  if (legend.h > 0) {
    parts.push(legend.svg)
    y += legend.h + 14
  }
  boxes.forEach((b, i) => {
    const titleLines = wrap(b.title, TITLE.chars, TITLE.lines)
    const toolsH = b.tools.length > 0 ? 6 + b.tools.length * TOOLS.line : 0
    const h = 12 + titleLines.length * TITLE.line + b.body.length * BODY.line + toolsH + 10
    let ty = y + 12 + TITLE.size - 2
    const lines: string[] = []
    for (const line of titleLines) {
      lines.push(`<text x="${cx}" y="${ty}" text-anchor="middle" font-size="${TITLE.size}" font-weight="600" fill="${b.ink.title}">${escapeXml(line)}</text>`)
      ty += TITLE.line
    }
    for (const line of b.body) {
      lines.push(`<text x="${cx}" y="${ty}" text-anchor="middle" font-size="${BODY.size}" fill="${b.ink.body}">${escapeXml(line)}</text>`)
      ty += BODY.line
    }
    if (b.tools.length > 0) {
      // bottom left, under a thin rule
      const ruleY = y + h - 10 - b.tools.length * TOOLS.line - 3
      lines.push(`<line x1="${left}" y1="${ruleY}" x2="${BOX_X + BOX_W - 12}" y2="${ruleY}" stroke="${b.stroke ?? INK.tools}" stroke-opacity="0.25" stroke-width="1" />`)
      let ly = ruleY + TOOLS.size + 2
      for (const line of b.tools) {
        lines.push(`<text x="${left}" y="${ly}" text-anchor="start" font-size="${TOOLS.size}" fill="${INK.tools}">${escapeXml(line)}</text>`)
        ly += TOOLS.line
      }
    }
    const outline = b.stroke ? ` stroke="${b.stroke}" stroke-width="2"${b.dashed ? ' stroke-dasharray="6 4"' : ''}` : ''
    const frame = `<rect x="${BOX_X}" y="${y}" width="${BOX_W}" height="${h}" rx="8" fill="${b.fill}"${outline} />`
    parts.push(`<g><title>${escapeXml(b.tip)}</title>${frame}${lines.join('')}</g>`)
    y += h
    if (i < boxes.length - 1) {
      parts.push(`<line x1="${cx}" y1="${y + 3}" x2="${cx}" y2="${y + GAP - 4}" stroke="${INK.tools}" stroke-width="1.5" />`)
      parts.push(`<path d="M${cx - 5} ${y + GAP - 9} L${cx} ${y + GAP - 3} L${cx + 5} ${y + GAP - 9}" fill="none" stroke="${INK.tools}" stroke-width="1.5" />`)
      y += GAP
    }
  })
  const viewH = y + PAD
  const declaredH = Math.round((viewH * DECLARED_W) / VIEW_W)
  const alt = `Flow of how the answer came about: ${said.join(', then ')}; answer: ${flow.answer}`
  // The whole figure sits on its own dark canvas, so it looks the same on a light or a dark panel.
  const canvas = `<rect x="0" y="0" width="${VIEW_W}" height="${viewH}" rx="12" fill="${CANVAS}" />`
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${DECLARED_W}" height="${declaredH}" viewBox="0 0 ${VIEW_W} ${viewH}" preserveAspectRatio="xMidYMin meet" font-family="-apple-system, Segoe UI, sans-serif">${canvas}${parts.join('')}</svg>`
  return { source, alt, width: DECLARED_W, height: declaredH }
}

/** The flow as numbered lines, for surfaces without Svg. */
export function textFlow(turn: Turn, flow: Flow): string[] {
  return [
    `Question: ${short(turn.prompt, 100)}`,
    ...flow.stages.map((s, i) => `${i + 1}. ${s.label}${s.detail ? ` — ${s.detail}` : ''}`),
    `Answer: ${flow.answer}`,
  ]
}

/** One line on who worded the flow. */
export function creditOf(turn: Turn, flow: Flow): string {
  if (flow.by === 'haiku') return 'Steps worded by a small model (Haiku) from what was visible: thinking summaries, tool calls and the answer.'
  if (turn.flowState === 'pending' || turn.flowState === 'working') return 'Grouped by rules for now; the small model is wording the steps.'
  return `Grouped by rules${flow.note ? ` (${flow.note})` : ''}.`
}

/** What each stage did, for the "Show actions" list: its label, then its actions and thinking as shown. */
export function stageDetails(turn: Turn, flow: Flow): { label: string; lines: string[] }[] {
  return flow.stages.map(stage => {
    const steps = turn.steps.filter(s => stage.steps.includes(s.n))
    const acts = steps.flatMap(s => s.actions.map(describeAction))
    const subs = steps.reduce((a, s) => a + s.subSteps, 0)
    const thought = steps.map(s => s.thinking).filter(Boolean).join(' ')
    const span = stage.steps.length > 1 ? `steps ${stage.steps[0]}–${stage.steps[stage.steps.length - 1]}` : `step ${stage.steps[0]}`
    return {
      label: `${stage.label} (${span})`,
      lines: [
        ...acts.slice(0, 10),
        ...(acts.length > 10 ? [`and ${acts.length - 10} more`] : []),
        ...(subs > 0 ? [`${subs} steps inside subagents`] : []),
        ...(thought ? [`Thinking as shown: ${short(thought, 200)}`] : []),
        ...(acts.length === 0 && subs === 0 && !thought ? ['(no actions; wrote text)'] : []),
      ],
    }
  })
}
