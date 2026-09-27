/**
 * The HUD's connection to the bridge.
 *
 * Sends typed messages, validates every inbound event against the shared
 * protocol (a malformed or unknown frame is logged and dropped, never
 * trusted), and keeps itself connected: exponential backoff from 0.5 s to
 * 10 s, forever, because a bridge being restarted should come back on its
 * own. The session id is kept in sessionStorage so a page reload resumes the
 * conversation instead of starting a new one.
 */

import { PROTOCOL_VERSION } from '../../shared/defaults'
import { parseBridgeEvent, type BridgeEvent, type ClientMessage } from '../../shared/protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export type BridgeClientOptions = {
  url: string
  onEvent: (event: BridgeEvent) => void
  onStatus: (status: ConnectionStatus, detail?: string) => void
  onLatency?: (ms: number) => void
  debug?: boolean
}

const SESSION_KEY = 'clap.session'
const PING_MS = 15_000
const PONG_TIMEOUT_MS = 8_000

function readSession(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeSession(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, id)
  } catch {
    /* storage unavailable: resume won't work across reloads */
  }
}

export class BridgeClient {
  private readonly options: BridgeClientOptions
  private socket: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongDeadline: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  private ready = false

  constructor(options: BridgeClientOptions) {
    this.options = options
  }

  get isReady(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.closedByUs = false
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    this.options.onStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(this.options.url)
    } catch (error) {
      this.options.onStatus('closed', String(error))
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.send({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'clap-hud', resumeSessionId: readSession() })
    }
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      const parsed = parseBridgeEvent(message.data)
      if (!parsed.ok) {
        console.warn('[clap] dropped a malformed bridge event:', parsed.error)
        return
      }
      const event = parsed.value
      if (event.type === 'session_ready') {
        this.ready = true
        this.attempt = 0
        writeSession(event.sessionId)
        this.startPings()
        this.options.onStatus('open')
      } else if (event.type === 'pong') {
        if (this.pongDeadline) clearTimeout(this.pongDeadline)
        this.pongDeadline = null
        this.options.onLatency?.(Math.max(0, Math.round(performance.now() - event.t)))
        return
      }
      if (this.options.debug) console.info('[clap] ←', event.type, event)
      this.options.onEvent(event)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = false
      this.stopPings()
      this.options.onStatus('closed', event.reason || `code ${event.code}`)
      if (!this.closedByUs) this.scheduleReconnect()
    }
    socket.onerror = () => {
      // The browser gives no reason; onclose follows and handles it.
    }
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    if (!this.ready && message.type !== 'hello') return false
    if (this.options.debug && message.type !== 'ping') console.info('[clap] →', message.type, message)
    this.socket.send(JSON.stringify(message))
    return true
  }

  close(): void {
    this.closedByUs = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopPings()
    this.socket?.close(1000, 'page closing')
    this.socket = null
    this.ready = false
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(500 * 1.7 ** this.attempt, 10_000)
    this.attempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startPings(): void {
    this.stopPings()
    const ping = () => {
      if (!this.send({ type: 'ping', t: performance.now() })) return
      this.pongDeadline ??= setTimeout(() => {
        // A socket that stops answering is dead even if the browser hasn't noticed.
        this.pongDeadline = null
        this.socket?.close(4000, 'pong timeout')
      }, PONG_TIMEOUT_MS)
    }
    ping()
    this.pingTimer = setInterval(ping, PING_MS)
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.pongDeadline) clearTimeout(this.pongDeadline)
    this.pongDeadline = null
  }
}
