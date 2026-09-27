/**
 * Voice-activity detection on signal energy.
 *
 * Detecting *that* someone is speaking is an energy problem, not a language
 * problem, so it runs locally on every audio frame — instant, and unable to
 * fail silently the way a cloud recogniser can. It is what makes barge-in
 * feel natural.
 *
 * An adaptive noise floor (slow to rise with a fan spinning up, quick to fall
 * when a door closes), a trigger ratio above it, and hysteresis so one dip
 * mid-word does not end the segment. While CLAP is speaking, the "guard" raises
 * the bar so its own voice leaking past echo cancellation does not count.
 *
 * Approach and starting constants follow adewaskar/jarvis (src/lib/vad.ts,
 * MIT); this is a separate, frame-driven implementation with no DOM
 * dependency, so it can be tested with synthetic signals.
 */

export type VadTuning = {
  /** Speech must rise this far above the noise floor (a ratio). */
  triggerOverFloor: number
  /** Extra factor while CLAP is speaking. */
  guardBoost: number
  /** Falling below trigger × this counts as quiet (hysteresis). */
  releaseRatio: number
  /** Sustained energy this long confirms speech rather than a click. */
  startMs: number
  /** Quiet this long ends the segment. */
  silenceMs: number
  /** Segments are cut at this length. */
  maxMs: number
  floorUp: number
  floorDown: number
  minFloor: number
  /** Absolute minimum threshold, so a silent room cannot turn a breath into speech. */
  minThreshold: number
}

export const DEFAULT_VAD: VadTuning = {
  triggerOverFloor: 2.6,
  guardBoost: 2.4,
  releaseRatio: 0.6,
  startMs: 120,
  silenceMs: 650,
  maxMs: 20_000,
  floorUp: 0.0008,
  floorDown: 0.02,
  minFloor: 0.0015,
  minThreshold: 0.006,
}

/**
 * onset   — energy crossed the threshold; start recording now so the first
 *           phoneme is kept, even though it is not yet confirmed as speech.
 * start   — confirmed speech (the barge-in trigger).
 * discard — an onset that never confirmed (a knock, a click).
 * end     — the segment is over.
 */
export type VadEvent = 'onset' | 'start' | 'discard' | 'end'

export class VadDetector {
  private readonly tuning: VadTuning
  private floor = 0.01
  private smooth = 0
  private armedAt = 0
  private speaking = false
  private startedAt = 0
  private lastLoud = 0
  private guard = false
  private threshold = 0

  constructor(tuning: Partial<VadTuning> = {}) {
    this.tuning = { ...DEFAULT_VAD, ...tuning }
  }

  setGuard(on: boolean): void {
    this.guard = on
  }

  /** Feed one frame's RMS energy at time `t` (ms). */
  process(energy: number, t: number): VadEvent | null {
    const k = this.tuning
    this.smooth += (energy - this.smooth) * 0.5

    if (!this.speaking && this.armedAt === 0) {
      const rate = this.smooth > this.floor ? k.floorUp : k.floorDown
      this.floor = Math.max(k.minFloor, this.floor + (this.smooth - this.floor) * rate)
    }

    this.threshold = Math.max(k.minThreshold, this.floor * k.triggerOverFloor * (this.guard ? k.guardBoost : 1))

    if (!this.speaking) {
      if (this.smooth > this.threshold) {
        if (this.armedAt === 0) {
          this.armedAt = t
          return 'onset'
        }
        if (t - this.armedAt >= k.startMs) {
          this.speaking = true
          this.startedAt = this.armedAt
          this.lastLoud = t
          return 'start'
        }
        return null
      }
      if (this.armedAt !== 0) {
        this.armedAt = 0
        return 'discard'
      }
      return null
    }

    if (this.smooth > this.threshold * k.releaseRatio) this.lastLoud = t
    if (t - this.lastLoud >= k.silenceMs || t - this.startedAt >= k.maxMs) {
      this.speaking = false
      this.armedAt = 0
      return 'end'
    }
    return null
  }

  /** Abandon any segment in progress (mode change, shutdown). */
  reset(): void {
    this.speaking = false
    this.armedAt = 0
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  get speechStartedAt(): number {
    return this.speaking ? this.startedAt : 0
  }

  meter(): { energy: number; floor: number; threshold: number; speaking: boolean } {
    return { energy: this.smooth, floor: this.floor, threshold: this.threshold, speaking: this.speaking }
  }
}
