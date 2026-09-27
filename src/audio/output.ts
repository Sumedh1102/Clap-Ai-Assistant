/**
 * The single audio output path.
 *
 * Every cloud-voice sentence and every cue plays through one AudioContext:
 * source → per-sound gain (for the barge-in fade) → master → analyser →
 * speakers. One context because Chrome caps how many a page may create; one
 * analyser so the HUD can react to whatever CLAP is saying.
 *
 * Browsers refuse to start audio before a user gesture, so `unlock()` must be
 * called from a click or key handler.
 */

type Playing = { source: AudioBufferSourceNode; gain: GainNode; stop: (fadeMs: number) => void }

class AudioOutput {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private bins: Uint8Array<ArrayBuffer> | null = null
  private readonly playing = new Set<Playing>()

  get context(): AudioContext | null {
    return this.ctx
  }

  get destination(): AudioNode | null {
    return this.master
  }

  /** Create or resume the context. Call from a user gesture. */
  async unlock(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      master.connect(analyser)
      analyser.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
      this.analyser = analyser
      this.bins = new Uint8Array(analyser.frequencyBinCount)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    return this.ctx
  }

  get unlocked(): boolean {
    return this.ctx?.state === 'running'
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.unlock()
    return ctx.decodeAudioData(data)
  }

  /** Play a buffer; resolves when it ends, is stopped, or the signal aborts. */
  play(buffer: AudioBuffer, options: { signal?: AbortSignal; onStart?: () => void } = {}): Promise<void> {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return Promise.reject(new Error('audio output is locked'))
    return new Promise<void>((resolve) => {
      const source = ctx.createBufferSource()
      const gain = ctx.createGain()
      source.buffer = buffer
      source.connect(gain)
      gain.connect(master)

      let done = false
      const finish = () => {
        if (done) return
        done = true
        this.playing.delete(entry)
        options.signal?.removeEventListener('abort', onAbort)
        try {
          source.disconnect()
          gain.disconnect()
        } catch {
          /* already disconnected */
        }
        resolve()
      }
      const stop = (fadeMs: number) => {
        if (done) return
        const now = ctx.currentTime
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(gain.gain.value, now)
        gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000)
        try {
          source.stop(now + fadeMs / 1000 + 0.01)
        } catch {
          finish()
        }
      }
      const onAbort = () => stop(80)
      const entry: Playing = { source, gain, stop }

      source.onended = finish
      this.playing.add(entry)
      if (options.signal?.aborted) return finish()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      source.start()
      options.onStart?.()
    })
  }

  /** Fade out everything playing (barge-in). */
  stopAll(fadeMs = 80): void {
    for (const entry of [...this.playing]) entry.stop(fadeMs)
  }

  isPlaying(): boolean {
    return this.playing.size > 0
  }

  /** 0..1 loudness of what is playing now. */
  level(): number {
    if (!this.analyser || !this.bins || !this.playing.size) return 0
    this.analyser.getByteFrequencyData(this.bins)
    let sum = 0
    for (let i = 2; i < this.bins.length; i++) sum += this.bins[i]!
    return Math.min(1, (sum / (this.bins.length - 2) / 255) * 3.2)
  }
}

export const audioOutput = new AudioOutput()
