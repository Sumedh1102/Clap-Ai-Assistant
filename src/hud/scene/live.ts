/**
 * Per-frame scene state, shared by the scene's components.
 *
 * The Driver updates this object once per frame (eased toward the current
 * state's look, plus live audio levels); every other component reads it in
 * its own frame callback. Mutable on purpose: none of this goes through React
 * state, so a 60 fps audio level never causes a re-render.
 */

import { Color } from 'three'
import type { AssistantState } from '../../voice/machine'
import { VISUALS } from '../visual'

export type Live = {
  state: AssistantState
  stateSince: number
  time: number
  color: Color
  core: Color
  intensity: number
  split: number
  noise: number
  noiseSpeed: number
  spin: number
  orbit: number
  orbitSpeed: number
  dashed: number
  dust: number
  jitter: number
  /** Level driving the surface right now (mic while listening, output while speaking). */
  level: number
  mic: number
  out: number
  /** A decaying kick, set on wake and speech peaks. */
  pulse: number
  /** Ripples waiting to be spawned: strengths 0..1. */
  ripples: number[]
}

export function createLive(): Live {
  const v = VISUALS.OFFLINE
  return {
    state: 'OFFLINE',
    stateSince: 0,
    time: 0,
    color: new Color(...v.color),
    core: new Color(...v.core),
    intensity: v.intensity,
    split: v.split,
    noise: v.noise,
    noiseSpeed: v.noiseSpeed,
    spin: v.spin,
    orbit: v.orbit,
    orbitSpeed: v.orbitSpeed,
    dashed: v.dashed,
    dust: v.dust,
    jitter: v.jitter,
    level: 0,
    mic: 0,
    out: 0,
    pulse: 0,
    ripples: [],
  }
}
