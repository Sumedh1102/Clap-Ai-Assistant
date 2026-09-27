import type { CSSProperties } from 'react'
import { ConfirmCard, TaskPanel } from '../hud/overlay/Activity'
import { Caption, Composer, History } from '../hud/overlay/Conversation'
import { ConnectionBadge, KeyHints, Notice, StatusBar } from '../hud/overlay/Status'
import { Activate, SystemPanel } from '../hud/overlay/System'
import { Scene } from '../hud/scene/Scene'
import { cssColor, visualFor } from '../hud/visual'
import { useHud } from '../state/store'
import { useController } from './controller-context'
import { useKeyboard } from './useKeyboard'

/** Layout only. Behaviour lives in the controller; appearance in the HUD components. */
export function App() {
  const controller = useController()
  useKeyboard(controller)
  const state = useHud((s) => s.assistant)
  const accent = visualFor(state).color
  const style = { '--accent': cssColor(accent), '--accent-soft': cssColor(accent, 0.18) } as CSSProperties

  return (
    <div className="app" data-state={state} style={style}>
      <Scene controller={controller} />
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
