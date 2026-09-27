/**
 * A chain of voice providers: speak with the first that works.
 *
 * A failed sentence is retried on the next provider, so the user hears the
 * answer in a lesser voice rather than not at all. A provider that fails twice
 * in a row is skipped for the rest of the session — a broken voice fails the
 * same way on every sentence, and retrying it would make every answer stutter.
 */

import { VoiceError, type SpeakOptions, type VoiceCapabilities, type VoiceProvider } from './types'

export class FallbackVoiceProvider implements VoiceProvider {
  private readonly chain: VoiceProvider[]
  private readonly failures = new Map<string, number>()
  private readonly onFallback: (from: string, to: string | null, reason: string) => void
  private current: VoiceProvider | null = null

  constructor(chain: VoiceProvider[], onFallback: (from: string, to: string | null, reason: string) => void = () => {}) {
    if (!chain.length) throw new Error('a voice chain needs at least one provider')
    this.chain = chain
    this.onFallback = onFallback
  }

  get id(): string {
    return this.usable()[0]?.id ?? 'none'
  }

  private usable(): VoiceProvider[] {
    return this.chain.filter((p) => (this.failures.get(p.id) ?? 0) < 2)
  }

  getCapabilities(): VoiceCapabilities {
    return this.usable()[0]?.getCapabilities() ?? { id: 'none', cloud: false, customVoice: false, analysable: false }
  }

  prepare(text: string): void {
    this.usable()[0]?.prepare?.(text)
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    const providers = this.usable()
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!
      if (options.signal.aborted) return
      this.current = provider
      try {
        await provider.speak(text, options)
        this.failures.set(provider.id, 0)
        return
      } catch (error) {
        if (options.signal.aborted) return
        this.failures.set(provider.id, (this.failures.get(provider.id) ?? 0) + 1)
        this.onFallback(provider.id, providers[i + 1]?.id ?? null, error instanceof Error ? error.message : String(error))
      } finally {
        this.current = null
      }
    }
    throw new VoiceError('chain', 'no voice is available')
  }

  stop(fadeMs?: number): void {
    for (const provider of this.chain) provider.stop(fadeMs)
  }

  isSpeaking(): boolean {
    return this.chain.some((p) => p.isSpeaking())
  }

  level(): number {
    return this.current?.level() ?? 0
  }
}
