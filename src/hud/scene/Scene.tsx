import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color } from 'three'
import type { ClapController } from '../../app/controller'
import { hud } from '../../state/store'
import { damp, visualFor } from '../visual'
import { Core } from './Core'
import { Dust } from './Dust'
import { createLive, type Live } from './live'
import { Orbits, Ripples } from './Rings'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Eases the shared live state toward the current assistant state's look and
 * turns audio peaks into ripples. Mounted first, so it runs before the
 * components that read `live` each frame.
 */
function Driver({ live, controller, reducedMotion }: { live: Live; controller: ClapController; reducedMotion: boolean }) {
  const target = useMemo(() => new Color(), [])
  const peaks = useRef({ out: 0, mic: 0, lastRipple: -1, phase: 0 })

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.1)
    live.time += dt
    const now = hud.get().assistant
    if (now !== live.state) {
      // The clap: the halves snap shut and the room rings.
      if (now === 'WAKE_DETECTED') {
        live.ripples.push(1, 0.7)
        live.pulse = 1
      }
      if (now === 'ERROR') live.pulse = 0.6
      live.state = now
      live.stateSince = live.time
    }

    const v = visualFor(now, reducedMotion)
    const snap = now === 'WAKE_DETECTED'
    const rate = snap ? 14 : 3.2
    const mix = 1 - Math.exp(-rate * dt)
    live.color.lerp(target.setRGB(v.color[0], v.color[1], v.color[2]), mix)
    live.core.lerp(target.setRGB(v.core[0], v.core[1], v.core[2]), mix)
    live.intensity = damp(live.intensity, v.intensity, rate, dt)
    live.split = damp(live.split, v.split, snap ? 18 : 2.4, dt)
    live.noise = damp(live.noise, v.noise, 3, dt)
    live.noiseSpeed = damp(live.noiseSpeed, v.noiseSpeed, 2, dt)
    live.spin = damp(live.spin, v.spin, 2, dt)
    live.orbit = damp(live.orbit, v.orbit, 3, dt)
    live.orbitSpeed = damp(live.orbitSpeed, v.orbitSpeed, 2, dt)
    live.dashed = damp(live.dashed, v.dashed, 4, dt)
    live.dust = damp(live.dust, v.dust, 2, dt)
    live.jitter = damp(live.jitter, v.jitter, 6, dt)

    live.mic = controller.micLevel()
    live.out = controller.outputLevel()
    const raw = v.react === 'mic' ? live.mic : v.react === 'output' ? live.out : 0
    live.level = damp(live.level, raw, 14, dt)
    live.pulse = damp(live.pulse, 0, 3, dt)

    const p = peaks.current
    if (v.pulseRate > 0) {
      p.phase += dt * v.pulseRate
      if (p.phase >= 1) {
        p.phase -= 1
        live.ripples.push(0.28)
      }
    }
    if (now === 'SPEAKING' && live.out > 0.45 && p.out <= 0.45 && live.time - p.lastRipple > 0.22) {
      live.ripples.push(0.3 + live.out * 0.5)
      live.pulse = Math.max(live.pulse, live.out * 0.45)
      p.lastRipple = live.time
    }
    if (now === 'LISTENING' && live.mic > 0.4 && p.mic <= 0.4 && live.time - p.lastRipple > 0.4) {
      live.ripples.push(0.22)
      p.lastRipple = live.time
    }
    p.out = live.out
    p.mic = live.mic
  })
  return null
}

/**
 * The 3D core. Loaded lazily by App (it carries three.js), behind the WebGL
 * check and error boundary in ./Fallback.
 */
export function Scene({ controller }: { controller: ClapController }) {
  const live = useMemo(() => createLive(), [])
  const reducedMotion = usePrefersReducedMotion()

  return (
    <Canvas
      className="scene"
      camera={{ position: [0, 0, 5.4], fov: 42 }}
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      aria-hidden="true"
    >
      <color attach="background" args={['#05060a']} />
      <Driver live={live} controller={controller} reducedMotion={reducedMotion} />
      <Dust live={live} />
      <Orbits live={live} />
      <Ripples live={live} />
      <Core live={live} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.15} luminanceThreshold={0.06} luminanceSmoothing={0.25} />
        <Noise opacity={0.028} />
        <Vignette offset={0.28} darkness={0.8} />
      </EffectComposer>
    </Canvas>
  )
}
