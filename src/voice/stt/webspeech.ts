/**
 * The browser's SpeechRecognition, made dependable.
 *
 * Under always-on use Chrome ends sessions on its own and occasionally stops
 * delivering events with no error at all. So this recogniser restarts itself
 * on `end`, backs off on network errors, and a heartbeat replaces a session
 * that has gone quiet (a lesson from adewaskar/jarvis, src/lib/voice.ts).
 *
 * `local: true` asks for on-device recognition (`processLocally`, Chromium),
 * so audio never leaves the machine. Whether that is available is decided by
 * capability detection; if the engine refuses at runtime it reports a fatal
 * error and the voice input falls back.
 */

import type { SpeechCapabilities, SpeechHandlers, SpeechProvider } from './types'

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } }
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> }
type RecognitionErrorEvent = { error: string }

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  processLocally?: boolean
  onstart: (() => void) | null
  onaudiostart: (() => void) | null
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export type SpeechRecognitionCtor = {
  new (): SpeechRecognitionLike
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>
  install?: (options: { langs: string[]; processLocally: boolean }) => Promise<boolean>
}

export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Errors after which this engine cannot work in the current configuration. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'unsupported'])
const QUIET_RESTART_MS = 20_000

export type RecognizerOptions = {
  lang: string
  local: boolean
  onResult: (text: string, final: boolean) => void
  onError: (code: string, fatal: boolean) => void
}

export class WebSpeechRecognizer {
  private readonly options: RecognizerOptions
  private rec: SpeechRecognitionLike | null = null
  private wanted = false
  private delivered = new Set<number>()
  private lastActivity = 0
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  restarts = 0

  constructor(options: RecognizerOptions) {
    this.options = options
  }

  get running(): boolean {
    return this.rec !== null
  }

  start(): void {
    if (this.wanted) return
    this.wanted = true
    this.spin()
    this.heartbeat ??= setInterval(() => {
      if (this.wanted && this.rec && performance.now() - this.lastActivity > QUIET_RESTART_MS) {
        this.restarts++
        this.rec.abort() // onend brings up a fresh session
      }
    }, 5_000)
  }

  stop(): void {
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const rec = this.rec
    this.rec = null
    try {
      rec?.abort()
    } catch {
      /* already stopped */
    }
  }

  private touch(): void {
    this.lastActivity = performance.now()
  }

  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer) return
    const delay = Math.min(100 * 2 ** this.failures, 5_000)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spin()
    }, delay)
  }

  private spin(): void {
    if (!this.wanted || this.rec) return
    const Ctor = speechRecognitionCtor()
    if (!Ctor) {
      this.wanted = false
      this.options.onError('unsupported', true)
      return
    }
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.lang = this.options.lang
    if (this.options.local) rec.processLocally = true
    this.delivered = new Set()
    this.touch()

    rec.onstart = () => this.touch()
    rec.onaudiostart = () => this.touch()
    rec.onresult = (event) => {
      this.touch()
      this.failures = 0
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!
        const text = result[0].transcript
        if (result.isFinal) {
          if (!this.delivered.has(i)) {
            this.delivered.add(i)
            if (text.trim()) this.options.onResult(text, true)
          }
        } else {
          interim += text
        }
      }
      if (interim.trim()) this.options.onResult(interim, false)
    }
    rec.onerror = (event) => {
      const code = event.error
      if (FATAL.has(code)) {
        this.wanted = false
        this.options.onError(code, true)
      } else if (code === 'network') {
        this.failures++
        this.options.onError(code, false)
      }
      // 'no-speech' and 'aborted' are routine: onend restarts the session.
    }
    rec.onend = () => {
      if (this.rec === rec) this.rec = null
      this.scheduleRestart()
    }

    try {
      rec.start()
      this.rec = rec
    } catch {
      this.failures++
      this.scheduleRestart()
    }
  }
}

/** The recogniser as a SpeechProvider. The voice input feeds it the shared recogniser's results. */
export class WebSpeechProvider implements SpeechProvider {
  readonly id = 'webspeech'
  private readonly local: boolean
  private handlers: SpeechHandlers | null = null

  constructor(local: boolean) {
    this.local = local
  }

  getCapabilities(): SpeechCapabilities {
    return { id: this.id, cloud: !this.local, local: this.local, partials: true, segmentBased: false }
  }

  start(handlers: SpeechHandlers): void {
    this.handlers = handlers
  }

  stop(): void {
    this.handlers = null
  }

  isActive(): boolean {
    return this.handlers !== null
  }

  deliver(text: string, final: boolean): void {
    if (!this.handlers) return
    if (final) this.handlers.onFinal(text)
    else this.handlers.onPartial(text)
  }

  fail(message: string, fatal: boolean): void {
    this.handlers?.onError(message, fatal)
  }
}
