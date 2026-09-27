import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  type Group,
  IcosahedronGeometry,
  type Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  SphereGeometry,
} from 'three'
import type { Live } from './live'
import { SHELL_FRAGMENT, SHELL_VERTEX } from './shaders'

/**
 * The two hemispheres, the light between them, and the lattice inside.
 *
 * Both halves share one material (and therefore one noise field in local
 * space), so when they close the seam is invisible. They separate along the
 * view's x axis — two hands apart, two hands together.
 */
export function Core({ live }: { live: Live }) {
  const group = useRef<Group>(null)
  const left = useRef<Mesh>(null)
  const right = useRef<Mesh>(null)
  const glow = useRef<Mesh>(null)
  const lattice = useRef<Mesh>(null)

  const shell = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uNoise: { value: 0.04 },
          uNoiseSpeed: { value: 0.5 },
          uLevel: { value: 0 },
          uPulse: { value: 0 },
          uColor: { value: new Color() },
          uCore: { value: new Color() },
          uIntensity: { value: 1 },
        },
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      }),
    [],
  )
  // phi in [-π/2, π/2] is the x ≤ 0 half; [π/2, 3π/2] the x ≥ 0 half.
  const leftGeometry = useMemo(() => new SphereGeometry(1, 144, 96, -Math.PI / 2, Math.PI), [])
  const rightGeometry = useMemo(() => new SphereGeometry(1, 144, 96, Math.PI / 2, Math.PI), [])
  const glowMaterial = useMemo(() => new MeshBasicMaterial({ color: new Color(), transparent: true, blending: AdditiveBlending, depthWrite: false }), [])
  const latticeGeometry = useMemo(() => new IcosahedronGeometry(0.6, 1), [])
  const latticeMaterial = useMemo(
    () => new MeshBasicMaterial({ color: new Color(), wireframe: true, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    [],
  )

  useEffect(
    () => () => {
      shell.dispose()
      leftGeometry.dispose()
      rightGeometry.dispose()
      glowMaterial.dispose()
      latticeGeometry.dispose()
      latticeMaterial.dispose()
    },
    [shell, leftGeometry, rightGeometry, glowMaterial, latticeGeometry, latticeMaterial],
  )

  useFrame((_, delta) => {
    const u = shell.uniforms
    u.uTime!.value = live.time
    u.uNoise!.value = live.noise
    u.uNoiseSpeed!.value = live.noiseSpeed
    u.uLevel!.value = live.level
    u.uPulse!.value = live.pulse
    ;(u.uColor!.value as Color).copy(live.color)
    ;(u.uCore!.value as Color).copy(live.core)
    u.uIntensity!.value = live.intensity

    const jitter = live.jitter * (Math.random() - 0.5) * 0.08
    if (left.current) left.current.position.x = -live.split + jitter
    if (right.current) right.current.position.x = live.split - jitter

    if (group.current) {
      group.current.rotation.y = Math.sin(live.time * 0.3) * 0.25
      group.current.rotation.x = Math.sin(live.time * 0.21) * 0.12
      group.current.scale.setScalar(1 + live.level * 0.12 + live.pulse * 0.1)
    }
    if (glow.current) {
      glowMaterial.color.copy(live.core).multiplyScalar(0.35 + live.intensity * 0.45 + live.level * 0.9)
      glow.current.scale.setScalar(0.22 + live.level * 0.2 + live.pulse * 0.22 + (0.42 - Math.min(live.split, 0.42)) * 0.12)
    }
    if (lattice.current) {
      lattice.current.rotation.y += delta * live.spin
      lattice.current.rotation.x += delta * live.spin * 0.6
      latticeMaterial.color.copy(live.color).multiplyScalar(0.12 + live.orbit * 0.55)
    }
  })

  return (
    <group ref={group}>
      <mesh ref={left} geometry={leftGeometry} material={shell} />
      <mesh ref={right} geometry={rightGeometry} material={shell} />
      <mesh ref={lattice} geometry={latticeGeometry} material={latticeMaterial} />
      <mesh ref={glow} material={glowMaterial}>
        <sphereGeometry args={[1, 32, 24]} />
      </mesh>
    </group>
  )
}
