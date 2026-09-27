import { useEffect, useState } from 'react'
import { useController } from '../../app/controller-context'
import { useHud } from '../../state/store'

/** The call to action before voice is running. Needs a click: browsers require a gesture for audio. */
export function Activate() {
  const controller = useController()
  const voice = useHud((s) => s.voice)
  const connection = useHud((s) => s.connection)
  const wakePhrase = useHud((s) => s.session.wakePhrase)
  if (voice.enabled || connection !== 'online') return null
  return (
    <div className="activate">
      <button type="button" onClick={() => void controller.activateVoice()} disabled={voice.activating}>
        <span className="pulse" aria-hidden="true" />
        {voice.activating ? 'Starting voice…' : 'Activate voice'}
      </button>
      <p>
        Then say “{wakePhrase || 'hey clap'}”, or hold a conversation with <kbd>Space</kbd>.
      </p>
    </div>
  )
}

/** Live internals, for when something doesn't work (D). */
export function SystemPanel() {
  const controller = useController()
  const open = useHud((s) => s.panels.diagnostics)
  const voice = useHud((s) => s.voice)
  const session = useHud((s) => s.session)
  const activity = useHud((s) => s.activity)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => tick((n) => n + 1), 200)
    return () => clearInterval(timer)
  }, [open])
  if (!open) return null

  const d = controller.diagnostics()
  const vad = d.vad
  const rows: Array<[string, string]> = [
    ['State', d.machine.state],
    ['Recogniser mode', d.mode],
    ['Agent', activity],
    ['Wake engine', voice.wake],
    ['Speech to text', voice.stt],
    ['Voice', `${voice.tts} (now: ${d.outputProvider})`],
    ['Audio output', d.audioUnlocked ? 'unlocked' : 'locked — click anywhere'],
    ['Model', session.model || '—'],
    ['Session', session.id ? `${session.id.slice(0, 8)}${session.resumed ? ' (resumed)' : ''}` : '—'],
    ['Tools', session.tools.map((t) => t.label).join(', ') || '—'],
    ['On-device recognition', d.browser?.localRecognition ?? '—'],
  ]
  return (
    <aside className="panel system" aria-label="System">
      <div className="panel-title">System</div>
      {rows.map(([k, v]) => (
        <div key={k} className="row">
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
      {vad && (
        <div className="meter" title="Microphone energy against the speech threshold">
          <div className="meter-bar" style={{ width: `${Math.min(100, (vad.energy / Math.max(vad.threshold, 1e-4)) * 50)}%` }} />
          <div className="meter-threshold" />
          <span>{vad.speaking ? 'speech' : 'quiet'} · recogniser {vad.recognizer ? 'on' : 'off'} · restarts {vad.restarts}</span>
        </div>
      )}
      {voice.notes.length > 0 && (
        <ul className="notes">
          {voice.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </aside>
  )
}
