import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, Color, DoubleSide, type Mesh, RingGeometry, ShaderMaterial, TorusGeometry } from 'three'
import type { Live } from './live'
import { RING_FRAGMENT, RING_VERTEX, RIPPLE_FRAGMENT } from './shaders'

const ORBITS = [
  { radius: 1.55, tilt: [1.2, 0.2, 0], speed: 0.9 },
  { radius: 1.8, tilt: [0.4, 1.1, 0.3], speed: -0.6 },
  { radius: 2.08, tilt: [1.75, -0.5, 0.9], speed: 0.45 },
] as const

/** Three thin rings on different axes: the "procedural rotating system" while CLAP works. */
export function Orbits({ live }: { live: Live }) {
  const meshes = useRef<Array<Mesh | null>>([])
  const materials = useMemo(
    () =>
      ORBITS.map(
        () =>
          new ShaderMaterial({
            uniforms: {
              uColor: { value: new Color() },
              uOpacity: { value: 0 },
              uDashed: { value: 0 },
              uTime: { value: 0 },
              uSpeed: { value: 1 },
            },
            vertexShader: RING_VERTEX,
            fragmentShader: RING_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
          }),
      ),
    [],
  )
  const geometries = useMemo(() => ORBITS.map((o) => new TorusGeometry(o.radius, 0.0045, 6, 360)), [])
  useEffect(
    () => () => {
      for (const m of materials) m.dispose()
      for (const g of geometries) g.dispose()
    },
    [materials, geometries],
  )

  useFrame((_, delta) => {
    ORBITS.forEach((orbit, i) => {
      const mesh = meshes.current[i]
      const u = materials[i]!.uniforms
      ;(u.uColor!.value as Color).copy(live.color)
      u.uOpacity!.value = live.orbit * (0.55 + i * 0.1)
      u.uDashed!.value = live.dashed
      u.uTime!.value = live.time
      u.uSpeed!.value = live.orbitSpeed
      if (mesh) mesh.rotation.z += delta * orbit.speed * live.orbitSpeed
    })
  })

  return (
    <>
      {ORBITS.map((orbit, i) => (
        <group key={orbit.radius} rotation={[orbit.tilt[0], orbit.tilt[1], orbit.tilt[2]]}>
          <mesh
            ref={(mesh) => {
              meshes.current[i] = mesh
            }}
            geometry={geometries[i]}
            material={materials[i]}
          />
        </group>
      ))}
    </>
  )
}

const POOL = 10
const LIFE = 1.6

type RippleSlot = { born: number; strength: number }

/** Expanding sound rings: a burst on the clap, one per spoken emphasis, a slow radar at rest. */
export function Ripples({ live }: { live: Live }) {
  const meshes = useRef<Array<Mesh | null>>([])
  const slots = useRef<RippleSlot[]>(Array.from({ length: POOL }, () => ({ born: -99, strength: 0 })))
  const geometry = useMemo(() => new RingGeometry(0.992, 1, 160), [])
  const materials = useMemo(
    () =>
      Array.from(
        { length: POOL },
        () =>
          new ShaderMaterial({
            uniforms: { uColor: { value: new Color() }, uOpacity: { value: 0 } },
            vertexShader: RING_VERTEX,
            fragmentShader: RIPPLE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            side: DoubleSide,
          }),
      ),
    [],
  )
  useEffect(
    () => () => {
      geometry.dispose()
      for (const m of materials) m.dispose()
    },
    [geometry, materials],
  )

  useFrame(() => {
    while (live.ripples.length) {
      const strength = live.ripples.shift()!
      // Reuse the oldest slot.
      const slot = slots.current.reduce((oldest, s) => (s.born < oldest.born ? s : oldest))
      slot.born = live.time
      slot.strength = Math.min(1, strength)
    }
    slots.current.forEach((slot, i) => {
      const mesh = meshes.current[i]
      const u = materials[i]!.uniforms
      const age = (live.time - slot.born) / LIFE
      if (!mesh) return
      if (age < 0 || age > 1) {
        mesh.visible = false
        return
      }
      mesh.visible = true
      const eased = 1 - (1 - age) ** 3
      mesh.scale.setScalar(1.08 + eased * (1.6 + slot.strength * 1.4))
      u.uOpacity!.value = (1 - age) ** 2 * slot.strength * 0.9
      ;(u.uColor!.value as Color).copy(live.color).lerp(live.core, 0.35)
    })
  })

  return (
    <>
      {materials.map((material, i) => (
        <mesh
          key={i}
          ref={(mesh) => {
            meshes.current[i] = mesh
          }}
          geometry={geometry}
          material={material}
          visible={false}
        />
      ))}
    </>
  )
}
