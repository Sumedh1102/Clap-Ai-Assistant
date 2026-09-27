/**
 * The CLAP voice state machine.
 *
 * A pure function: `transition(context, event)` returns the next context and a
 * list of effects. It never touches audio, sockets or timers — the controller
 * (src/app/controller.ts) performs the effects. That keeps every rule here
 * deterministic and covered by unit tests, and keeps conversation logic out of
 * React components.
 *
 * Within a turn the visible state is *derived*: speech playing → SPEAKING,
 * otherwise a tool running → EXECUTING, otherwise THINKING. Deriving it from
 * `audible` and `toolsRunning` (rather than setting it from whichever event came
 * last) is what stops a turn getting stuck in EXECUTING while it talks.
 *
 * A turn ends only when the bridge has finished (`TURN_COMPLETE`) AND the
 * speech queue has drained (`SPEECH_DRAINED`). Then CLAP keeps listening for a
 * short follow-up window before going back to waiting for the wake phrase.
 */

import type { RiskLevel } from '../../shared/risk'
import { overrideIntent, parseConfirmation } from './intents'

export type AssistantState =
  | 'OFFLINE'
  | 'IDLE'
  | 'LISTENING_FOR_WAKE'
  | 'WAKE_DETECTED'
  | 'LISTENING'
  | 'THINKING'
  | 'EXECUTING'
  | 'SPEAKING'
  | 'CONFIRMING'
  | 'ERROR'

/** What the voice input should be doing in each state. */
export type RecognizerMode = 'off' | 'wake' | 'command' | 'guard'

export type TurnContext = {
  id: string
  toolsRunning: number
  audible: boolean
  streamDone: boolean
}

export type PendingConfirmation = {
  requestId: string
  label: string
  summary: string
  risk: RiskLevel
  expiresAt: number
}

export type MachineContext = {
  state: AssistantState
  connected: boolean
  voiceEnabled: boolean
  /** A wake engine is running; otherwise the resting state is push-to-talk IDLE. */
  wakeAvailable: boolean
  turn: TurnContext | null
  confirmation: PendingConfirmation | null
  error: string | null
}

export type ConfirmVia = 'voice' | 'click' | 'key'
export type CueName = 'wake' | 'listen' | 'sleep' | 'confirm' | 'error'
export type TimerName = 'wakeSettle' | 'listen' | 'error'

export type MachineEvent =
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'VOICE_ENABLED'; wakeAvailable: boolean }
  | { type: 'VOICE_DISABLED' }
  | { type: 'WAKE'; trailing: string; turnId: string }
  | { type: 'WAKE_SETTLED' }
  | { type: 'PUSH_TO_TALK' }
  | { type: 'USER_SPEECH_START' }
  | { type: 'UTTERANCE'; text: string; turnId: string }
  | { type: 'TEXT_SUBMIT'; text: string; turnId: string }
  | { type: 'CONFIRM_ANSWER'; approved: boolean; via: ConfirmVia }
  | { type: 'LISTEN_TIMEOUT' }
  | { type: 'STOP' }
  | { type: 'CANCEL' }
  | { type: 'TOOL_START'; turnId: string }
  | { type: 'TOOL_END'; turnId: string }
  | { type: 'SPEECH_AUDIBLE'; turnId: string }
  | { type: 'SPEECH_SILENT'; turnId: string }
  | { type: 'SPEECH_DRAINED'; turnId: string }
  | { type: 'TURN_COMPLETE'; turnId: string; interrupted: boolean }
  | { type: 'TURN_ERROR'; turnId: string; message: string }
  | { type: 'CONFIRMATION_REQUESTED'; turnId: string; request: PendingConfirmation }
  | { type: 'CONFIRMATION_RESOLVED'; requestId: string; approved: boolean }
  | { type: 'ERROR'; message: string }
  | { type: 'ERROR_TIMEOUT' }

export type Effect =
  | { type: 'sendUserMessage'; turnId: string; text: string; source: 'voice' | 'text' }
  | { type: 'interrupt'; turnId: string; reason: 'barge_in' | 'user_cancel' | 'stand_down' }
  | { type: 'stopSpeech' }
  | { type: 'respondConfirmation'; requestId: string; approved: boolean; via: ConfirmVia }
  | { type: 'announceConfirmation'; request: PendingConfirmation }
  | { type: 'speakNotice'; text: string }
  | { type: 'cue'; name: CueName }
  | { type: 'wakeDetected' }
  | { type: 'startTimer'; name: TimerName; ms: number }
  | { type: 'clearTimer'; name: TimerName }

export const TIMINGS = {
  /** The activation animation plays before listening starts. */
  wakeSettleMs: 600,
  /** After the wake phrase or push-to-talk, how long to wait for a command. */
  awaitCommandMs: 9_000,
  /** After an answer, how long CLAP keeps listening without the wake phrase. */
  followUpMs: 7_000,
  errorDisplayMs: 3_500,
} as const

export type Transition = { context: MachineContext; effects: Effect[] }

export function initialContext(): MachineContext {
  return {
    state: 'OFFLINE',
    connected: false,
    voiceEnabled: false,
    wakeAvailable: false,
    turn: null,
    confirmation: null,
    error: null,
  }
}

/** Where CLAP settles when nothing is happening. */
export function restingState(ctx: Pick<MachineContext, 'connected' | 'voiceEnabled' | 'wakeAvailable'>): AssistantState {
  if (!ctx.connected) return 'OFFLINE'
  if (ctx.voiceEnabled && ctx.wakeAvailable) return 'LISTENING_FOR_WAKE'
  return 'IDLE'
}

function turnState(turn: TurnContext): AssistantState {
  if (turn.audible) return 'SPEAKING'
  if (turn.toolsRunning > 0) return 'EXECUTING'
  return 'THINKING'
}

export function recognizerMode(ctx: MachineContext): RecognizerMode {
  if (!ctx.voiceEnabled || !ctx.connected) return 'off'
  switch (ctx.state) {
    case 'LISTENING_FOR_WAKE':
      return 'wake'
    case 'WAKE_DETECTED':
    case 'LISTENING':
    case 'CONFIRMING':
      return 'command'
    case 'THINKING':
    case 'EXECUTING':
    case 'SPEAKING':
      return 'guard'
    case 'ERROR':
      return ctx.turn ? 'guard' : ctx.wakeAvailable ? 'wake' : 'off'
    default:
      return 'off'
  }
}

export const isTurnState = (state: AssistantState) =>
  state === 'THINKING' || state === 'EXECUTING' || state === 'SPEAKING' || state === 'CONFIRMING'

// ---------------------------------------------------------------------------

const same = (ctx: MachineContext): Transition => ({ context: ctx, effects: [] })

/** Leave any turn and go back to listening for a command. */
function listen(ctx: MachineContext, effects: Effect[], ms: number): Transition {
  return {
    context: { ...ctx, state: 'LISTENING', turn: null, confirmation: null, error: null },
    effects: [...effects, { type: 'clearTimer', name: 'error' }, { type: 'startTimer', name: 'listen', ms }],
  }
}

function rest(ctx: MachineContext, effects: Effect[] = []): Transition {
  const next = { ...ctx, turn: null, confirmation: null }
  return {
    context: { ...next, state: restingState(next) },
    effects: [...effects, { type: 'clearTimer', name: 'listen' }, { type: 'clearTimer', name: 'wakeSettle' }],
  }
}

/** Stop the current turn, locally and on the bridge. */
function abandonTurn(ctx: MachineContext, reason: 'barge_in' | 'user_cancel' | 'stand_down'): Effect[] {
  if (!ctx.turn) return []
  return [{ type: 'stopSpeech' }, { type: 'interrupt', turnId: ctx.turn.id, reason }]
}

function startTurn(ctx: MachineContext, turnId: string, text: string, source: 'voice' | 'text'): Transition {
  // A new message supersedes the old turn on the bridge by itself; locally the
  // old speech must stop at once.
  const effects: Effect[] = ctx.turn ? [{ type: 'stopSpeech' }] : []
  effects.push(
    { type: 'clearTimer', name: 'listen' },
    { type: 'clearTimer', name: 'wakeSettle' },
    { type: 'clearTimer', name: 'error' },
    { type: 'sendUserMessage', turnId, text, source },
  )
  return {
    context: {
      ...ctx,
      state: 'THINKING',
      turn: { id: turnId, toolsRunning: 0, audible: false, streamDone: false },
      confirmation: null,
      error: null,
    },
    effects,
  }
}

/** Re-derive the state for the current turn, unless a confirmation holds it. */
function withTurn(ctx: MachineContext, turn: TurnContext): MachineContext {
  if (ctx.state === 'CONFIRMING' || ctx.state === 'ERROR') return { ...ctx, turn }
  return { ...ctx, turn, state: turnState(turn) }
}

const ownsTurn = (ctx: MachineContext, turnId: string) => ctx.turn !== null && ctx.turn.id === turnId

export function transition(ctx: MachineContext, event: MachineEvent): Transition {
  switch (event.type) {
    case 'CONNECTED': {
      const next = { ...ctx, connected: true }
      return next.state === 'OFFLINE' ? rest(next) : same(next)
    }

    case 'DISCONNECTED': {
      // The turn cannot finish without the bridge; its speech stops with it.
      const effects: Effect[] = ctx.turn ? [{ type: 'stopSpeech' }] : []
      return rest({ ...ctx, connected: false, error: null }, [...effects, { type: 'clearTimer', name: 'error' }])
    }

    case 'VOICE_ENABLED': {
      // Also sent after an engine fallback, when wake availability may have
      // changed: re-derive the resting state if CLAP is resting.
      const next = { ...ctx, voiceEnabled: true, wakeAvailable: event.wakeAvailable }
      return next.state === 'IDLE' || next.state === 'LISTENING_FOR_WAKE' ? rest(next) : same(next)
    }

    case 'VOICE_DISABLED': {
      const next = { ...ctx, voiceEnabled: false }
      if (ctx.state === 'LISTENING_FOR_WAKE' || ctx.state === 'WAKE_DETECTED' || ctx.state === 'LISTENING') return rest(next)
      return same(next)
    }

    case 'WAKE': {
      if (ctx.state !== 'LISTENING_FOR_WAKE' || !ctx.connected) return same(ctx)
      const heard: Effect[] = [{ type: 'cue', name: 'wake' }, { type: 'wakeDetected' }]
      // "Hey CLAP, what's the time" is one breath, not two turns.
      if (event.trailing.trim()) {
        const started = startTurn(ctx, event.turnId, event.trailing.trim(), 'voice')
        return { context: started.context, effects: [...heard, ...started.effects] }
      }
      return {
        context: { ...ctx, state: 'WAKE_DETECTED', error: null },
        effects: [...heard, { type: 'startTimer', name: 'wakeSettle', ms: TIMINGS.wakeSettleMs }],
      }
    }

    case 'WAKE_SETTLED':
      return ctx.state === 'WAKE_DETECTED' ? listen(ctx, [], TIMINGS.awaitCommandMs) : same(ctx)

    case 'PUSH_TO_TALK': {
      if (!ctx.connected || ctx.state === 'CONFIRMING') return same(ctx)
      return listen(ctx, [...abandonTurn(ctx, 'barge_in'), { type: 'cue', name: 'listen' }], TIMINGS.awaitCommandMs)
    }

    case 'USER_SPEECH_START': {
      if (ctx.state === 'LISTENING' || ctx.state === 'WAKE_DETECTED') {
        // They're talking: give the utterance time to arrive.
        return { context: ctx, effects: [{ type: 'startTimer', name: 'listen', ms: TIMINGS.awaitCommandMs }] }
      }
      if (ctx.turn && (ctx.state === 'THINKING' || ctx.state === 'EXECUTING' || ctx.state === 'SPEAKING')) {
        // Barge-in: stop talking now, don't wait for the words.
        return listen(ctx, abandonTurn(ctx, 'barge_in'), TIMINGS.awaitCommandMs)
      }
      return same(ctx)
    }

    case 'UTTERANCE': {
      const text = event.text.trim()
      if (!text || !ctx.connected) return same(ctx)

      if (ctx.state === 'CONFIRMING' && ctx.confirmation) {
        const answer = parseConfirmation(text)
        if (!answer) return { context: ctx, effects: [{ type: 'speakNotice', text: 'I need a yes or a no.' }] }
        return {
          context: ctx,
          effects: [{ type: 'respondConfirmation', requestId: ctx.confirmation.requestId, approved: answer === 'yes', via: 'voice' }],
        }
      }

      // "Stop" and "never mind" are for CLAP, not for the model.
      const override = overrideIntent(text)
      if (override) {
        if (ctx.turn && override === 'stop') return listen(ctx, abandonTurn(ctx, 'user_cancel'), TIMINGS.awaitCommandMs)
        if (ctx.turn) return rest(ctx, abandonTurn(ctx, 'stand_down'))
        if (ctx.state === 'LISTENING' || ctx.state === 'WAKE_DETECTED') return rest(ctx, [{ type: 'cue', name: 'sleep' }])
        return same(ctx)
      }

      if (ctx.state === 'LISTENING' || ctx.state === 'WAKE_DETECTED') return startTurn(ctx, event.turnId, text, 'voice')
      if (ctx.turn && (ctx.state === 'THINKING' || ctx.state === 'EXECUTING' || ctx.state === 'SPEAKING')) {
        // Speech that got past the barge-in detector still takes the floor.
        return startTurn(ctx, event.turnId, text, 'voice')
      }
      return same(ctx)
    }

    case 'TEXT_SUBMIT': {
      const text = event.text.trim()
      if (!text || !ctx.connected) return same(ctx)
      return startTurn(ctx, event.turnId, text, 'text')
    }

    case 'CONFIRM_ANSWER': {
      if (ctx.state !== 'CONFIRMING' || !ctx.confirmation) return same(ctx)
      return {
        context: ctx,
        effects: [
          { type: 'respondConfirmation', requestId: ctx.confirmation.requestId, approved: event.approved, via: event.via },
        ],
      }
    }

    case 'LISTEN_TIMEOUT':
      if (ctx.state !== 'LISTENING' && ctx.state !== 'WAKE_DETECTED') return same(ctx)
      return rest(ctx, [{ type: 'cue', name: 'sleep' }])

    case 'STOP': {
      // "Stop" — quiet now, but keep listening: they probably want to say something.
      if (!ctx.turn) return same(ctx)
      return listen(ctx, abandonTurn(ctx, 'user_cancel'), TIMINGS.awaitCommandMs)
    }

    case 'CANCEL':
      // Stand down completely.
      return rest({ ...ctx, error: null }, [...abandonTurn(ctx, 'stand_down'), { type: 'clearTimer', name: 'error' }])

    case 'TOOL_START': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      const turn = { ...ctx.turn!, toolsRunning: ctx.turn!.toolsRunning + 1 }
      return same(withTurn(ctx, turn))
    }

    case 'TOOL_END': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      const turn = { ...ctx.turn!, toolsRunning: Math.max(0, ctx.turn!.toolsRunning - 1) }
      return same(withTurn(ctx, turn))
    }

    case 'SPEECH_AUDIBLE': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      return same(withTurn(ctx, { ...ctx.turn!, audible: true }))
    }

    case 'SPEECH_SILENT': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      return same(withTurn(ctx, { ...ctx.turn!, audible: false }))
    }

    case 'SPEECH_DRAINED': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      const turn = { ...ctx.turn!, audible: false }
      if (!turn.streamDone || ctx.state === 'CONFIRMING') return same(withTurn(ctx, turn))
      // Done: keep listening for a follow-up if the voice is on.
      if (ctx.voiceEnabled) return listen(ctx, [], TIMINGS.followUpMs)
      return rest(ctx)
    }

    case 'TURN_COMPLETE': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      // Not finished until the speech queue drains (the controller reports it).
      // No tool can still be running and no confirmation can still be pending.
      const turn = { ...ctx.turn!, streamDone: true, toolsRunning: 0 }
      return same({ ...ctx, turn, confirmation: null, state: ctx.state === 'ERROR' ? 'ERROR' : turnState(turn) })
    }

    case 'TURN_ERROR': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      return {
        context: { ...ctx, state: 'ERROR', turn: null, confirmation: null, error: event.message },
        effects: [
          { type: 'stopSpeech' },
          { type: 'cue', name: 'error' },
          { type: 'speakNotice', text: event.message },
          { type: 'clearTimer', name: 'listen' },
          { type: 'startTimer', name: 'error', ms: TIMINGS.errorDisplayMs },
        ],
      }
    }

    case 'CONFIRMATION_REQUESTED': {
      if (!ownsTurn(ctx, event.turnId)) return same(ctx)
      return {
        context: { ...ctx, state: 'CONFIRMING', confirmation: event.request },
        effects: [{ type: 'cue', name: 'confirm' }, { type: 'announceConfirmation', request: event.request }],
      }
    }

    case 'CONFIRMATION_RESOLVED': {
      if (!ctx.confirmation || ctx.confirmation.requestId !== event.requestId) return same(ctx)
      const next = { ...ctx, confirmation: null }
      if (!next.turn) return rest(next)
      return same({ ...next, state: turnState(next.turn) })
    }

    case 'ERROR': {
      // A turn in flight keeps going; the message is shown alongside it.
      if (ctx.turn) return { context: { ...ctx, error: event.message }, effects: [{ type: 'startTimer', name: 'error', ms: TIMINGS.errorDisplayMs }] }
      return {
        context: { ...ctx, state: 'ERROR', error: event.message },
        effects: [
          { type: 'cue', name: 'error' },
          { type: 'clearTimer', name: 'listen' },
          { type: 'startTimer', name: 'error', ms: TIMINGS.errorDisplayMs },
        ],
      }
    }

    case 'ERROR_TIMEOUT': {
      if (ctx.state !== 'ERROR') return same({ ...ctx, error: null })
      if (ctx.turn) return same({ ...ctx, error: null, state: turnState(ctx.turn) })
      return rest({ ...ctx, error: null })
    }
  }
}
