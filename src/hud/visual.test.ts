import { describe, expect, it } from 'vitest'
import type { AssistantState } from '../voice/machine'
import { cssColor, damp, hex, STATE_LABELS, VISUALS, visualFor } from './visual'

const STATES = Object.keys(VISUALS) as AssistantState[]

describe('visuals', () => {
  it('defines a look and a label for every state', () => {
    expect(STATES).toHaveLength(10)
    for (const state of STATES) expect(STATE_LABELS[state]).toBeTruthy()
  })

  it('snaps the halves shut on the wake phrase and keeps them joined while working', () => {
    expect(VISUALS.WAKE_DETECTED.split).toBe(0)
    for (const state of ['LISTENING', 'THINKING', 'EXECUTING', 'SPEAKING'] as const) expect(VISUALS[state].split).toBe(0)
    expect(VISUALS.OFFLINE.split).toBeGreaterThan(VISUALS.IDLE.split)
    expect(VISUALS.ERROR.split).toBeGreaterThan(VISUALS.IDLE.split)
  })

  it('reacts to the microphone while listening and to the voice while speaking', () => {
    expect(VISUALS.LISTENING.react).toBe('mic')
    expect(VISUALS.SPEAKING.react).toBe('output')
  })

  it('calms motion for reduced-motion users without changing colour', () => {
    for (const state of STATES) {
      const calm = visualFor(state, true)
      const full = visualFor(state)
      expect(calm.jitter).toBe(0)
      expect(calm.pulseRate).toBe(0)
      expect(calm.spin).toBeLessThanOrEqual(full.spin)
      expect(calm.color).toEqual(full.color)
    }
  })
})

describe('helpers', () => {
  it('parses hex colours and formats CSS', () => {
    expect(hex('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(cssColor([1, 0.5, 0])).toBe('rgb(255 128 0)')
    expect(cssColor([0, 0, 0], 0.5)).toBe('rgb(0 0 0 / 0.5)')
  })

  it('eases toward a target independently of frame rate', () => {
    const oneStep = damp(0, 1, 3, 0.1)
    let twoSteps = damp(0, 1, 3, 0.05)
    twoSteps = damp(twoSteps, 1, 3, 0.05)
    expect(twoSteps).toBeCloseTo(oneStep, 10)
    expect(damp(0.4, 0.4, 3, 1)).toBe(0.4)
  })
})
