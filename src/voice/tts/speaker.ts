/**
 * Speaks a streaming answer.
 *
 * Text arrives in deltas; complete sentences are queued and spoken one at a
 * time while the model keeps writing, with the next sentence's audio prepared
 * while the current one plays. The queue is a plain array with a single pump
 * so `cancel()` can empty it instantly — a promise chain cannot be cut.
 *
 * The speaker reports when sound starts and stops (for the state machine) and
 * keeps the echo window current (for the voice input's echo filter).
 */

import { toSpeakable } from '../../lib/text'
import type { EchoWindow } from '../echo'
import { FenceFilter, SentenceSplitter } from './sentences'
import type { VoiceProvider } from './types'

export type SpeakerHooks = {
  /** A sentence started playing. */
  onAudible?: () => void
  /** Playback paused because the queue ran dry (more may come). */
  onSilent?: () => void
  onError?: (error: unknown) => void
}

export class Speaker {
  private readonly provider: VoiceProvider
  private readonly hooks: SpeakerHooks
  private readonly echo: EchoWindow | null
  private readonly fences = new FenceFilter()
  private readonly splitter = new SentenceSplitter()
  private readonly abort = new AbortController()
  private queue: string[] = []
  private pumping = false
  private cancelled = false
  private waiters: Array<() => void> = []
  private spokeAnything = false

  constructor(provider: VoiceProvider, hooks: SpeakerHooks = {}, echo: EchoWindow | null = null) {
    this.provider = provider
    this.hooks = hooks
    this.echo = echo
  }

  /** Feed streamed text; complete sentences are spoken as they appear. */
  push(delta: string): void {
    if (this.cancelled) return
    for (const sentence of this.splitter.push(this.fences.push(delta))) this.enqueue(sentence)
  }

  /** Speak a whole piece of text (a prompt or notice) after anything queued. */
  say(text: string): void {
    if (this.cancelled) return
    const fences = new FenceFilter()
    const splitter = new SentenceSplitter()
    const prose = `${fences.push(text)}${fences.flush()} `
    for (const sentence of [...splitter.push(prose), ...splitter.flush()]) this.enqueue(sentence)
  }

  /** No more text is coming. Resolves once everything queued has been spoken (or cancelled). */
  end(): Promise<void> {
    for (const sentence of [...this.splitter.push(this.fences.flush()), ...this.splitter.flush()]) this.enqueue(sentence)
    if (this.cancelled || (!this.pumping && !this.queue.length)) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Stop now (barge-in). Always settles `end()`. */
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.queue = []
    this.fences.reset()
    this.splitter.reset()
    this.abort.abort()
    this.provider.stop(80)
    this.echo?.stopped()
    this.settle()
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  get hasSpoken(): boolean {
    return this.spokeAnything
  }

  private enqueue(sentence: string): void {
    const text = toSpeakable(sentence)
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return
    this.queue.push(text)
    if (this.pumping && this.queue.length === 1) this.provider.prepare?.(text)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.cancelled) {
        const text = this.queue.shift()!
        if (this.queue[0]) this.provider.prepare?.(this.queue[0])
        let audible = false
        try {
          await this.provider.speak(text, {
            signal: this.abort.signal,
            onStart: () => {
              audible = true
              this.spokeAnything = true
              this.echo?.speaking(text)
              this.hooks.onAudible?.()
            },
          })
        } catch (error) {
          this.hooks.onError?.(error)
        }
        if (audible) {
          this.echo?.stopped()
          if (!this.queue.length && !this.cancelled) this.hooks.onSilent?.()
        }
      }
    } finally {
      this.pumping = false
      if (!this.queue.length || this.cancelled) this.settle()
    }
  }

  private settle(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}
