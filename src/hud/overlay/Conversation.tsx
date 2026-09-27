import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useController } from '../../app/controller-context'
import { useHud } from '../../state/store'

/** The live line under the core: what you're saying, or what CLAP is saying. */
export function Caption() {
  const caption = useHud((s) => s.caption)
  const state = useHud((s) => s.assistant)
  const turnId = useHud((s) => s.currentTurnId)
  const reply = useHud((s) => (turnId ? s.transcript.find((e) => e.id === `c-${turnId}`) : undefined))
  const asked = useHud((s) => (turnId ? s.transcript.find((e) => e.id === `u-${turnId}`) : undefined))

  const listening = state === 'LISTENING' || state === 'WAKE_DETECTED' || state === 'CONFIRMING'
  if (listening && caption) {
    return (
      <div className="caption caption-user" aria-live="polite">
        {caption}
      </div>
    )
  }
  if (reply?.text) {
    const text = reply.text.length > 260 ? `…${reply.text.slice(-260)}` : reply.text
    return (
      <div className="caption caption-clap" aria-live="polite">
        {text}
        {reply.interrupted && <span className="tag">interrupted</span>}
      </div>
    )
  }
  if (asked && (state === 'THINKING' || state === 'EXECUTING')) {
    return <div className="caption caption-asked">“{asked.text}”</div>
  }
  return null
}

export function Composer() {
  const controller = useController()
  const connected = useHud((s) => s.connection === 'online')
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focus = () => input.current?.focus()
    window.addEventListener('clap:focus-composer', focus)
    return () => window.removeEventListener('clap:focus-composer', focus)
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || !connected) return
    controller.submitText(value)
    setText('')
  }

  return (
    <form className="composer" onSubmit={submit}>
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') input.current?.blur()
        }}
        placeholder={connected ? 'Type to CLAP — Enter to send' : 'Waiting for the bridge…'}
        maxLength={4000}
        aria-label="Message CLAP"
        autoComplete="off"
        spellCheck
        disabled={!connected}
      />
    </form>
  )
}

export function History() {
  const open = useHud((s) => s.panels.history)
  const transcript = useHud((s) => s.transcript)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'end' })
  }, [open, transcript.length])
  if (!open) return null
  return (
    <aside className="panel history" aria-label="Conversation history">
      <div className="panel-title">History</div>
      {transcript.length === 0 && <div className="empty">Nothing yet.</div>}
      {transcript.map((entry) => (
        <div key={entry.id} className={`entry entry-${entry.role}`}>
          <div className="who">
            {entry.role === 'user' ? 'You' : 'CLAP'}
            {entry.source === 'voice' && <span className="tag">voice</span>}
            {entry.interrupted && <span className="tag">interrupted</span>}
          </div>
          {entry.text && <div className="text">{entry.text}</div>}
          {entry.error && <div className="text error">{entry.error}</div>}
        </div>
      ))}
      <div ref={end} />
    </aside>
  )
}
