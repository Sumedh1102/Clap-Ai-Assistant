/**
 * CLAP's interface sounds, synthesised on the fly — no audio files, nothing to
 * license. Short and quiet: they confirm a state change without competing with
 * speech.
 *
 * The wake cue is the signature: two sharp noise transients a hair apart (a
 * soft clap) over a rising two-note tone.
 */

import type { CueName } from '../voice/machine'
import { audioOutput } from './output'

let muted = false

export function setCuesMuted(value: boolean): void {
  muted = value
}

function tone(ctx: AudioContext, out: AudioNode, freq: number, start: number, duration: number, gain: number, type: OscillatorType = 'sine') {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  env.gain.setValueAtTime(0, start)
  env.gain.linearRampToValueAtTime(gain, start + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(env)
  env.connect(out)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

function transient(ctx: AudioContext, out: AudioNode, start: number, gain: number) {
  const length = Math.floor(ctx.sampleRate * 0.06)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.12))
  const source = ctx.createBufferSource()
  const filter = ctx.createBiquadFilter()
  const env = ctx.createGain()
  filter.type = 'bandpass'
  filter.frequency.value = 1800
  filter.Q.value = 0.9
  env.gain.value = gain
  source.buffer = buffer
  source.connect(filter)
  filter.connect(env)
  env.connect(out)
  source.start(start)
}

export function playCue(name: CueName): void {
  const ctx = audioOutput.context
  const out = audioOutput.destination
  if (muted || !ctx || !out || ctx.state !== 'running') return
  const t = ctx.currentTime + 0.01
  switch (name) {
    case 'wake':
      transient(ctx, out, t, 0.35)
      transient(ctx, out, t + 0.045, 0.28)
      tone(ctx, out, 660, t + 0.05, 0.18, 0.05)
      tone(ctx, out, 990, t + 0.13, 0.22, 0.045)
      break
    case 'listen':
      tone(ctx, out, 880, t, 0.14, 0.04)
      break
    case 'sleep':
      tone(ctx, out, 660, t, 0.14, 0.035)
      tone(ctx, out, 440, t + 0.1, 0.2, 0.03)
      break
    case 'confirm':
      tone(ctx, out, 740, t, 0.16, 0.05, 'triangle')
      tone(ctx, out, 740, t + 0.2, 0.16, 0.05, 'triangle')
      break
    case 'error':
      tone(ctx, out, 220, t, 0.28, 0.06, 'sawtooth')
      break
  }
}
