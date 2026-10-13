import { describe, expect, mock, test } from 'claude-code/testing'

import type { Action, Lane, Step, Turn } from '../types'
import { escapeXml, KIND, kindOf, laneOf, parseFlow, rulesFlow, svgFlow, textFlow, toolName, toolSummary, wrap } from '../hooks/flow'

const step = (n: number, over: Partial<Step> = {}): Step => ({
  n, thinking: '', thinkingChars: 0, thinkingBlocks: 0, actions: [], subSteps: 0, wroteChars: 0, ...over,
})
const act = (name: string, target: string, lane: Lane, outcome: Action['outcome'] = 'ok'): Action =>
  ({ id: `${name}-${target}`, name, target, lane, outcome })

const turn: Turn = {
  id: 't1', prompt: 'Why did the Monday routine not commit?', answer: 'The routine ran but its push failed.', startedAt: 0,
  flowState: 'done',
  steps: [
    step(1, { thinking: 'I should look at the routine log first.', thinkingChars: 40, thinkingBlocks: 1, actions: [act('Read', 'routines.json', 'look'), act('Grep', 'push', 'look')] }),
    step(2, { actions: [act('Bash', 'git push', 'run', 'error')] }),
    step(3, { actions: [act('Edit', 'register.tsx', 'change')] }),
    step(4, { wroteChars: 120 }),
  ],
}

describe('parseFlow', () => {
  test('accepts stages that cover every step once, in order', async () => {
    const f = parseFlow('```json\n{"stages":[{"label":"Checked the routine","detail":"","steps":[1,2]},{"label":"Fixed it","detail":"Edited the hook","steps":[3,4]}],"answer":"The push failed"}\n```', 4)
    expect(f?.by).toBe('haiku')
    expect(f?.stages.length).toBe(2)
    expect(f?.answer).toBe('The push failed')
  })
  test('refuses a gap, an overlap, a wrong order, and prose', async () => {
    expect(parseFlow('{"stages":[{"label":"A","steps":[1,2]},{"label":"B","steps":[4]}]}', 4)).toBe(null)
    expect(parseFlow('{"stages":[{"label":"A","steps":[1,2]},{"label":"B","steps":[2,3,4]}]}', 4)).toBe(null)
    expect(parseFlow('{"stages":[{"label":"A","steps":[2,1]},{"label":"B","steps":[3,4]}]}', 4)).toBe(null)
    expect(parseFlow('I looked at the files and then fixed it.', 4)).toBe(null)
  })
})

describe('rulesFlow', () => {
  test('groups consecutive steps by the kind of work', async () => {
    const f = rulesFlow(turn)
    expect(f.by).toBe('rules')
    expect(f.stages.map(s => s.label)).toEqual(['Looked at 2 sources', 'Ran 1 command', 'Changed 1 file', 'Wrote to you'])
    expect(f.stages.flatMap(s => s.steps)).toEqual([1, 2, 3, 4])
  })
})

describe('laneOf', () => {
  test('browser reading is looking, a shell edit is running, a read-only shell is looking', async () => {
    expect(laneOf('mcp__Claude_Browser__navigate', { url: 'https://x' })).toBe('look')
    expect(laneOf('mcp__claude-in-chrome__form_input', {})).toBe('change')
    expect(laneOf('Bash', { command: 'git status --short' })).toBe('look')
    expect(laneOf('Bash', { command: 'npm install' })).toBe('run')
    expect(laneOf('Edit', { file_path: '/a' })).toBe('change')
  })
})

describe('tool summary', () => {
  test('counts tools in order of first use, shortens connector names, and counts failures', async () => {
    expect(toolSummary(turn.steps)).toBe('Read, Grep, Bash, Edit, 1 failed')
    expect(toolSummary([step(1, { actions: [act('Read', 'a', 'look'), act('Read', 'b', 'look')], subSteps: 4 })])).toBe('Read ×2, 4 subagent steps')
    expect(toolName('mcp__Claude_Browser__navigate')).toBe('Browser navigate')
  })
  test('each stage box carries its summary and the outline of its kind', async () => {
    const { source } = svgFlow(turn, rulesFlow(turn))
    expect(source.includes('Tools: Read, Grep')).toBe(true)
    expect(source.includes('Tools: Bash, 1 failed')).toBe(true)
    expect(new RegExp(`rx="8" fill="#[0-9A-Fa-f]{6}" stroke="${KIND.look.color}" stroke-width="2" />`).test(source)).toBe(true)
  })
})

describe('kinds of work', () => {
  test('a box takes the strongest kind in its steps; refused calls and the to-do list change nothing', async () => {
    const t: Turn = {
      ...turn,
      steps: [
        step(1, { actions: [act('Read', 'a', 'look'), act('Read', 'b', 'look'), act('Edit', 'a', 'change')] }),
        step(2, { actions: [act('Read', 'c', 'look'), act('Edit', 'c', 'change', 'denied')] }),
        step(3, { actions: [act('TodoWrite', '', laneOf('TodoWrite', {}))], wroteChars: 40 }),
        step(4, { actions: [act('Agent', 'review', 'delegate')], subSteps: 6 }),
        step(5, { thinking: 'Weighing the two options.', thinkingChars: 26, thinkingBlocks: 1 }),
      ],
    }
    const one = (n: number) => kindOf(t, { label: '', detail: '', steps: [n] })
    expect([1, 2, 3, 4, 5].map(one)).toEqual(['change', 'look', 'think', 'delegate', 'think'])
    expect(kindOf(t, { label: '', detail: '', steps: [1, 2, 3, 4, 5] })).toBe('change')
    expect(rulesFlow(t).stages.map(s => s.label)).toEqual(['Changed 1 file', 'Looked at 1 source', 'Wrote to you', 'Handed work to subagents', 'Thought it through'])
    // Subagents share white with thinking, so their box and key swatch are dashed.
    const { source } = svgFlow(t, rulesFlow(t))
    expect(source.includes(`stroke="${KIND.delegate.color}" stroke-width="2" stroke-dasharray="6 4"`)).toBe(true)
    expect(source.includes('stroke-dasharray="3 2"')).toBe(true)
  })
  test('the color key lists only the kinds the flow uses, in a fixed order', async () => {
    const { source, alt } = svgFlow(turn, rulesFlow(turn))
    expect(source.includes('Color key')).toBe(true)
    const at = [KIND.think.key, KIND.look.key, KIND.change.key, KIND.run.key].map(k => source.indexOf(k))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(source.includes(KIND.delegate.key)).toBe(false)
    expect(alt.includes('Looked at 2 sources (looked at files or the web)')).toBe(true)
  })
})

describe('drawing', () => {
  test('the SVG holds every label, escapes markup, and lists actions in the hover text', async () => {
    const f = rulesFlow({ ...turn, prompt: 'Is <b> & "x" safe?' })
    const { source } = svgFlow({ ...turn, prompt: 'Is <b> & "x" safe?' }, f)
    expect(source.includes('Looked at 2 sources')).toBe(true)
    expect(source.includes('&lt;b&gt; &amp; &quot;x&quot;')).toBe(true)
    expect(source.includes('Bash git push (failed)')).toBe(true)
    expect(source.includes('<b>')).toBe(false)
  })
  test('text lines and wrapping', async () => {
    expect(textFlow(turn, rulesFlow(turn))[0]).toBe('Question: Why did the Monday routine not commit?')
    expect(wrap('one two three four five six', 9, 2).length).toBe(2)
    expect(escapeXml('a<b')).toBe('a&lt;b')
  })
})

// A whole turn through the engine: the test's own hooks play the engine beneath the mod.
async function playTurn($: any, on: any, reply: string, seen = { modelCalls: 0 }) {
  on('session.start', async () => ({ cwd: '/repo' }))
  on('command.register', async () => ({ value: undefined }))
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('model.complete', async () => {
    seen.modelCalls += 1
    return { value: { isAnswered: true, text: reply, usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    if (e.index === 0) {
      yield { kind: 'thinking', index: 0, text: 'Check the settings file first.' }
      yield { kind: 'tool', index: 1, id: 'tu-1', name: 'Read' }
      return { turnId: e.turnId, index: 0, answer: '', toolUses: [{ name: 'Read', input: { file_path: '/repo/settings.json' } }], stopReason: 'tool_use', usage: null }
    }
    yield { kind: 'text', index: 0, text: 'The setting is on.' }
    return { turnId: e.turnId, index: 1, answer: 'The setting is on.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const clock = mock.clock(on, { now: 1000 })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true, startedAt: 1000 } as never)
  await $.turn.start({ text: 'Is the setting on?', turnId: 'turn-1' })
  for (const index of [0, 1]) {
    const s = $.turn.step({ turnId: 'turn-1', index, model: 'claude-opus-5-5', messageCount: 1 + index })
    for await (const _ of s) { /* drain */ }
    await s.result
  }
  await $.turn.complete({ turnId: 'turn-1', answer: 'The setting is on.', durationMs: 1200, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1600)
  await clock.settle()
}

const PANE = { component: 'Pane', requestId: 'thinking-flow', props: { title: 'Thinking flow' } as never } as const

test('a finished turn is worded by the small model and drawn as a flow', async ($, on) => {
  await playTurn($, on, '{"stages":[{"label":"Checked the settings file","detail":"Found the option","steps":[1]},{"label":"Reported back","detail":"","steps":[2]}],"answer":"Yes, the setting is on"}')
  const desktop = await $.ui.mount({ plugin: 'thinking-flow', surface: 'desktop', ...PANE })
  const svg = await desktop.find({ type: 'Svg' })
  expect(String(svg?.props.source).includes('Checked the settings file')).toBe(true)
  expect((await desktop.find({ type: 'Text', text: /worded by a small model/ })) !== undefined).toBe(true)
  expect((await desktop.find({ type: 'Text', text: /repo\/settings\.json/ })) === undefined).toBe(true)
  await desktop.press({ key: 'details' })
  expect((await desktop.find({ type: 'Text', text: /Read repo\/settings\.json/ })) !== undefined).toBe(true)
  expect(svg?.props.isInteractive === undefined).toBe(true)
  await desktop.unmount()
  const terminal = await $.ui.mount({ plugin: 'thinking-flow', surface: 'terminal', ...PANE })
  expect((await terminal.find({ type: 'Text', text: /1\. Checked the settings file/ })) !== undefined).toBe(true)
  await terminal.unmount()
})

test('with wording set to rules, no model call is made', { options: { wording: 'rules' } }, async ($, on) => {
  const seen = { modelCalls: 0 }
  await playTurn($, on, '{"stages":[],"answer":""}', seen)
  expect(seen.modelCalls).toBe(0)
  const desktop = await $.ui.mount({ plugin: 'thinking-flow', surface: 'desktop', ...PANE })
  expect(String((await desktop.find({ type: 'Svg' }))?.props.source).includes('Looked at 1 source')).toBe(true)
  expect((await desktop.find({ type: 'Text', text: /turned off in settings/ })) !== undefined).toBe(true)
  await desktop.unmount()
})

test('an unusable model reply falls back to rules, and says so', async ($, on) => {
  await playTurn($, on, 'Sure! First the assistant looked around.')
  const desktop = await $.ui.mount({ plugin: 'thinking-flow', surface: 'desktop', ...PANE })
  const svg = await desktop.find({ type: 'Svg' })
  expect(String(svg?.props.source).includes('Looked at 1 source')).toBe(true)
  expect((await desktop.find({ type: 'Text', text: /unusable reply/ })) !== undefined).toBe(true)
  await desktop.unmount()
})
