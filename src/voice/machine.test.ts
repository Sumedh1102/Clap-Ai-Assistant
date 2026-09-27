import { describe, expect, it } from 'vitest'
import {
  initialContext,
  isTurnState,
  recognizerMode,
  restingState,
  TIMINGS,
  transition,
  type Effect,
  type MachineContext,
  type MachineEvent,
  type PendingConfirmation,
} from './machine'

/** Apply events in order; return the final context and every effect produced. */
function run(ctx: MachineContext, ...events: MachineEvent[]): { ctx: MachineContext; effects: Effect[] } {
  const effects: Effect[] = []
  for (const event of events) {
    const next = transition(ctx, event)
    ctx = next.context
    effects.push(...next.effects)
  }
  return { ctx, effects }
}

const types = (effects: Effect[]) => effects.map((e) => e.type)

/** Connected, voice on, wake engine running: resting in LISTENING_FOR_WAKE. */
const awake = () => run(initialContext(), { type: 'CONNECTED' }, { type: 'VOICE_ENABLED', wakeAvailable: true }).ctx

/** A turn in flight, started by the wake phrase in one breath. */
const inTurn = (id = 't1') => run(awake(), { type: 'WAKE', trailing: 'what time is it', turnId: id }).ctx

const request: PendingConfirmation = { requestId: 'r1', label: 'Delete', summary: 'Delete 3 files', risk: 'high', expiresAt: 1 }

/** A turn waiting on the user's yes or no. */
const confirming = () => run(inTurn(), { type: 'CONFIRMATION_REQUESTED', turnId: 't1', request }).ctx

describe('resting', () => {
  it('starts offline and rests according to connection and voice', () => {
    expect(initialContext().state).toBe('OFFLINE')
    expect(run(initialContext(), { type: 'CONNECTED' }).ctx.state).toBe('IDLE')
    expect(awake().state).toBe('LISTENING_FOR_WAKE')
    // Voice on, but only push-to-talk available.
    expect(run(initialContext(), { type: 'CONNECTED' }, { type: 'VOICE_ENABLED', wakeAvailable: false }).ctx.state).toBe('IDLE')
    expect(restingState({ connected: false, voiceEnabled: true, wakeAvailable: true })).toBe('OFFLINE')
  })

  it('re-derives the resting state when wake availability changes (engine fallback)', () => {
    const ctx = run(awake(), { type: 'VOICE_ENABLED', wakeAvailable: false }).ctx
    expect(ctx.state).toBe('IDLE')
    expect(run(ctx, { type: 'VOICE_ENABLED', wakeAvailable: true }).ctx.state).toBe('LISTENING_FOR_WAKE')
  })

  it('does not disturb a turn when voice availability changes', () => {
    expect(run(inTurn(), { type: 'VOICE_ENABLED', wakeAvailable: false }).ctx.state).toBe('THINKING')
    expect(run(inTurn(), { type: 'VOICE_DISABLED' }).ctx.state).toBe('THINKING')
  })

  it('goes offline on disconnect, stopping any speech', () => {
    const { ctx, effects } = run(inTurn(), { type: 'DISCONNECTED' })
    expect(ctx).toMatchObject({ state: 'OFFLINE', turn: null, connected: false })
    expect(types(effects)).toContain('stopSpeech')
    expect(run(ctx, { type: 'CONNECTED' }).ctx.state).toBe('LISTENING_FOR_WAKE')
  })
})

describe('wake', () => {
  it('snaps to WAKE_DETECTED, then listens for a command', () => {
    const woke = run(awake(), { type: 'WAKE', trailing: '', turnId: 't1' })
    expect(woke.ctx.state).toBe('WAKE_DETECTED')
    expect(woke.effects).toEqual([
      { type: 'cue', name: 'wake' },
      { type: 'wakeDetected' },
      { type: 'startTimer', name: 'wakeSettle', ms: TIMINGS.wakeSettleMs },
    ])
    const listening = run(woke.ctx, { type: 'WAKE_SETTLED' })
    expect(listening.ctx.state).toBe('LISTENING')
    expect(listening.effects).toContainEqual({ type: 'startTimer', name: 'listen', ms: TIMINGS.awaitCommandMs })
  })

  it('treats "hey clap, what time is it" as one turn', () => {
    const { ctx, effects } = run(awake(), { type: 'WAKE', trailing: ' what time is it ', turnId: 't1' })
    expect(ctx.state).toBe('THINKING')
    expect(effects).toContainEqual({ type: 'sendUserMessage', turnId: 't1', text: 'what time is it', source: 'voice' })
  })

  it('ignores the wake phrase when not listening for it', () => {
    for (const ctx of [inTurn(), run(initialContext(), { type: 'CONNECTED' }).ctx]) {
      expect(run(ctx, { type: 'WAKE', trailing: '', turnId: 'x' }).ctx).toEqual(ctx)
    }
  })

  it('wakes from an error display, stopping the spoken error', () => {
    const failed = run(inTurn(), { type: 'TURN_ERROR', turnId: 't1', message: 'That failed.' }).ctx
    expect(recognizerMode(failed)).toBe('wake')
    const { ctx, effects } = run(failed, { type: 'WAKE', trailing: 'try again', turnId: 't2' })
    expect(ctx).toMatchObject({ state: 'THINKING', error: null, turn: { id: 't2' } })
    expect(types(effects).slice(0, 2)).toEqual(['stopSpeech', 'clearTimer'])
  })

  it('goes back to sleep after the listen window, or on "never mind"', () => {
    const listening = run(awake(), { type: 'PUSH_TO_TALK' }).ctx
    expect(run(listening, { type: 'LISTEN_TIMEOUT' }).ctx.state).toBe('LISTENING_FOR_WAKE')
    const dismissed = run(listening, { type: 'UTTERANCE', text: 'never mind', turnId: 'x' })
    expect(dismissed.ctx.state).toBe('LISTENING_FOR_WAKE')
    expect(dismissed.effects).toContainEqual({ type: 'cue', name: 'sleep' })
  })

  it('extends the listen window while the user is talking', () => {
    const listening = run(awake(), { type: 'PUSH_TO_TALK' }).ctx
    const { ctx, effects } = run(listening, { type: 'USER_SPEECH_START' })
    expect(ctx.state).toBe('LISTENING')
    expect(effects).toEqual([{ type: 'startTimer', name: 'listen', ms: TIMINGS.awaitCommandMs }])
  })
})

describe('a turn', () => {
  it('derives THINKING / EXECUTING / SPEAKING from tools and audio', () => {
    let ctx = inTurn()
    expect(ctx.state).toBe('THINKING')
    ctx = run(ctx, { type: 'TOOL_START', turnId: 't1' }).ctx
    expect(ctx.state).toBe('EXECUTING')
    // Speaking while a tool runs is SPEAKING, not stuck in EXECUTING.
    ctx = run(ctx, { type: 'SPEECH_AUDIBLE', turnId: 't1' }).ctx
    expect(ctx.state).toBe('SPEAKING')
    ctx = run(ctx, { type: 'SPEECH_SILENT', turnId: 't1' }).ctx
    expect(ctx.state).toBe('EXECUTING')
    ctx = run(ctx, { type: 'TOOL_START', turnId: 't1' }, { type: 'TOOL_END', turnId: 't1' }, { type: 'TOOL_END', turnId: 't1' }).ctx
    expect(ctx.state).toBe('THINKING')
    // More ends than starts never goes negative.
    ctx = run(ctx, { type: 'TOOL_END', turnId: 't1' }).ctx
    expect(ctx.turn?.toolsRunning).toBe(0)
  })

  it('ends only when the bridge is done AND the speech has drained', () => {
    const spoken = run(inTurn(), { type: 'SPEECH_AUDIBLE', turnId: 't1' }).ctx
    // Drained first: more text may still come.
    const early = run(spoken, { type: 'SPEECH_DRAINED', turnId: 't1' }).ctx
    expect(early.state).toBe('THINKING')

    const done = run(spoken, { type: 'TURN_COMPLETE', turnId: 't1', interrupted: false }).ctx
    expect(done.state).toBe('SPEAKING')
    const { ctx, effects } = run(done, { type: 'SPEECH_DRAINED', turnId: 't1' })
    // Voice on: a follow-up window without the wake phrase.
    expect(ctx).toMatchObject({ state: 'LISTENING', turn: null })
    expect(effects).toContainEqual({ type: 'startTimer', name: 'listen', ms: TIMINGS.followUpMs })
  })

  it('rests after a typed turn when voice is off', () => {
    const base = run(initialContext(), { type: 'CONNECTED' }).ctx
    const { ctx } = run(
      base,
      { type: 'TEXT_SUBMIT', text: ' hello ', turnId: 't1' },
      { type: 'TURN_COMPLETE', turnId: 't1', interrupted: false },
      { type: 'SPEECH_DRAINED', turnId: 't1' },
    )
    expect(ctx).toMatchObject({ state: 'IDLE', turn: null })
  })

  it('ignores events from turns it no longer owns', () => {
    const ctx = inTurn('t2')
    for (const event of [
      { type: 'TOOL_START', turnId: 't1' },
      { type: 'SPEECH_AUDIBLE', turnId: 't1' },
      { type: 'SPEECH_DRAINED', turnId: 't1' },
      { type: 'TURN_COMPLETE', turnId: 't1', interrupted: true },
      { type: 'TURN_ERROR', turnId: 't1', message: 'old' },
      { type: 'CONFIRMATION_REQUESTED', turnId: 't1', request },
    ] satisfies MachineEvent[]) {
      expect(run(ctx, event)).toEqual({ ctx, effects: [] })
    }
  })

  it('refuses empty text and anything while disconnected', () => {
    const ctx = awake()
    expect(run(ctx, { type: 'TEXT_SUBMIT', text: '   ', turnId: 'x' }).ctx).toEqual(ctx)
    const offline = run(ctx, { type: 'DISCONNECTED' }).ctx
    expect(run(offline, { type: 'TEXT_SUBMIT', text: 'hi', turnId: 'x' }).ctx.state).toBe('OFFLINE')
    expect(run(offline, { type: 'PUSH_TO_TALK' }).ctx.state).toBe('OFFLINE')
  })

  it('shows a turn error, speaks it, then rests', () => {
    const { ctx, effects } = run(inTurn(), { type: 'TURN_ERROR', turnId: 't1', message: 'The bridge failed.' })
    expect(ctx).toMatchObject({ state: 'ERROR', turn: null, error: 'The bridge failed.' })
    expect(effects).toContainEqual({ type: 'speakNotice', text: 'The bridge failed.' })
    expect(effects).toContainEqual({ type: 'startTimer', name: 'error', ms: TIMINGS.errorDisplayMs })
    expect(run(ctx, { type: 'ERROR_TIMEOUT' }).ctx).toMatchObject({ state: 'LISTENING_FOR_WAKE', error: null })
  })

  it('shows a general error beside a turn without ending it', () => {
    const { ctx } = run(inTurn(), { type: 'ERROR', message: 'Voice failed; switching.' })
    expect(ctx).toMatchObject({ state: 'THINKING', error: 'Voice failed; switching.' })
    expect(run(ctx, { type: 'ERROR_TIMEOUT' }).ctx).toMatchObject({ state: 'THINKING', error: null })
  })
})

describe('barge-in and overrides', () => {
  it('stops talking the moment the user speaks over CLAP', () => {
    const speaking = run(inTurn(), { type: 'SPEECH_AUDIBLE', turnId: 't1' }).ctx
    const { ctx, effects } = run(speaking, { type: 'USER_SPEECH_START' })
    expect(ctx).toMatchObject({ state: 'LISTENING', turn: null })
    expect(effects.slice(0, 2)).toEqual([{ type: 'stopSpeech' }, { type: 'interrupt', turnId: 't1', reason: 'barge_in' }])
    // The old turn's tail is ignored; the new question takes the floor.
    const next = run(
      ctx,
      { type: 'TURN_COMPLETE', turnId: 't1', interrupted: true },
      { type: 'UTTERANCE', text: 'actually, what about tomorrow', turnId: 't2' },
    )
    expect(next.ctx).toMatchObject({ state: 'THINKING', turn: { id: 't2' } })
  })

  it('lets speech that slipped past the detector take the floor', () => {
    const speaking = run(inTurn(), { type: 'SPEECH_AUDIBLE', turnId: 't1' }).ctx
    const { ctx, effects } = run(speaking, { type: 'UTTERANCE', text: 'and the weather', turnId: 't2' })
    expect(ctx.turn?.id).toBe('t2')
    expect(types(effects)[0]).toBe('stopSpeech')
  })

  it('"stop" quiets CLAP and keeps listening; "cancel" stands down', () => {
    const stopped = run(inTurn(), { type: 'UTTERANCE', text: 'Stop!', turnId: 'x' })
    expect(stopped.ctx.state).toBe('LISTENING')
    expect(stopped.effects).toContainEqual({ type: 'interrupt', turnId: 't1', reason: 'user_cancel' })

    const cancelled = run(inTurn(), { type: 'UTTERANCE', text: 'never mind', turnId: 'x' })
    expect(cancelled.ctx.state).toBe('LISTENING_FOR_WAKE')
    expect(cancelled.effects).toContainEqual({ type: 'interrupt', turnId: 't1', reason: 'stand_down' })

    expect(run(inTurn(), { type: 'STOP' }).ctx.state).toBe('LISTENING')
    expect(run(inTurn(), { type: 'CANCEL' }).ctx.state).toBe('LISTENING_FOR_WAKE')
    // With nothing in flight, STOP does nothing.
    expect(run(awake(), { type: 'STOP' }).effects).toEqual([])
  })

  it('push-to-talk interrupts a turn and listens', () => {
    const { ctx, effects } = run(inTurn(), { type: 'PUSH_TO_TALK' })
    expect(ctx.state).toBe('LISTENING')
    expect(effects).toContainEqual({ type: 'interrupt', turnId: 't1', reason: 'barge_in' })
    expect(effects).toContainEqual({ type: 'cue', name: 'listen' })
  })
})

describe('confirmation', () => {
  it('holds CONFIRMING while tools and speech change underneath', () => {
    const { ctx, effects } = run(inTurn(), { type: 'CONFIRMATION_REQUESTED', turnId: 't1', request })
    expect(ctx).toMatchObject({ state: 'CONFIRMING', confirmation: request })
    expect(effects).toEqual([{ type: 'cue', name: 'confirm' }, { type: 'announceConfirmation', request }])
    const held = run(ctx, { type: 'SPEECH_AUDIBLE', turnId: 't1' }, { type: 'TOOL_START', turnId: 't1' }, { type: 'SPEECH_DRAINED', turnId: 't1' })
    expect(held.ctx.state).toBe('CONFIRMING')
  })

  it('does not treat the user talking as a barge-in', () => {
    expect(run(confirming(), { type: 'USER_SPEECH_START' })).toEqual({ ctx: confirming(), effects: [] })
    expect(run(confirming(), { type: 'PUSH_TO_TALK' }).ctx.state).toBe('CONFIRMING')
  })

  it('answers by voice only with a whole yes or any no', () => {
    expect(run(confirming(), { type: 'UTTERANCE', text: 'Yes, go ahead.', turnId: 'x' }).effects).toEqual([
      { type: 'respondConfirmation', requestId: 'r1', approved: true, via: 'voice' },
    ])
    expect(run(confirming(), { type: 'UTTERANCE', text: 'no wait', turnId: 'x' }).effects).toEqual([
      { type: 'respondConfirmation', requestId: 'r1', approved: false, via: 'voice' },
    ])
    // Its own prompt coming back through the microphone is not an answer.
    const echo = run(confirming(), { type: 'UTTERANCE', text: 'Delete 3 files. Want me to?', turnId: 'x' })
    expect(echo.effects).toEqual([{ type: 'speakNotice', text: 'I need a yes or a no.' }])
  })

  it('answers by click or key, and waits for the bridge to resolve it', () => {
    const { ctx, effects } = run(confirming(), { type: 'CONFIRM_ANSWER', approved: true, via: 'key' })
    expect(effects).toEqual([{ type: 'respondConfirmation', requestId: 'r1', approved: true, via: 'key' }])
    expect(ctx.state).toBe('CONFIRMING')
    expect(run(ctx, { type: 'CONFIRMATION_RESOLVED', requestId: 'r1', approved: true }).ctx).toMatchObject({
      state: 'THINKING',
      confirmation: null,
    })
    // Answers outside a confirmation, and resolutions of other requests, do nothing.
    expect(run(awake(), { type: 'CONFIRM_ANSWER', approved: true, via: 'click' }).effects).toEqual([])
    expect(run(confirming(), { type: 'CONFIRMATION_RESOLVED', requestId: 'other', approved: true }).ctx.state).toBe('CONFIRMING')
  })

  it('clears a confirmation when the turn completes, is cancelled or disconnects', () => {
    expect(run(confirming(), { type: 'TURN_COMPLETE', turnId: 't1', interrupted: false }).ctx).toMatchObject({
      confirmation: null,
      state: 'THINKING',
    })
    expect(run(confirming(), { type: 'CANCEL' }).ctx).toMatchObject({ confirmation: null, state: 'LISTENING_FOR_WAKE' })
    expect(run(confirming(), { type: 'DISCONNECTED' }).ctx).toMatchObject({ confirmation: null, state: 'OFFLINE' })
  })
})

describe('recognizerMode', () => {
  it('maps each state to what the microphone should be doing', () => {
    expect(recognizerMode(initialContext())).toBe('off')
    expect(recognizerMode(awake())).toBe('wake')
    expect(recognizerMode(run(awake(), { type: 'WAKE', trailing: '', turnId: 'x' }).ctx)).toBe('command')
    expect(recognizerMode(run(awake(), { type: 'PUSH_TO_TALK' }).ctx)).toBe('command')
    expect(recognizerMode(inTurn())).toBe('guard')
    expect(recognizerMode(run(inTurn(), { type: 'CONFIRMATION_REQUESTED', turnId: 't1', request }).ctx)).toBe('command')
    expect(recognizerMode(run(inTurn(), { type: 'VOICE_DISABLED' }).ctx)).toBe('off')
    expect(recognizerMode(run(awake(), { type: 'ERROR', message: 'x' }).ctx)).toBe('wake')
  })

  it('never listens for commands while resting', () => {
    // Paid cloud STT only uploads in command mode, so resting must not be command.
    expect(recognizerMode(run(initialContext(), { type: 'CONNECTED' }, { type: 'VOICE_ENABLED', wakeAvailable: false }).ctx)).toBe('off')
  })
})

describe('isTurnState', () => {
  it('covers exactly the in-turn states', () => {
    expect(['THINKING', 'EXECUTING', 'SPEAKING', 'CONFIRMING'].every((s) => isTurnState(s as never))).toBe(true)
    expect(['IDLE', 'LISTENING', 'ERROR', 'OFFLINE'].some((s) => isTurnState(s as never))).toBe(false)
  })
})
