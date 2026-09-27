import { useHud } from '../../state/store'
import { STATE_LABELS } from '../visual'

function useSubtitle(): string {
  const state = useHud((s) => s.assistant)
  const wakePhrase = useHud((s) => s.session.wakePhrase)
  const voice = useHud((s) => s.voice)
  const activity = useHud((s) => s.activity)
  const running = useHud((s) => s.tools.find((t) => t.status === 'running'))
  const confirmation = useHud((s) => s.confirmation)
  const error = useHud((s) => s.error)
  const connectionDetail = useHud((s) => s.connectionDetail)

  switch (state) {
    case 'OFFLINE':
      return connectionDetail ? 'Bridge unreachable — reconnecting' : 'Connecting to the bridge'
    case 'IDLE':
      return voice.enabled ? 'Press Space to talk' : 'Voice off — type, or activate voice'
    case 'LISTENING_FOR_WAKE':
      return `Say “${wakePhrase || 'hey clap'}”`
    case 'WAKE_DETECTED':
    case 'LISTENING':
      return 'Go ahead'
    case 'THINKING':
      return activity === 'responding' ? 'Composing' : 'Working it out'
    case 'EXECUTING':
      return running ? `${running.label} · ${running.summary}` : 'Running a tool'
    case 'SPEAKING':
      return 'Speak to interrupt'
    case 'CONFIRMING':
      return confirmation ? confirmation.label : 'Waiting for your answer'
    case 'ERROR':
      return error ?? 'Something failed'
  }
}

export function StatusBar() {
  const state = useHud((s) => s.assistant)
  const subtitle = useSubtitle()
  return (
    <header className="status" aria-live="polite">
      <div className="wordmark" aria-label="CLAP">
        <span>C</span>
        <span>L</span>
        <span>A</span>
        <span>P</span>
      </div>
      <div className="status-line">
        <span className="state-dot" />
        <span className="state-label">{STATE_LABELS[state]}</span>
      </div>
      <div className="state-sub" title={subtitle}>
        {subtitle}
      </div>
    </header>
  )
}

export function ConnectionBadge() {
  const connection = useHud((s) => s.connection)
  const model = useHud((s) => s.session.model)
  const latency = useHud((s) => s.latencyMs)
  return (
    <div className={`connection connection-${connection}`}>
      <span className="label">Bridge</span>
      <span className="dot" />
      <span className="value">{connection === 'online' ? 'Online' : connection === 'connecting' ? 'Connecting' : 'Offline'}</span>
      {model && connection === 'online' && <span className="meta">{model}</span>}
      {latency !== null && connection === 'online' && <span className="meta">{latency} ms</span>}
    </div>
  )
}

export function Notice() {
  const notice = useHud((s) => s.notice)
  if (!notice) return null
  return (
    <div className="notice" role="status">
      {notice}
    </div>
  )
}

export function KeyHints() {
  return (
    <div className="key-hints" aria-hidden="true">
      <span>
        <kbd>Space</kbd> talk
      </span>
      <span>
        <kbd>Esc</kbd> stand down
      </span>
      <span>
        <kbd>M</kbd> mic
      </span>
      <span>
        <kbd>/</kbd> type
      </span>
      <span>
        <kbd>H</kbd> history
      </span>
      <span>
        <kbd>D</kbd> system
      </span>
    </div>
  )
}
