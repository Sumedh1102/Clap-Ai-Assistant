/**
 * Cloud voice via the bridge (`POST /api/tts`). The bridge holds the provider
 * key and the voice id — including CLAP's custom voice — so the browser only
 * ever sends text to its own loopback bridge.
 *
 * Audio is decoded and played through the shared output context, which gives
 * the HUD a real output level and gives barge-in a proper fade.
 */

import { audioOutput } from '../../audio/output'
import { VoiceError, type SpeakOptions, type VoiceCapabilities, type VoiceProvider } from './types'

type Prepared = { controller: AbortController; audio: Promise<AudioBuffer> }

export class BridgeVoiceProvider implements VoiceProvider {
  readonly id = 'bridge-cloud'
  private readonly baseUrl: string
  private readonly customVoice: boolean
  private readonly prepared = new Map<string, Prepared>()
  private speaking = false

  constructor(baseUrl: string, customVoice: boolean) {
    this.baseUrl = baseUrl
    this.customVoice = customVoice
  }

  getCapabilities(): VoiceCapabilities {
    return { id: this.id, cloud: true, customVoice: this.customVoice, analysable: true }
  }

  prepare(text: string): void {
    if (this.prepared.has(text)) return
    const controller = new AbortController()
    const audio = this.fetchAudio(text, controller.signal)
    audio.catch(() => {}) // observed by speak(); an unused prefetch must not be an unhandled rejection
    this.prepared.set(text, { controller, audio })
  }

  private async fetchAudio(text: string, signal: AbortSignal): Promise<AudioBuffer> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      })
    } catch (error) {
      throw new VoiceError(this.id, signal.aborted ? 'aborted' : `bridge unreachable: ${String(error)}`)
    }
    if (!response.ok) throw new VoiceError(this.id, `synthesis failed (${response.status})`)
    return audioOutput.decode(await response.arrayBuffer())
  }

  async speak(text: string, { signal, onStart }: SpeakOptions): Promise<void> {
    if (signal.aborted) return
    this.prepare(text)
    const entry = this.prepared.get(text)!
    const onAbort = () => entry.controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const buffer = await entry.audio
      if (signal.aborted) return
      this.speaking = true
      await audioOutput.play(buffer, { signal, onStart })
    } catch (error) {
      if (signal.aborted) return
      throw error instanceof VoiceError ? error : new VoiceError(this.id, String(error))
    } finally {
      this.speaking = false
      this.prepared.delete(text)
      signal.removeEventListener('abort', onAbort)
    }
  }

  stop(fadeMs = 80): void {
    for (const entry of this.prepared.values()) entry.controller.abort()
    this.prepared.clear()
    audioOutput.stopAll(fadeMs)
    this.speaking = false
  }

  isSpeaking(): boolean {
    return this.speaking
  }

  level(): number {
    return audioOutput.level()
  }
}
