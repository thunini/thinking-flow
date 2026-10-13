// thinking-flow: a simple flow of how Claude reached each answer.
//
// While a turn runs, the mod watches each main-loop model request (turn.step) without changing
// it and records what was visible: the thinking text as the session shows it (summaries, or
// nothing when hidden), the tool calls, and whether the step wrote text. When the turn ends, a
// timer started at session start sends that record to a small model (Haiku), which groups the
// steps into a few plain-word stages. Its reply is used only if the stages cover every step
// once, in order; otherwise fixed rules group the steps. The "wording" setting set to "rules"
// skips the model call entirely. Each stage keeps the steps it covers,
// so "Show actions" can list the actions behind it. State lives in the session and ends with it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Action, Step, Turn, View } from '../types'
import { creditOf, isTrivial, laneOf, parseFlow, promptFor, rulesFlow, short, stageDetails, svgFlow, SYSTEM, targetOf, textFlow } from './flow'

const PANE = 'thinking-flow'
const MAX_TURNS = 30
const MAX_STEPS = 300
const THINKING_CAP = 500
const MODEL = 'haiku'

const turnsAtom = atom({ plugin: 'thinking-flow', key: 'turns' } as const, [] as Turn[])
const viewAtom = atom({ plugin: 'thinking-flow', key: 'view' } as const, { turn: null } as View)

function withTurn(turns: Turn[], id: string, fn: (t: Turn) => Turn): Turn[] {
  return turns.map(t => (t.id === id ? fn(t) : t))
}

/** The main turn still running: subagent steps and outcomes are filed under it. */
function openTurnId(turns: Turn[]): string | undefined {
  return [...turns].reverse().find(t => t.flowState === 'open')?.id
}

/** Words every pending turn's flow, oldest first; one call at a time. */
async function drain($: EngineInterface, busy: { now: boolean }, useModel: boolean): Promise<void> {
  if (busy.now) return
  busy.now = true
  try {
    for (;;) {
      const turns = await read($, turnsAtom)
      const turn = turns.find(t => t.flowState === 'pending')
      if (!turn) return
      await update($, turnsAtom, list => withTurn(list, turn.id, t => ({ ...t, flowState: 'working' })))
      let flow = isTrivial(turn)
        ? rulesFlow(turn, 'a one-step answer')
        : useModel ? undefined : rulesFlow(turn, 'the small model is turned off in settings')
      if (!flow) {
        try {
          const reply = await $.model.complete({ model: MODEL, system: SYSTEM, prompt: promptFor(turn), maxTokens: 800, timeoutMs: 45000 })
          flow = reply.isAnswered
            ? parseFlow(reply.text, turn.steps.length) ?? rulesFlow(turn, 'the small model gave an unusable reply')
            : rulesFlow(turn, `the small model did not answer: ${reply.reason}`)
        } catch {
          flow = rulesFlow(turn, 'the small model could not be called')
        }
      }
      const done = flow
      await update($, turnsAtom, list => withTurn(list, turn.id, t => ({ ...t, flowState: 'done', flow: done })))
    }
  } finally {
    busy.now = false
  }
}

export const register: Register = (on, options) => {
  const busy = { now: false }
  // The "wording" setting: "rules" keeps every flow on fixed labels and makes no model call.
  const useModel = options.wording !== 'rules'

  on('session.start', async ($, e, next) => {
    // The timer below must start even if registering the command fails.
    await $.command.register({
      name: 'thinking-flow',
      description: 'Show a simple flow of how Claude reached each answer',
    }).catch(() => undefined)
    // Turns left half-done by a reload are picked up again.
    await update($, turnsAtom, list => list.map((t): Turn => (t.flowState === 'working' ? { ...t, flowState: 'pending' } : t))).catch(() => undefined)
    $.clock.every(1500, () => {
      void drain($, busy, useModel)
    })
    return next(e)
  })

  on('command.run', { command: 'thinking-flow' }, async $ => {
    await update($, viewAtom, v => ({ ...v, turn: null }))
    await $.ui.open({ id: PANE, title: 'Thinking flow' })
    return { text: 'Thinking flow opened. Each answer from now on gets a flow.' }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now().catch(() => 0)
    const turn: Turn = { id: e.turnId, prompt: e.text || '(a continuation)', answer: '', startedAt: now, steps: [], flowState: 'open' }
    await update($, turnsAtom, list => [...list, turn].slice(-MAX_TURNS)).catch(() => undefined)
    return next(e)
  })

  // Watch every chunk and pass it on unchanged; record the step when it ends.
  on('turn.step', async function* ($, e, next) {
    const ids: string[] = []
    const blocks = new Set<number>()
    let thinking = ''
    let thinkingChars = 0
    let wroteChars = 0

    const stream = next(e)
    for await (const chunk of stream) {
      try {
      if (chunk.kind === 'thinking') {
        blocks.add(chunk.index)
        thinkingChars += chunk.text.length
        if (thinking.length < THINKING_CAP) thinking = (thinking + chunk.text).slice(0, THINKING_CAP)
      } else if (chunk.kind === 'text') {
        wroteChars += chunk.text.length
      } else if (chunk.kind === 'tool') {
        ids.push(chunk.id)
      }
      } catch {
        // observing must never stop the stream
      }
      yield chunk
    }
    let result
    try {
      result = await stream.result
    } catch {
      result = undefined
    }

    const actions: Action[] = (result?.toolUses ?? []).map((use, i) => ({
      id: ids[i] ?? `${e.turnId}:${e.index}:${i}`,
      name: use.name,
      target: targetOf(use.name, use.input),
      lane: laneOf(use.name, use.input),
      outcome: 'running',
    }))

    await update($, turnsAtom, list => {
      if (e.agentId !== undefined) {
        // A subagent's step: count it on the step of the running main turn that started it.
        const owner = openTurnId(list)
        return owner === undefined
          ? list
          : withTurn(list, owner, t => (t.steps.length === 0 ? t : {
              ...t,
              steps: t.steps.map((s, i) => (i === t.steps.length - 1 ? { ...s, subSteps: s.subSteps + 1 } : s)),
            }))
      }
      const step: Step = {
        n: e.index + 1,
        thinking: thinking.replace(/\s+/g, ' ').trim(),
        thinkingChars,
        thinkingBlocks: blocks.size,
        actions,
        subSteps: 0,
        wroteChars,
      }
      return withTurn(list, e.turnId, t => (t.steps.length >= MAX_STEPS ? t : { ...t, steps: [...t.steps, step] }))
    }).catch(() => undefined)
    return result
  })

  // Mark how each tool call ended.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    const outcome: Action['outcome'] = ran.deny !== undefined ? 'denied' : ran.isError ? 'error' : 'ok'
    const id = e.tool_use_id
    await update($, turnsAtom, list => list.map(t =>
      t.flowState !== 'open' ? t : {
        ...t,
        steps: t.steps.map(s => (s.actions.some(a => a.id === id) ? { ...s, actions: s.actions.map(a => (a.id === id ? { ...a, outcome } : a)) } : s)),
      })).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e)) // only watching: if this hook fails, the call goes on unchanged

  // Only the main turn's end queues the flow; a subagent run ends with its own agentId.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now().catch(() => 0)
      await update($, turnsAtom, list => withTurn(list, e.turnId, t => ({
        ...t,
        answer: e.answer,
        endedAt: now,
        reason: e.reason,
        flowState: t.steps.length === 0 ? 'done' : 'pending',
      }))).catch(() => undefined)
    } else {
      // Defensive: should a subagent run ever open a turn of its own, drop it when it ends.
      await update($, turnsAtom, list => list.filter(t => t.id !== e.turnId)).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const turns = (await read($, turnsAtom)).filter(t => t.steps.length > 0 || t.flowState === 'open')
    const view = await read($, viewAtom)
    const at = view.turn === null ? turns.length - 1 : Math.min(Math.max(view.turn, 0), turns.length - 1)
    const turn = turns[at]
    const { Box, Text, Button } = $.ui.resolve(e)

    if (!turn) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No answer yet. The flow appears when the next answer is done.</Text>
        </Box>
      )
    }

    const go = (n: number | null) => update($, viewAtom, v => ({ ...v, turn: n }))
    const showDetails = view.details === true
    const toggle = () => update($, viewAtom, v => ({ ...v, details: !(v.details === true) }))
    const nav = (
      <Box flexDirection="row" gap={1}>
        <Button key="prev" label="Previous answer" onPress={() => go(Math.max(at - 1, 0))} />
        <Button key="next" label="Next answer" onPress={() => go(at + 1 >= turns.length - 1 ? null : at + 1)} />
        <Button key="latest" label="Latest" onPress={() => go(null)} />
      </Box>
    )
    const title = <Text bold>{`Answer ${at + 1} of ${turns.length}`}</Text>

    if (turn.flowState === 'open') {
      return (
        <Box flexDirection="column" gap={1}>
          {title}
          <Text dimColor>{`Working: ${turn.steps.length} steps so far. The flow appears when the answer is done.`}</Text>
          {nav}
        </Box>
      )
    }

    const flow = turn.flow ?? rulesFlow(turn)
    const credit = creditOf(turn, flow)
    const details = (
      <Box flexDirection="column" gap={1}>
        <Button key="details" label={showDetails ? 'Hide actions' : 'Show actions'} onPress={toggle} />
        {showDetails
          ? stageDetails(turn, flow).map((d, i) => (
              <Box key={`d${i}`} flexDirection="column">
                <Text bold>{`${i + 1}. ${d.label}`}</Text>
                {d.lines.map((line, j) => <Text key={`d${i}-${j}`} dimColor>{`   ${line}`}</Text>)}
              </Box>
            ))
          : null}
      </Box>
    )

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const drawn = svgFlow(turn, flow)
      return (
        <Box flexDirection="column" gap={1}>
          {title}
          <Svg key="flow" source={drawn.source} alt={drawn.alt} />
          <Text dimColor>{credit}</Text>
          {details}
          {nav}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {title}
        <Box flexDirection="column">
          {textFlow(turn, flow).map((line, i) => <Text key={`l${i}`}>{line}</Text>)}
        </Box>
        <Text dimColor>{short(credit, 160)}</Text>
        {details}
        {nav}
      </Box>
    )
  })
}
