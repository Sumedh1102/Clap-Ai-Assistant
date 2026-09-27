import { lazy, Suspense, useState, type CSSProperties } from 'react'
import { ConfirmCard, TaskPanel } from '../hud/overlay/Activity'
import { Caption, Composer, History } from '../hud/overlay/Conversation'
import { ConnectionBadge, KeyHints, Notice, StatusBar } from '../hud/overlay/Status'
import { Activate, SystemPanel } from '../hud/overlay/System'
import { FallbackCore, SceneBoundary } from '../hud/scene/Fallback'
import { webglAvailable } from '../hud/scene/webgl'
import { cssColor, visualFor } from '../hud/visual'
import { useHud } from '../state/store'
import { useController } from './controller-context'
import { useKeyboard } from './useKeyboard'

/** three.js is most of the bundle: load it after the HUD is up, and never without WebGL. */
const Scene = lazy(() => import('../hud/scene/Scene').then((m) => ({ default: m.Scene })))

/** Layout only. Behaviour lives in the controller; appearance in the HUD components. */
export function App() {
  const controller = useController()
  useKeyboard(controller)
  const state = useHud((s) => s.assistant)
  const accent = visualFor(state).color
  const style = { '--accent': cssColor(accent), '--accent-soft': cssColor(accent, 0.18) } as CSSProperties
  const [webgl] = useState(webglAvailable)

  return (
    <div className="app" data-state={state} style={style}>
      {webgl ? (
        <SceneBoundary>
          <Suspense fallback={<FallbackCore />}>
            <Scene controller={controller} />
          </Suspense>
        </SceneBoundary>
      ) : (
        <FallbackCore />
      )}
      <div className="overlay">
        <StatusBar />
        <ConnectionBadge />
        <Notice />
        <TaskPanel />
        <History />
        <SystemPanel />
        <div className="bottom">
          <ConfirmCard />
          <Caption />
          <Activate />
          <Composer />
        </div>
        <KeyHints />
      </div>
    </div>
  )
}
