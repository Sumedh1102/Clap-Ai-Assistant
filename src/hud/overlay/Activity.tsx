import { useEffect, useState } from 'react'
import { useController } from '../../app/controller-context'
import { useHud, type ToolActivity } from '../../state/store'

const STATUS_ICON: Record<ToolActivity['status'], string> = {
  running: '◌',
  done: '✓',
  failed: '✕',
  denied: '⊘',
}

/** What CLAP is doing right now: the current task and its tools. */
export function TaskPanel() {
  const tools = useHud((s) => s.tools)
  const state = useHud((s) => s.assistant)
  const busy = state === 'THINKING' || state === 'EXECUTING' || state === 'SPEAKING' || state === 'CONFIRMING'
  if (!tools.length || !busy) return null
  return (
    <aside className="panel tasks" aria-label="Current task">
      <div className="panel-title">Current task</div>
      {tools.map((tool) => (
        <div key={tool.toolUseId} className={`task task-${tool.status}`}>
          <span className="icon" aria-hidden="true">
            {STATUS_ICON[tool.status]}
          </span>
          <div className="body">
            <div className="name">
              {tool.label}
              {tool.risk !== 'low' && <span className={`risk risk-${tool.risk}`}>{tool.risk}</span>}
            </div>
            <div className="summary">{tool.status === 'failed' || tool.status === 'denied' ? tool.detail : tool.summary}</div>
          </div>
          {tool.durationMs !== undefined && <span className="duration">{(tool.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      ))}
    </aside>
  )
}

function useCountdown(expiresAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [expiresAt])
  return expiresAt ? Math.max(0, expiresAt - now) : 0
}

/** The bridge is asking before it acts. Approve with Y / click / "yes"; decline with N. */
export function ConfirmCard() {
  const controller = useController()
  const confirmation = useHud((s) => s.confirmation)
  const [total, setTotal] = useState(1)
  const remaining = useCountdown(confirmation?.expiresAt)
  useEffect(() => {
    if (confirmation) setTotal(Math.max(1, confirmation.expiresAt - Date.now()))
  }, [confirmation])
  if (!confirmation) return null
  return (
    <div className={`confirm risk-${confirmation.risk}`} role="alertdialog" aria-labelledby="confirm-title">
      <div className="confirm-head">
        <span id="confirm-title">Confirmation required</span>
        <span className={`risk risk-${confirmation.risk}`}>{confirmation.risk} risk</span>
      </div>
      <div className="confirm-label">{confirmation.label}</div>
      <div className="confirm-summary">{confirmation.summary}</div>
      <div className="confirm-actions">
        <button type="button" className="approve" onClick={() => controller.answerConfirmation(true, 'click')}>
          Approve <kbd>Y</kbd>
        </button>
        <button type="button" className="decline" onClick={() => controller.answerConfirmation(false, 'click')}>
          Decline <kbd>N</kbd>
        </button>
      </div>
      <div className="confirm-timer" style={{ transform: `scaleX(${remaining / total})` }} />
    </div>
  )
}
