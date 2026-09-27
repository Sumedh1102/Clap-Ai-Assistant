/**
 * Everything that listens, behind one object.
 *
 * Owns the per-frame VAD, the browser recogniser (when wake or STT uses it),
 * the cloud STT provider and its segment recorder, wake-phrase matching,
 * endpointing and the echo filter. The controller sets a mode (from the state
 * machine) and receives plain events: wake, speech start/end, partial text,
 * utterance.
 *
 * Mode rules:
 *   off     — nothing is recognised.
 *   wake    — only the wake phrase matters. Nothing is sent to a paid service.
 *   command — everything heard is a command.
 *   guard   — CLAP is thinking or speaking; speech is a barge-in, echo is not.
 *
 * Cloud STT segments are judged when they END: a segment that began as
 * room noise or as a barge-in is uploaded only if CLAP is in command mode by
 * then. Idle audio never leaves the machine.
 */

import type { Microphone } from '../audio/mic'
import type { EngineSelection } from './capabilities'
import { isLikelyEcho, type EchoWindow } from './echo'
import { UtteranceAssembler } from './endpointing'
import type { RecognizerMode } from './machine'
import { BridgeSpeechProvider, SegmentRecorder } from './stt/bridge'
import type { SpeechProvider } from './stt/types'
import { WebSpeechProvider, WebSpeechRecognizer } from './stt/webspeech'
import { VadDetector } from './vad'
import { createWakeMatcher, stripLeadingWake, type WakeMatch } from './wake'

export type EngineFailure = 'local-recognition' | 'browser-recognition' | 'cloud-stt'

export type VoiceInputHandlers = {
  onWake: (trailing: string) => void
  onSpeechStart: () => void
  onSpeechEnd: (durationMs: number) => void
  onPartial: (text: string) => void
  onUtterance: (text: string) => void
  onNotice: (message: string) => void
  /** An engine gave up; the controller picks a fallback and calls `reconfigure`. */
  onEngineFailure: (failure: EngineFailure, message: string) => void
}

export type VoiceInputOptions = {
  mic: Microphone
  selection: EngineSelection
  bridgeUrl: string
  lang: string
  wakePhrase: string
  echo: EchoWindow
  /** When CLAP's current sentence started playing, or 0. */
  speakingSince: () => number
  handlers: VoiceInputHandlers
}

/** CLAP's own first syllable is the least-cancelled sound of all; ignore onsets this soon after it. */
const SELF_GUARD_MS = 350
const WAKE_DEBOUNCE_MS = 1_500

export class VoiceInput {
  private readonly options: VoiceInputOptions
  private readonly handlers: VoiceInputHandlers
  private readonly vad = new VadDetector()
  private readonly assembler: UtteranceAssembler
  private selection: EngineSelection
  private matchWake: (text: string) => WakeMatch
  private mode: RecognizerMode = 'off'
  private recognizer: WebSpeechRecognizer | null = null
  private webspeech: WebSpeechProvider | null = null
  private stt: SpeechProvider | null = null
  private recorder: SegmentRecorder | null = null
  private unsubscribe: (() => void) | null = null
  private lastWake = 0
  private segmentStartedAt = 0

  constructor(options: VoiceInputOptions) {
    this.options = options
    this.handlers = options.handlers
    this.selection = options.selection
    this.matchWake = createWakeMatcher(options.wakePhrase)
    this.assembler = new UtteranceAssembler({
      emit: (text) => this.handlers.onUtterance(text),
      partial: (text) => this.handlers.onPartial(text),
    })
  }

  get engines(): EngineSelection {
    return this.selection
  }

  start(): void {
    this.build()
    this.unsubscribe = this.options.mic.onFrame((rms, t) => this.onFrame(rms, t))
    this.apply()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.teardown()
    this.assembler.cancel()
    this.vad.reset()
    this.mode = 'off'
  }

  /** Swap engines after a failure without dropping the microphone. */
  reconfigure(selection: EngineSelection): void {
    this.teardown()
    this.selection = selection
    this.build()
    this.apply()
  }

  setWakePhrase(phrase: string): void {
    this.matchWake = createWakeMatcher(phrase)
  }

  setMode(mode: RecognizerMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.vad.setGuard(mode === 'guard')
    if (mode === 'wake' || mode === 'off') this.assembler.cancel()
    this.apply()
  }

  currentMode(): RecognizerMode {
    return this.mode
  }

  meter() {
    return { ...this.vad.meter(), mode: this.mode, recognizer: this.recognizer?.running ?? false, restarts: this.recognizer?.restarts ?? 0 }
  }

  // ---------------------------------------------------------------------------

  private build(): void {
    const selection = this.selection
    const mic = this.options.mic
    const wakeWeb = selection.wake !== 'push-to-talk'
    const sttWeb = selection.stt === 'webspeech-local' || selection.stt === 'webspeech-cloud'
    if (wakeWeb || sttWeb) {
      const local = selection.wake === 'webspeech-local' || selection.stt === 'webspeech-local'
      this.recognizer = new WebSpeechRecognizer({
        lang: this.options.lang,
        local,
        onResult: (text, final) => this.onRecognized(text, final),
        onError: (code, fatal) => this.onRecognizerError(code, fatal, local),
      })
    }
    if (selection.stt === 'bridge-cloud' && mic.stream && SegmentRecorder.supported()) {
      this.stt = new BridgeSpeechProvider(this.options.bridgeUrl)
      this.recorder = new SegmentRecorder(mic.stream)
    } else if (sttWeb) {
      this.webspeech = new WebSpeechProvider(selection.stt === 'webspeech-local')
      this.stt = this.webspeech
    }
    this.stt?.start({
      onPartial: (text) => this.onTranscript(text, false),
      onFinal: (text) => this.onTranscript(text, true),
      onError: (message, fatal) => {
        if (fatal) this.handlers.onEngineFailure('cloud-stt', message)
        else this.handlers.onNotice(message)
      },
    })
  }

  private teardown(): void {
    this.recognizer?.stop()
    this.recognizer = null
    this.stt?.stop()
    this.stt = null
    this.webspeech = null
    this.recorder?.discard()
    this.recorder = null
  }

  /** Run the browser recogniser only in the modes that need it. */
  private apply(): void {
    if (!this.recognizer) return
    const wanted =
      (this.mode === 'wake' && this.selection.wake !== 'push-to-talk') ||
      ((this.mode === 'command' || this.mode === 'guard') && this.webspeech !== null)
    if (wanted) this.recognizer.start()
    else this.recognizer.stop()
  }

  private onFrame(rms: number, t: number): void {
    const event = this.vad.process(rms, t)
    if (!event || this.mode === 'off') return
    switch (event) {
      case 'onset':
        this.recorder?.begin()
        return
      case 'discard':
        this.recorder?.discard()
        return
      case 'start': {
        this.segmentStartedAt = t
        if (this.mode === 'guard') {
          const since = this.options.speakingSince()
          if (since && performance.now() - since < SELF_GUARD_MS) return
        }
        if (this.mode === 'command' || this.mode === 'guard') this.handlers.onSpeechStart()
        return
      }
      case 'end': {
        if (this.mode === 'command') this.handlers.onSpeechEnd(t - this.segmentStartedAt)
        const recorder = this.recorder
        if (!recorder) return
        void recorder.finish().then((audio) => {
          if (audio && this.mode === 'command') this.stt?.acceptSegment?.(audio)
        })
      }
    }
  }

  private onRecognized(text: string, final: boolean): void {
    if (this.mode === 'wake') {
      if (isLikelyEcho(text, this.options.echo.text())) return
      const match = this.matchWake(text)
      if (!match.matched) return
      const now = performance.now()
      if (now - this.lastWake < WAKE_DEBOUNCE_MS) return
      this.lastWake = now
      // Fire on the partial for a snappy response; the rest of the sentence
      // (if any) arrives in command mode and is picked up there.
      this.handlers.onWake(final ? match.trailing : '')
      return
    }
    this.webspeech?.deliver(text, final)
  }

  private onTranscript(text: string, final: boolean): void {
    const said = stripLeadingWake(text, this.matchWake).trim()
    if (!said || this.mode === 'off' || this.mode === 'wake') return
    if (isLikelyEcho(said, this.options.echo.text())) return

    if (this.mode === 'guard') {
      // Speech that is not CLAP's own voice takes the floor. A single-word
      // partial is not enough evidence; a final or two words is.
      if (!final && said.split(/\s+/).length < 2) return
      // Re-entrant: the controller handles this synchronously and calls
      // setMode('command') if the state machine accepted the barge-in.
      this.handlers.onSpeechStart()
      if (this.currentMode() !== 'command') return
    }

    if (final) this.assembler.feed(said, this.vad.isSpeaking)
    else this.handlers.onPartial(`${this.assembler.current()} ${said}`.trim())
  }

  private onRecognizerError(code: string, fatal: boolean, local: boolean): void {
    if (!fatal) {
      if (code === 'network') this.handlers.onNotice('Speech recognition lost its connection; retrying.')
      return
    }
    if (local && (code === 'language-not-supported' || code === 'service-not-allowed')) {
      this.handlers.onEngineFailure('local-recognition', 'On-device recognition is not available for this language.')
      return
    }
    this.handlers.onEngineFailure(
      'browser-recognition',
      code === 'not-allowed' ? 'The browser refused speech recognition.' : `Speech recognition stopped (${code}).`,
    )
  }
}

export type DegradeOptions = {
  allowCloudWake: boolean
  /** The bridge offers cloud STT. */
  cloudStt: boolean
  /** The browser has SpeechRecognition at all. */
  webSpeech: boolean
}

/** The selection to use after an engine failure. Pure; tested. */
export function degrade(selection: EngineSelection, failure: EngineFailure, options: DegradeOptions): EngineSelection {
  const notes = [...selection.notes]
  let { wake, stt } = selection
  if (failure === 'local-recognition') {
    if (wake === 'webspeech-local') wake = options.allowCloudWake ? 'webspeech-cloud' : 'push-to-talk'
    if (stt === 'webspeech-local') stt = options.cloudStt ? 'bridge-cloud' : 'webspeech-cloud'
    notes.push('On-device recognition failed; using a fallback.')
  } else if (failure === 'browser-recognition') {
    wake = 'push-to-talk'
    if (stt === 'webspeech-local' || stt === 'webspeech-cloud') stt = options.cloudStt ? 'bridge-cloud' : 'none'
    notes.push('Browser speech recognition failed; press Space to talk.')
  } else if (stt === 'bridge-cloud') {
    // The recogniser in use for the wake phrase (local or cloud) also takes commands.
    stt = wake === 'webspeech-local' ? 'webspeech-local' : options.webSpeech ? 'webspeech-cloud' : 'none'
    notes.push('Cloud transcription failed; using the browser recogniser.')
  }
  return { ...selection, wake, stt, notes }
}
