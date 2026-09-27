/**
 * Everything around the 3D scene that must not load three.js: the CSS core
 * shown while the scene's code downloads, when WebGL is unavailable, or after
 * the scene crashes, and the error boundary that switches to it.
 */

import { Component, type ReactNode } from 'react'
import { useHud } from '../../state/store'
import { cssColor, visualFor } from '../visual'

/** The same states as the 3D core, in CSS. */
export function FallbackCore() {
  const state = useHud((s) => s.assistant)
  const v = visualFor(state)
  return (
    <div className="core-fallback" data-state={state} aria-hidden="true">
      <span style={{ background: `radial-gradient(circle, ${cssColor(v.core, 0.9)} 0%, ${cssColor(v.color, 0.35)} 45%, transparent 70%)` }} />
    </div>
  )
}

export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: unknown) {
    console.error('[clap] 3D scene failed; using the fallback core', error)
  }
  override render() {
    return this.state.failed ? <FallbackCore /> : this.props.children
  }
}
