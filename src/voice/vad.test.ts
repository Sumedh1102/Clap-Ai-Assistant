import { describe, expect, it } from 'vitest'
import { DEFAULT_VAD, VadDetector, type VadEvent } from './vad'

const FRAME_MS = 10

/** Feed a sequence of [energy, durationMs] segments; collect events with their times. */
function feed(vad: VadDetector, segments: Array<[number, number]>, start = 0): Array<[VadEvent, number]> {
  const events: Array<[VadEvent, number]> = []
  let t = start
  for (const [energy, duration] of segments) {
    for (let elapsed = 0; elapsed < duration; elapsed += FRAME_MS) {
      const event = vad.process(energy, t)
      if (event) events.push([event, t])
      t += FRAME_MS
    }
  }
  return events
}

const QUIET = 0.003
const SPEECH = 0.08

describe('VadDetector', () => {
  it('confirms sustained speech after startMs and ends it after silenceMs', () => {
    const vad = new VadDetector()
    const events = feed(vad, [
      [QUIET, 2_000],
      [SPEECH, 800],
      [QUIET, 1_000],
    ])
    expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end'])
    const [onset, start, end] = events.map(([, t]) => t) as [number, number, number]
    expect(start - onset).toBeGreaterThanOrEqual(DEFAULT_VAD.startMs)
    expect(end - 2_800).toBeGreaterThanOrEqual(DEFAULT_VAD.silenceMs - FRAME_MS)
    expect(vad.isSpeaking).toBe(false)
  })

  it('discards a click that never confirms', () => {
    const vad = new VadDetector()
    const events = feed(vad, [
      [QUIET, 2_000],
      [SPEECH, 40],
      [QUIET, 500],
    ])
    expect(events.map(([e]) => e)).toEqual(['onset', 'discard'])
  })

  it('keeps one segment across a short mid-word dip', () => {
    const vad = new VadDetector()
    const events = feed(vad, [
      [QUIET, 2_000],
      [SPEECH, 400],
      [QUIET, 200],
      [SPEECH, 400],
      [QUIET, 1_000],
    ])
    expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end'])
  })

  it('cuts a segment at maxMs', () => {
    const vad = new VadDetector({ maxMs: 1_000 })
    const events = feed(vad, [
      [QUIET, 1_000],
      [SPEECH, 1_500],
    ])
    // Sound that carries on past the cut is the room, not a speaker.
    expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end'])
  })

  it('learns sustained noise instead of hearing it as endless speech', () => {
    const vad = new VadDetector()
    const tv = 0.05
    // A TV comes on: one long segment, then silence from the detector.
    const events = feed(vad, [
      [QUIET, 2_000],
      [tv, 60_000],
    ])
    expect(events.map(([e]) => e)).toEqual(['onset', 'start', 'end'])
    expect(events[2]![1] - events[1]![1]).toBeLessThanOrEqual(DEFAULT_VAD.maxMs + FRAME_MS)
    // Someone speaking up over it is still heard.
    expect(feed(vad, [[0.3, 500]], 62_000).map(([e]) => e)).toEqual(['onset', 'start'])
  })

  it('hears ordinary speech again soon after the noise stops', () => {
    const vad = new VadDetector()
    feed(vad, [
      [QUIET, 2_000],
      [0.05, 25_000],
    ])
    // Three seconds of a quiet room, then normal speech.
    const events = feed(vad, [
      [QUIET, 3_000],
      [SPEECH, 500],
    ], 27_000)
    expect(events.map(([e]) => e)).toEqual(['onset', 'start'])
  })

  it('adapts its floor to steady background noise', () => {
    const vad = new VadDetector()
    const fan = 0.02
    // A fan that runs long enough is the new floor, not speech…
    feed(vad, [[fan, 60_000]])
    expect(vad.meter().floor).toBeGreaterThan(0.015)
    expect(feed(vad, [[fan, 2_000]], 60_000)).toEqual([])
    // …and speech over it still triggers.
    expect(feed(vad, [[0.2, 500]], 62_000).map(([e]) => e)).toEqual(['onset', 'start'])
  })

  it('needs louder speech to trigger while CLAP is talking (guard)', () => {
    // Above the open threshold (floor × 2.6), below the guarded one (× 2.4 more).
    const level = 0.015
    const open = new VadDetector()
    expect(feed(open, [[QUIET, 2_000], [level, 500]]).map(([e]) => e)).toContain('start')
    const guarded = new VadDetector()
    guarded.setGuard(true)
    expect(feed(guarded, [[QUIET, 2_000], [level, 500]]).map(([e]) => e)).not.toContain('start')
  })

  it('never treats a silent room breath as speech', () => {
    const vad = new VadDetector()
    const events = feed(vad, [
      [0, 3_000],
      [DEFAULT_VAD.minThreshold * 0.8, 500],
    ])
    expect(events).toEqual([])
    expect(vad.meter().threshold).toBeGreaterThanOrEqual(DEFAULT_VAD.minThreshold)
  })

  it('abandons a segment on reset', () => {
    const vad = new VadDetector()
    feed(vad, [[QUIET, 1_000], [SPEECH, 300]])
    expect(vad.isSpeaking).toBe(true)
    expect(vad.speechStartedAt).toBeGreaterThan(0)
    vad.reset()
    expect(vad.isSpeaking).toBe(false)
    expect(vad.speechStartedAt).toBe(0)
  })
})
