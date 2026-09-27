/**
 * One HUD socket.
 *
 * Every inbound message is size-limited (by the server), rate-limited (here),
 * and validated against the shared protocol before anything acts on it. The
 * first message must be `hello`; until then nothing else is accepted.
 */

import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '../shared/defaults'
import { parseClientMessage, type BridgeEvent, type BridgeEventOf } from '../shared/protocol'
import type { AgentSession } from './agent/runtime'
import type { Logger } from './logger'
import type { ConfirmationBroker } from './permissions'
import type { SessionRegistry } from './sessions'

export type ConnectionDeps = {
  sessions: SessionRegistry
  broker: ConfirmationBroker
  logger: Logger
  /** Everything in `session_ready` except the per-session fields. */
  describe: () => Omit<BridgeEventOf<'session_ready'>, 'type' | 'sessionId' | 'resumed'>
  helloTimeoutMs?: number
}

/** Allows short bursts (a flurry of telemetry) but not a runaway loop. */
export class TokenBucket {
  private tokens: number
  private last: number
  private readonly capacity: number
  private readonly perSecond: number
  private readonly now: () => number

  constructor(capacity: number, perSecond: number, now: () => number = Date.now) {
    this.capacity = capacity
    this.perSecond = perSecond
    this.now = now
    this.tokens = capacity
    this.last = now()
  }

  take(): boolean {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond)
    this.last = t
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

export function handleConnection(socket: WebSocket, deps: ConnectionDeps): void {
  const connectionId = randomUUID().slice(0, 8)
  const log = deps.logger.child({ component: 'ws', connection: connectionId })
  const bucket = new TokenBucket(40, 20)
  let session: AgentSession | null = null
  let lastRateWarning = 0

  const send = (event: BridgeEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
  }

  const helloTimer = setTimeout(() => {
    if (session) return
    log.warn('ws.no_hello')
    send({ type: 'error', code: 'not_ready', message: 'No hello received.', recoverable: false })
    socket.close(1008, 'hello required')
  }, deps.helloTimeoutMs ?? 10_000)

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      send({ type: 'error', code: 'bad_message', message: 'Binary messages are not supported.', recoverable: true })
      return
    }
    if (!bucket.take()) {
      const now = Date.now()
      if (now - lastRateWarning > 1000) {
        lastRateWarning = now
        log.warn('ws.rate_limited')
        send({ type: 'error', code: 'rate_limited', message: 'Too many messages; some were dropped.', recoverable: true })
      }
      return
    }

    const parsed = parseClientMessage(data.toString())
    if (!parsed.ok) {
      log.warn('ws.bad_message', { error: parsed.error })
      send({ type: 'error', code: 'bad_message', message: `Message rejected: ${parsed.error}`.slice(0, 500), recoverable: true })
      return
    }
    const message = parsed.value

    if (message.type === 'hello') {
      if (session) return
      clearTimeout(helloTimer)
      if (message.protocol !== PROTOCOL_VERSION) {
        log.warn('ws.protocol_mismatch', { client: message.protocol, bridge: PROTOCOL_VERSION })
        send({
          type: 'error',
          code: 'unsupported_protocol',
          message: `This bridge speaks protocol ${PROTOCOL_VERSION}; the page speaks ${message.protocol}. Reload the page.`,
          recoverable: false,
        })
        socket.close(1002, 'protocol mismatch')
        return
      }
      const attached = deps.sessions.attach(message.resumeSessionId, send)
      session = attached.session
      log.info('ws.hello', { sessionId: session.id, resumed: attached.resumed, client: message.client })
      send({ type: 'session_ready', sessionId: session.id, resumed: attached.resumed, ...deps.describe() })
      return
    }

    if (!session) {
      send({ type: 'error', code: 'not_ready', message: 'Send hello first.', recoverable: true })
      return
    }

    switch (message.type) {
      case 'user_message':
        session.submit(message.turnId, message.text, message.source)
        return
      case 'interrupt':
        log.info('turn.interrupt_requested', { sessionId: session.id, turnId: message.turnId, reason: message.reason })
        session.interrupt(message.reason)
        return
      case 'confirmation_response': {
        const result = deps.broker.respond(session.id, message.requestId, message.approved)
        const fields = { sessionId: session.id, requestId: message.requestId, approved: message.approved, via: message.via, result }
        if (result === 'accepted') log.info('confirmation.response', fields)
        else log.warn('confirmation.response_rejected', fields)
        return
      }
      case 'ping':
        send({ type: 'pong', t: message.t, serverTime: Date.now() })
        return
      case 'wake_detected':
        log.info('voice.wake', { sessionId: session.id, engine: message.engine })
        return
      case 'speech_start':
      case 'speech_stop':
        log.debug(`voice.${message.type}`, { sessionId: session.id })
        return
      case 'assistant_speech_start':
        log.info('voice.playback_start', { sessionId: session.id, turnId: message.turnId, provider: message.provider })
        return
      case 'assistant_speech_end':
        log.info('voice.playback_end', { sessionId: session.id, turnId: message.turnId, interrupted: message.interrupted })
        return
    }
  })

  socket.on('close', (code) => {
    clearTimeout(helloTimer)
    if (session) deps.sessions.detach(session)
    log.info('ws.closed', { code, sessionId: session?.id })
  })

  socket.on('error', (error) => log.warn('ws.error', { error }))
}
