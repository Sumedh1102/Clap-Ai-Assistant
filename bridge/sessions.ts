/**
 * Agent sessions outlive sockets, briefly.
 *
 * A page reload or a short network drop used to wipe the conversation, because
 * the socket was the session. Here a detached session is kept for a grace
 * period (CLAP_SESSION_GRACE_S); a page that reconnects with its session id in
 * `hello` picks the conversation up where it left off. Anything in flight when
 * the socket dropped is interrupted — nobody is there to hear it.
 */

import type { BridgeEvent } from '../shared/protocol'
import type { AgentSession } from './agent/runtime'
import type { Logger } from './logger'

type Entry = {
  session: AgentSession
  attached: boolean
  disposeTimer: ReturnType<typeof setTimeout> | null
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly create: () => AgentSession
  private readonly graceMs: number
  private readonly logger: Logger

  constructor(options: { create: () => AgentSession; graceMs: number; logger: Logger }) {
    this.create = options.create
    this.graceMs = options.graceMs
    this.logger = options.logger.child({ component: 'sessions' })
  }

  /** Resume `resumeId` if it is waiting for a socket; otherwise start a new session. */
  attach(resumeId: string | undefined, emit: (event: BridgeEvent) => void): { session: AgentSession; resumed: boolean } {
    const waiting = resumeId ? this.entries.get(resumeId) : undefined
    // A session already attached elsewhere (a duplicated tab) is not shared.
    if (waiting && !waiting.attached) {
      if (waiting.disposeTimer) clearTimeout(waiting.disposeTimer)
      waiting.disposeTimer = null
      waiting.attached = true
      waiting.session.attach(emit)
      this.logger.info('session.resumed', { sessionId: waiting.session.id })
      return { session: waiting.session, resumed: true }
    }

    const session = this.create()
    this.entries.set(session.id, { session, attached: true, disposeTimer: null })
    session.attach(emit)
    session.warmUp()
    this.logger.info('session.created', { sessionId: session.id, resumeRequested: Boolean(resumeId) })
    return { session, resumed: false }
  }

  detach(session: AgentSession): void {
    const entry = this.entries.get(session.id)
    if (!entry || !entry.attached) return
    entry.attached = false
    session.detach()
    if (session.isBusy) session.interrupt('disconnected')
    if (this.graceMs <= 0) {
      this.dispose(session.id)
      return
    }
    entry.disposeTimer = setTimeout(() => this.dispose(session.id), this.graceMs)
    entry.disposeTimer.unref?.()
    this.logger.info('session.detached', { sessionId: session.id, graceMs: this.graceMs })
  }

  dispose(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer)
    this.entries.delete(id)
    entry.session.close()
  }

  closeAll(): void {
    for (const id of this.entries.keys()) this.dispose(id)
  }

  get size(): number {
    return this.entries.size
  }
}
