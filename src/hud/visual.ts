/**
 * CLAP's visual language, as data.
 *
 * The core is two hemispheres — two hands. At rest they hang slightly apart;
 * on the wake phrase they snap together with a ripple (the clap); while CLAP
 * is working they stay joined; on error or when offline they drift apart.
 *
 * Each assistant state maps to a target look. The scene eases toward the
 * target every frame, so changes read as motion rather than cuts. Pure data and
 * pure functions — tested without WebGL.
 */

import type { AssistantState } from '../voice/machine'

export type RGB = readonly [number, number, number]

export type Visual = {
  /** Rim and surface colour. */
  color: RGB
  /** Inner glow colour. */
  core: RGB
  intensity: number
  /** Gap between the two hemispheres (world units). */
  split: number
  /** Surface turbulence. */
  noise: number
  noiseSpeed: number
  /** Core rotation, radians per second. */
  spin: number
  /** Orbit-ring visibility 0..1 and speed. */
  orbit: number
  orbitSpeed: number
  /** Orbit rings drawn as segments (tool activity). */
  dashed: number
  dust: number
  /** Which live level drives the surface. */
  react: 'mic' | 'output' | 'none'
  /** Background "radar" ripples per second. */
  pulseRate: number
  jitter: number
}

export const hex = (value: string): RGB => {
  const n = parseInt(value.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export const PALETTE = {
  graphite: hex('#4a4f5a'),
  steel: hex('#6b7a99'),
  standby: hex('#7f93b8'),
  flash: hex('#eafff8'),
  mint: hex('#35e0c1'),
  violet: hex('#9b7bff'),
  amber: hex('#ffb547'),
  gold: hex('#ffd98a'),
  warm: hex('#fff3d6'),
  signal: hex('#ff9f43'),
  alert: hex('#ff4d5e'),
} as const

const BASE: Visual = {
  color: PALETTE.steel,
  core: PALETTE.steel,
  intensity: 0.6,
  split: 0.2,
  noise: 0.04,
  noiseSpeed: 0.5,
  spin: 0.08,
  orbit: 0.05,
  orbitSpeed: 0.3,
  dashed: 0,
  dust: 0.3,
  react: 'none',
  pulseRate: 0,
  jitter: 0,
}

export const VISUALS: Record<AssistantState, Visual> = {
  OFFLINE: { ...BASE, color: PALETTE.graphite, core: PALETTE.graphite, intensity: 0.35, split: 0.42, noise: 0.025, spin: 0.04, orbit: 0, dust: 0.14 },
  IDLE: { ...BASE },
  LISTENING_FOR_WAKE: { ...BASE, color: PALETTE.standby, core: PALETTE.mint, intensity: 0.7, split: 0.12, spin: 0.1, orbit: 0.1, dust: 0.36, pulseRate: 0.28 },
  WAKE_DETECTED: { ...BASE, color: PALETTE.flash, core: PALETTE.mint, intensity: 1.7, split: 0, noise: 0.12, noiseSpeed: 1.2, spin: 0.7, orbit: 0.45, orbitSpeed: 1.4, dust: 0.85 },
  LISTENING: { ...BASE, color: PALETTE.mint, core: PALETTE.flash, intensity: 1.05, split: 0, noise: 0.06, noiseSpeed: 0.9, spin: 0.22, orbit: 0.18, dust: 0.55, react: 'mic' },
  THINKING: { ...BASE, color: PALETTE.violet, core: PALETTE.flash, intensity: 1.05, split: 0, noise: 0.1, noiseSpeed: 1.5, spin: 0.5, orbit: 1, orbitSpeed: 1.3, dust: 0.6 },
  EXECUTING: { ...BASE, color: PALETTE.amber, core: PALETTE.warm, intensity: 1.15, split: 0, noise: 0.08, noiseSpeed: 1.1, spin: 0.35, orbit: 1, orbitSpeed: 2.4, dashed: 1, dust: 0.62 },
  SPEAKING: { ...BASE, color: PALETTE.gold, core: PALETTE.warm, intensity: 1.15, split: 0, noise: 0.05, noiseSpeed: 0.8, spin: 0.2, orbit: 0.25, dust: 0.62, react: 'output' },
  CONFIRMING: { ...BASE, color: PALETTE.signal, core: PALETTE.warm, intensity: 1.1, split: 0.06, noise: 0.05, spin: 0.14, orbit: 0.65, orbitSpeed: 0.6, dashed: 1, dust: 0.5, pulseRate: 0.9 },
  ERROR: { ...BASE, color: PALETTE.alert, core: PALETTE.alert, intensity: 1, split: 0.26, noise: 0.14, noiseSpeed: 2.2, spin: 0.1, orbit: 0.2, dust: 0.4, jitter: 1 },
}

export function visualFor(state: AssistantState, reducedMotion = false): Visual {
  const v = VISUALS[state]
  if (!reducedMotion) return v
  return { ...v, spin: v.spin * 0.25, orbitSpeed: v.orbitSpeed * 0.25, noiseSpeed: v.noiseSpeed * 0.3, jitter: 0, pulseRate: 0 }
}

/** Frame-rate-independent easing toward a target. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt)
}

export const STATE_LABELS: Record<AssistantState, string> = {
  OFFLINE: 'OFFLINE',
  IDLE: 'ONLINE',
  LISTENING_FOR_WAKE: 'ONLINE',
  WAKE_DETECTED: 'LISTENING',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  EXECUTING: 'EXECUTING',
  SPEAKING: 'SPEAKING',
  CONFIRMING: 'CONFIRM?',
  ERROR: 'ERROR',
}

export function cssColor(rgb: RGB, alpha = 1): string {
  const [r, g, b] = rgb.map((c) => Math.round(c * 255))
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`
}
