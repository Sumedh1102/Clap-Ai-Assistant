/**
 * Cloud speech-to-text through the bridge (`POST /api/stt`).
 *
 * The voice-activity detector captures each utterance as a small compressed
 * audio file; this provider sends it to the bridge, which calls the cloud
 * service with its own key. Segments are transcribed one at a time, in the
 * order spoken: a queue, not a busy flag, so a burst of speech is never
 * dropped because the network was slow.
 *
 * Only segments captured while CLAP is listening for a command are sent. Idle
 * room audio never is — that is decided in the voice input before a segment
 * reaches `acceptSegment`.
 */

import type { SpeechCapabilities, SpeechHandlers, SpeechProvider } from './types'

export class BridgeSpeechProvider implements SpeechProvider {
  readonly id = 'bridge-cloud'
  private readonly baseUrl: string
  private handlers: SpeechHandlers | null = null
  private readonly queue: Blob[] = []
  private draining = false
  private failures = 0

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  getCapabilities(): SpeechCapabilities {
    return { id: this.id, cloud: true, local: false, partials: false, segmentBased: true }
  }

  start(handlers: SpeechHandlers): void {
    this.handlers = handlers
  }

  stop(): void {
    this.handlers = null
    this.queue.length = 0
  }

  isActive(): boolean {
    return this.handlers !== null
  }

  acceptSegment(audio: Blob): void {
    if (!this.handlers) return
    this.queue.push(audio)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && this.handlers) {
        const audio = this.queue.shift()!
        try {
          const response = await fetch(`${this.baseUrl}/api/stt`, {
            method: 'POST',
            headers: { 'content-type': audio.type || 'audio/webm' },
            body: audio,
          })
          if (!response.ok) throw new Error(`status ${response.status}`)
          const { text } = (await response.json()) as { text?: unknown }
          this.failures = 0
          if (typeof text === 'string' && text.trim()) this.handlers?.onFinal(text.trim())
        } catch {
          this.failures++
          this.handlers?.onError('Cloud transcription failed.', this.failures >= 3)
        }
      }
    } finally {
      this.draining = false
    }
  }
}

function pickMime(): string {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

/**
 * Records one utterance at a time from the shared microphone stream. Each
 * segment is its own self-contained file (a fresh recorder per segment).
 */
export class SegmentRecorder {
  private readonly stream: MediaStream
  private readonly mime = pickMime()
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []

  constructor(stream: MediaStream) {
    this.stream = stream
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined'
  }

  begin(): void {
    this.discard()
    try {
      this.recorder = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream)
    } catch {
      this.recorder = null
      return
    }
    this.chunks = []
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data)
    }
    this.recorder.start()
  }

  discard(): void {
    const recorder = this.recorder
    this.recorder = null
    this.chunks = []
    if (!recorder) return
    recorder.ondataavailable = null
    try {
      if (recorder.state !== 'inactive') recorder.stop()
    } catch {
      /* already stopped */
    }
  }

  finish(): Promise<Blob | null> {
    const recorder = this.recorder
    this.recorder = null
    if (!recorder) return Promise.resolve(null)
    return new Promise((resolve) => {
      const done = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || this.mime || 'audio/webm' })
        this.chunks = []
        resolve(blob.size ? blob : null)
      }
      recorder.onstop = done
      try {
        if (recorder.state !== 'inactive') recorder.stop()
        else done()
      } catch {
        done()
      }
    })
  }
}
