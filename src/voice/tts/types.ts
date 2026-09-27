/**
 * Text-to-speech providers.
 *
 * The rest of CLAP only ever sees this interface. Adding a provider (another
 * cloud service, a local model) means writing one adapter and adding it to the
 * chain in the controller — nothing in the UI or the state machine changes.
 */

export type VoiceCapabilities = {
  id: string
  /** Audio is synthesised by a remote service. */
  cloud: boolean
  /** Speaks in CLAP's own custom voice. */
  customVoice: boolean
  /** Output can be analysed for audio-reactive visuals. */
  analysable: boolean
}

export type SpeakOptions = {
  signal: AbortSignal
  /** Called when sound actually starts coming out. */
  onStart?: () => void
}

export interface VoiceProvider {
  readonly id: string
  getCapabilities(): VoiceCapabilities
  /** Start synthesising ahead of time (optional). */
  prepare?(text: string): void
  /** Resolves when playback ends or the signal aborts; rejects with VoiceError if it cannot speak. */
  speak(text: string, options: SpeakOptions): Promise<void>
  /** Stop immediately, fading over `fadeMs` where the provider can. */
  stop(fadeMs?: number): void
  isSpeaking(): boolean
  /** 0..1 output loudness now. */
  level(): number
}

export class VoiceError extends Error {
  readonly provider: string
  constructor(provider: string, message: string) {
    super(message)
    this.name = 'VoiceError'
    this.provider = provider
  }
}
