/**
 * The microphone, opened once and shared.
 *
 * Opening it twice makes Chrome drop the first stream, so everything that
 * listens (the VAD, the segment recorder, the level meter for the visuals)
 * goes through this one object. Echo cancellation, noise suppression and auto
 * gain are requested: echo cancellation is what lets CLAP keep listening while
 * it speaks.
 *
 * Levels are measured on the audio thread by an AudioWorklet
 * (public/worklets/level-meter.js), with an AnalyserNode + timer fallback for
 * browsers without worklets.
 */

export type MicErrorKind = 'denied' | 'unavailable' | 'insecure' | 'unsupported'

export class MicError extends Error {
  readonly kind: MicErrorKind
  constructor(kind: MicErrorKind, message: string) {
    super(message)
    this.name = 'MicError'
    this.kind = kind
  }
}

type FrameListener = (rms: number, t: number) => void

export class Microphone {
  stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private nodes: AudioNode[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<FrameListener>()
  private smoothed = 0
  private onEnded: (() => void) | null = null

  get isOpen(): boolean {
    return this.stream !== null
  }

  /** Must follow a user gesture the first time (permission prompt). */
  async open(onEnded?: () => void): Promise<void> {
    if (this.stream) return
    if (!window.isSecureContext) {
      throw new MicError('insecure', 'The microphone needs a secure page — open CLAP on http://localhost.')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported', 'This browser cannot use a microphone.')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch (error) {
      const name = (error as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MicError('denied', 'Microphone access was blocked. Allow it in the address bar, then activate voice again.')
      }
      throw new MicError('unavailable', 'No usable microphone was found.')
    }

    this.stream = stream
    this.onEnded = onEnded ?? null
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => this.onEnded?.())

    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    await ctx.resume().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    this.source = source

    try {
      await ctx.audioWorklet.addModule('/worklets/level-meter.js')
      const meter = new AudioWorkletNode(ctx, 'clap-level-meter')
      meter.port.onmessage = (event: MessageEvent<number>) => this.frame(event.data)
      // A silent sink keeps the worklet pulled by the graph.
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(meter)
      meter.connect(sink)
      sink.connect(ctx.destination)
      this.nodes = [meter, sink]
    } catch {
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.nodes = [analyser]
      const buffer = new Float32Array(analyser.fftSize)
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
        this.frame(Math.sqrt(sum / buffer.length))
      }, 20)
    }
  }

  private frame(rms: number): void {
    this.smoothed += (rms - this.smoothed) * 0.3
    const t = performance.now()
    for (const listener of this.listeners) listener(rms, t)
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 0..1 input loudness, for the visuals. */
  level(): number {
    return Math.min(1, this.smoothed * 14)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const node of this.nodes) node.disconnect()
    this.nodes = []
    this.source?.disconnect()
    this.source = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.smoothed = 0
    this.listeners.clear()
  }
}
