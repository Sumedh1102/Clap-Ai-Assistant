/**
 * The CLAP controller — the only place effects happen.
 *
 * Bridge events and voice events become state-machine events; the machine
 * returns effects; this class performs them (send a message, stop speech,
 * play a cue, start a timer) and publishes render state to the store.
 * React components call the public actions and read the store; they hold no
 * conversation logic of their own.
 */

import type { BridgeEvent } from '../../shared/protocol'
import { playCue } from '../audio/cues'
import { MicError, Microphone } from '../audio/mic'
import { audioOutput } from '../audio/output'
import { BridgeClient, type ConnectionStatus } from '../lib/bridge-client'
import { sanitizeForDisplay } from '../lib/text'
import { hud } from '../state/store'
import {
  describeEngines,
  detectBrowserCapabilities,
  selectEngines,
  type BrowserCapabilities,
  type EngineSelection,
} from '../voice/capabilities'
import { EchoWindow } from '../voice/echo'
import { degrade, VoiceInput, type EngineFailure } from '../voice/input'
import { confirmationPrompt } from '../voice/intents'
import {
  initialContext,
  recognizerMode,
  transition,
  type ConfirmVia,
  type Effect,
  type MachineContext,
  type MachineEvent,
  type TimerName,
} from '../voice/machine'
import { BridgeVoiceProvider } from '../voice/tts/bridge'
import { BrowserVoiceProvider } from '../voice/tts/browser'
import { FallbackVoiceProvider } from '../voice/tts/fallback'
import { Speaker } from '../voice/tts/speaker'
import type { VoiceProvider } from '../voice/tts/types'
import { BRIDGE_HTTP_URL, BRIDGE_WS_URL, DEBUG, ENGINE_PREFERENCES, FALLBACK_WAKE_PHRASE, LANGUAGE } from './config'

const TIMER_EVENTS: Record<TimerName, MachineEvent> = {
  wakeSettle: { type: 'WAKE_SETTLED' },
  listen: { type: 'LISTEN_TIMEOUT' },
  error: { type: 'ERROR_TIMEOUT' },
}

export const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

export class ClapController {
  private ctx: MachineContext = initialContext()
  private readonly bridge: BridgeClient
  private readonly mic = new Microphone()
  private readonly echo = new EchoWindow()
  private readonly timers = new Map<TimerName, ReturnType<typeof setTimeout>>()
  private voice: VoiceInput | null = null
  private output: FallbackVoiceProvider | null = null
  private browserVoice: BrowserVoiceProvider | null = null
  private speaker: Speaker | null = null
  private speakerTurn: string | null = null
  private sentenceStartedAt = 0
  private browserCaps: BrowserCapabilities | null = null
  private everHadSession = false
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor() {
    this.bridge = new BridgeClient({
      url: BRIDGE_WS_URL,
      debug: DEBUG,
      onEvent: (event) => this.onBridgeEvent(event),
      onStatus: (status, detail) => this.onBridgeStatus(status, detail),
      onLatency: (ms) => hud.set({ latencyMs: ms }),
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.bridge.connect()
    this.publish()
  }

  dispose(): void {
    this.bridge.close()
    this.voice?.stop()
    this.mic.close()
    this.stopSpeech()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.started = false
  }

  // ---------------------------------------------------------------------------
  // Actions (called by the UI)
  // ---------------------------------------------------------------------------

  /** Unlock audio output; call from any user gesture. */
  unlockAudio(): void {
    void audioOutput.unlock().catch(() => {})
  }

  /** Microphone + speech engines + voice output. Must start from a user gesture. */
  async activateVoice(): Promise<void> {
    const voice = hud.get().voice
    if (this.ctx.voiceEnabled || voice.activating) return
    hud.set({ voice: { ...voice, activating: true } })
    try {
      await audioOutput.unlock()
      this.browserCaps = await detectBrowserCapabilities(LANGUAGE)
      const selection = selectEngines(this.browserCaps, hud.get().session.capabilities, ENGINE_PREFERENCES)
      this.ensureOutput(selection)

      if (selection.stt === 'none') {
        this.publishEngines(selection)
        this.notify(selection.notes[0] ?? 'Voice input is not available in this browser. You can type to CLAP.')
        return
      }

      await this.mic.open(() => this.onMicLost())
      this.voice = new VoiceInput({
        mic: this.mic,
        selection,
        bridgeUrl: BRIDGE_HTTP_URL,
        lang: LANGUAGE,
        wakePhrase: hud.get().session.wakePhrase || FALLBACK_WAKE_PHRASE,
        echo: this.echo,
        speakingSince: () => (this.output?.isSpeaking() ? this.sentenceStartedAt : 0),
        handlers: {
          onWake: (trailing) => this.dispatch({ type: 'WAKE', trailing, turnId: newId() }),
          onSpeechStart: () => {
            this.bridge.send({ type: 'speech_start', at: Date.now() })
            this.dispatch({ type: 'USER_SPEECH_START' })
          },
          onSpeechEnd: (durationMs) => this.bridge.send({ type: 'speech_stop', at: Date.now(), durationMs }),
          onPartial: (text) => {
            const state = this.ctx.state
            if (state === 'LISTENING' || state === 'WAKE_DETECTED' || state === 'CONFIRMING') {
              hud.set({ caption: sanitizeForDisplay(text, 400) })
            }
          },
          onUtterance: (text) => {
            hud.set({ caption: '' })
            this.dispatch({ type: 'UTTERANCE', text, turnId: newId() })
          },
          onNotice: (message) => this.notify(message),
          onEngineFailure: (failure, message) => this.onEngineFailure(failure, message),
        },
      })
      this.voice.start()
      this.publishEngines(selection)
      this.dispatch({ type: 'VOICE_ENABLED', wakeAvailable: selection.wake !== 'push-to-talk' })
      playCue('wake')
      if (selection.wake === 'push-to-talk') this.notify('Press Space to talk.')
    } catch (error) {
      const message = error instanceof MicError ? error.message : 'Voice could not start. You can still type to CLAP.'
      if (DEBUG) console.error('[clap] voice activation failed', error)
      this.voice?.stop()
      this.voice = null
      this.mic.close()
      this.dispatch({ type: 'ERROR', message })
    } finally {
      hud.set({ voice: { ...hud.get().voice, activating: false } })
    }
  }

  /** Mute/unmute the microphone (speech output keeps working). */
  toggleMicrophone(): void {
    if (this.ctx.voiceEnabled) {
      this.voice?.stop()
      this.voice = null
      this.mic.close()
      this.dispatch({ type: 'VOICE_DISABLED' })
      hud.set({ voice: { ...hud.get().voice, enabled: false } })
      this.notify('Microphone off.')
    } else {
      void this.activateVoice()
    }
  }

  pushToTalk(): void {
    this.unlockAudio()
    if (!this.ctx.voiceEnabled) {
      void this.activateVoice().then(() => {
        if (this.ctx.voiceEnabled) this.dispatch({ type: 'PUSH_TO_TALK' })
      })
      return
    }
    this.dispatch({ type: 'PUSH_TO_TALK' })
  }

  cancel(): void {
    this.dispatch({ type: 'CANCEL' })
  }

  submitText(text: string): void {
    this.unlockAudio()
    this.dispatch({ type: 'TEXT_SUBMIT', text, turnId: newId() })
  }

  answerConfirmation(approved: boolean, via: ConfirmVia): void {
    this.dispatch({ type: 'CONFIRM_ANSWER', approved, via })
  }

  cycleBrowserVoice(): string | null {
    const name = this.browserVoice?.cycleVoice() ?? null
    if (name) this.notify(`Browser voice: ${name}`)
    return name
  }

  // ---------------------------------------------------------------------------
  // Live levels for the 3D scene (read every frame, never stored in React)
  // ---------------------------------------------------------------------------

  micLevel(): number {
    return this.ctx.voiceEnabled ? this.mic.level() : 0
  }

  outputLevel(): number {
    return this.output?.level() ?? 0
  }

  diagnostics() {
    return {
      machine: this.ctx,
      mode: recognizerMode(this.ctx),
      vad: this.voice?.meter() ?? null,
      browser: this.browserCaps,
      engines: this.voice?.engines ?? null,
      outputProvider: this.output?.id ?? 'none',
      audioUnlocked: audioOutput.unlocked,
    }
  }

  // ---------------------------------------------------------------------------
  // The machine
  // ---------------------------------------------------------------------------

  private dispatch(event: MachineEvent): void {
    const before = recognizerMode(this.ctx)
    const { context, effects } = transition(this.ctx, event)
    this.ctx = context
    if (DEBUG && event.type !== 'SPEECH_SILENT') console.info('[clap] event', event.type, '→', context.state)
    for (const effect of effects) this.run(effect)
    const after = recognizerMode(this.ctx)
    if (after !== before) this.voice?.setMode(after)
    this.publish()
  }

  private run(effect: Effect): void {
    switch (effect.type) {
      case 'sendUserMessage':
        this.stopSpeech()
        hud.addUserTurn(effect.turnId, sanitizeForDisplay(effect.text), effect.source)
        if (!this.bridge.send({ type: 'user_message', turnId: effect.turnId, text: effect.text, source: effect.source })) {
          this.notify('Not connected to the bridge.')
        }
        if (this.output && audioOutput.unlocked) this.startSpeaker(effect.turnId)
        return
      case 'interrupt':
        this.bridge.send({ type: 'interrupt', turnId: effect.turnId, reason: effect.reason })
        hud.finishClap(effect.turnId, { interrupted: true })
        return
      case 'stopSpeech':
        this.stopSpeech()
        return
      case 'respondConfirmation':
        this.bridge.send({ type: 'confirmation_response', requestId: effect.requestId, approved: effect.approved, via: effect.via })
        return
      case 'announceConfirmation':
        this.say(confirmationPrompt(effect.request.summary))
        return
      case 'speakNotice':
        this.say(effect.text)
        return
      case 'cue':
        playCue(effect.name)
        return
      case 'wakeDetected':
        this.bridge.send({ type: 'wake_detected', engine: this.voice?.engines.wake ?? 'unknown', at: Date.now() })
        return
      case 'startTimer': {
        const existing = this.timers.get(effect.name)
        if (existing) clearTimeout(existing)
        const event = TIMER_EVENTS[effect.name]
        this.timers.set(
          effect.name,
          setTimeout(() => {
            this.timers.delete(effect.name)
            this.dispatch(event)
          }, effect.ms),
        )
        return
      }
      case 'clearTimer': {
        const timer = this.timers.get(effect.name)
        if (timer) clearTimeout(timer)
        this.timers.delete(effect.name)
        return
      }
    }
  }

  private publish(): void {
    hud.set({
      assistant: this.ctx.state,
      confirmation: this.ctx.confirmation,
      error: this.ctx.error,
      voice: { ...hud.get().voice, enabled: this.ctx.voiceEnabled },
    })
  }

  // ---------------------------------------------------------------------------
  // Speech output
  // ---------------------------------------------------------------------------

  private ensureOutput(selection: EngineSelection): void {
    if (this.output) return
    const chain: VoiceProvider[] = []
    const caps = hud.get().session.capabilities
    if (selection.tts.includes('bridge-cloud')) chain.push(new BridgeVoiceProvider(BRIDGE_HTTP_URL, Boolean(caps?.tts.customVoice)))
    if (selection.tts.includes('browser') && BrowserVoiceProvider.supported()) {
      this.browserVoice = new BrowserVoiceProvider(LANGUAGE)
      chain.push(this.browserVoice)
    }
    if (!chain.length) return
    this.output = new FallbackVoiceProvider(chain, (from, to) => {
      this.notify(to ? `Voice ${from} failed; switching to ${to}.` : 'No voice is working; answers are text only.')
    })
  }

  private startSpeaker(turnId: string): void {
    const output = this.output
    if (!output) return
    let announced = false
    this.speakerTurn = turnId
    this.speaker = new Speaker(
      output,
      {
        onAudible: () => {
          this.sentenceStartedAt = performance.now()
          if (!announced) {
            announced = true
            this.bridge.send({ type: 'assistant_speech_start', turnId, provider: output.id })
          }
          this.dispatch({ type: 'SPEECH_AUDIBLE', turnId })
        },
        onSilent: () => this.dispatch({ type: 'SPEECH_SILENT', turnId }),
        onError: (error) => {
          if (DEBUG) console.warn('[clap] speech failed', error)
        },
      },
      this.echo,
    )
  }

  /** The bridge finished; wait for the queue to empty, then tell the machine. */
  private drainSpeech(turnId: string): void {
    const speaker = this.speakerTurn === turnId ? this.speaker : null
    if (!speaker) {
      this.dispatch({ type: 'SPEECH_DRAINED', turnId })
      return
    }
    void speaker.end().then(() => {
      if (this.speaker !== speaker) return
      if (speaker.hasSpoken) this.bridge.send({ type: 'assistant_speech_end', turnId, interrupted: speaker.isCancelled })
      this.dispatch({ type: 'SPEECH_DRAINED', turnId })
    })
  }

  private stopSpeech(): void {
    if (this.speaker) {
      if (this.speaker.hasSpoken && this.speakerTurn) {
        this.bridge.send({ type: 'assistant_speech_end', turnId: this.speakerTurn, interrupted: true })
      }
      this.speaker.cancel()
    }
    this.speaker = null
    this.speakerTurn = null
    this.output?.stop(80)
  }

  /** Speak outside the normal answer stream (confirmation prompts, notices). */
  private say(text: string): void {
    if (!this.output || !audioOutput.unlocked) return
    if (this.speaker && !this.speaker.isCancelled) {
      this.speaker.say(text)
      return
    }
    const speaker = new Speaker(this.output, {}, this.echo)
    speaker.say(text)
    void speaker.end()
  }

  // ---------------------------------------------------------------------------
  // Bridge
  // ---------------------------------------------------------------------------

  private onBridgeStatus(status: ConnectionStatus, detail?: string): void {
    if (status === 'open') {
      hud.set({ connection: 'online', connectionDetail: '' })
      return
    }
    if (status === 'closed') {
      hud.set({ connection: 'offline', connectionDetail: detail ?? '' })
      if (this.ctx.connected) this.dispatch({ type: 'DISCONNECTED' })
      return
    }
    hud.set({ connection: this.ctx.connected ? 'online' : 'connecting' })
  }

  private onBridgeEvent(event: BridgeEvent): void {
    const current = this.ctx.turn?.id
    switch (event.type) {
      case 'session_ready': {
        if (this.everHadSession && !event.resumed) this.notify('Reconnected with a fresh session; earlier context was reset.')
        this.everHadSession = true
        hud.set({
          session: {
            id: event.sessionId,
            model: event.model,
            wakePhrase: event.wakePhrase,
            tools: event.tools,
            capabilities: event.capabilities,
            resumed: event.resumed,
          },
        })
        this.voice?.setWakePhrase(event.wakePhrase)
        this.dispatch({ type: 'CONNECTED' })
        return
      }
      case 'state_change':
        hud.set({ activity: event.activity })
        return
      case 'assistant_text':
        if (event.turnId !== current) return
        hud.appendClap(event.turnId, sanitizeForDisplay(event.delta))
        this.speaker?.push(event.delta)
        return
      case 'turn_complete':
        if (event.turnId !== current) return
        hud.finishClap(event.turnId, {
          interrupted: event.interrupted,
          ...(event.text ? { text: sanitizeForDisplay(event.text, 200_000) } : {}),
        })
        this.dispatch({ type: 'TURN_COMPLETE', turnId: event.turnId, interrupted: event.interrupted })
        this.drainSpeech(event.turnId)
        return
      case 'tool_start':
        if (event.turnId !== current) return
        hud.toolStarted({ toolUseId: event.toolUseId, name: event.name, label: event.label, summary: event.summary, risk: event.risk })
        this.dispatch({ type: 'TOOL_START', turnId: event.turnId })
        return
      case 'tool_result':
        if (event.turnId !== current) return
        hud.toolFinished(event.toolUseId, { status: 'done', durationMs: event.durationMs })
        this.dispatch({ type: 'TOOL_END', turnId: event.turnId })
        return
      case 'tool_error':
        if (event.turnId !== current) return
        hud.toolFinished(
          event.toolUseId,
          { status: event.denied ? 'denied' : 'failed', detail: event.error, durationMs: event.durationMs },
          { toolUseId: event.toolUseId, name: event.name, label: event.name, summary: event.error, risk: 'low' },
        )
        // A denied call never started, so it never counted as running.
        if (!event.denied) this.dispatch({ type: 'TOOL_END', turnId: event.turnId })
        return
      case 'confirmation_request':
        this.dispatch({
          type: 'CONFIRMATION_REQUESTED',
          turnId: event.turnId,
          request: { requestId: event.requestId, label: event.label, summary: event.summary, risk: event.risk, expiresAt: event.expiresAt },
        })
        return
      case 'confirmation_resolved':
        this.dispatch({ type: 'CONFIRMATION_RESOLVED', requestId: event.requestId, approved: event.approved })
        if (event.reason === 'timeout') this.notify('No answer, so I left it.')
        return
      case 'memory_update':
        return // Phase 5
      case 'error':
        if (event.turnId) {
          if (event.turnId !== current) return
          hud.finishClap(event.turnId, { error: event.message })
          this.dispatch({ type: 'TURN_ERROR', turnId: event.turnId, message: event.message })
          return
        }
        if (event.recoverable) this.notify(event.message)
        else this.dispatch({ type: 'ERROR', message: event.message })
        return
      case 'pong':
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Voice plumbing
  // ---------------------------------------------------------------------------

  private publishEngines(selection: EngineSelection): void {
    const names = describeEngines(selection)
    hud.set({ voice: { ...hud.get().voice, ...names, notes: selection.notes } })
  }

  private onEngineFailure(failure: EngineFailure, message: string): void {
    if (!this.voice) return
    this.notify(message)
    const next = degrade(this.voice.engines, failure, {
      allowCloudWake: ENGINE_PREFERENCES.allowCloudWake,
      cloudStt: Boolean(hud.get().session.capabilities?.stt.cloud) && Boolean(this.browserCaps?.mediaRecorder),
      webSpeech: Boolean(this.browserCaps?.webSpeech),
    })
    this.voice.reconfigure(next)
    this.voice.setMode(recognizerMode(this.ctx))
    this.publishEngines(next)
    this.dispatch({ type: 'VOICE_ENABLED', wakeAvailable: next.wake !== 'push-to-talk' })
  }

  private onMicLost(): void {
    this.voice?.stop()
    this.voice = null
    this.mic.close()
    this.dispatch({ type: 'VOICE_DISABLED' })
    this.dispatch({ type: 'ERROR', message: 'The microphone disconnected. Activate voice again when it is back.' })
  }

  private notify(message: string): void {
    hud.set({ notice: message })
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => hud.set({ notice: null }), 5_000)
  }
}
