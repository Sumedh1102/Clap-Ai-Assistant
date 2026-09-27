import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, type Points, PointsMaterial } from 'three'
import type { Live } from './live'

const COUNT = 900

/** mulberry32: a small seeded generator, so the field is the same on every mount. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dustPositions(): Float32Array {
  const random = seeded(0xc1a9)
  const positions = new Float32Array(COUNT * 3)
  for (let i = 0; i < COUNT; i++) {
    // Uniform direction, radius biased outward: a shell, not a ball.
    const u = random() * 2 - 1
    const theta = random() * Math.PI * 2
    const r = 2.3 + random() ** 0.6 * 4.5
    const s = Math.sqrt(1 - u * u)
    positions[i * 3] = r * s * Math.cos(theta)
    positions[i * 3 + 1] = r * u * 0.7
    positions[i * 3 + 2] = r * s * Math.sin(theta) - 1.5
  }
  return positions
}

/** A slow field of particles around the core; its brightness follows the state. */
export function Dust({ live }: { live: Live }) {
  const points = useRef<Points>(null)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(dustPositions(), 3))
    return g
  }, [])
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: 0.022,
        sizeAttenuation: true,
        color: new Color(),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  )
  const white = useMemo(() => new Color(1, 1, 1), [])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame((_, delta) => {
    if (points.current) {
      points.current.rotation.y += delta * (0.012 + live.spin * 0.03)
      points.current.rotation.x = Math.sin(live.time * 0.05) * 0.08
    }
    material.color.copy(live.color).lerp(white, 0.35)
    material.opacity = live.dust * (0.85 + live.level * 0.4)
  })

  return <points ref={points} geometry={geometry} material={material} />
}
