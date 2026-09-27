/**
 * The bridge's network surface: one HTTP server carrying the health check,
 * the voice proxy and the WebSocket upgrade.
 *
 * Built from injected parts so tests can run it on an ephemeral port with a
 * fake agent. `server.ts` wires the real ones.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLAP_VERSION, MAX_WS_MESSAGE_BYTES, PROTOCOL_VERSION, WS_PATH } from '../shared/defaults'
import type { BridgeEventOf } from '../shared/protocol'
import type { BridgeConfig } from './config'
import { handleConnection } from './connection'
import { SECURITY_HEADERS, sendJson } from './http'
import type { Logger } from './logger'
import type { ConfirmationBroker } from './permissions'
import { corsHeaders, guardRequest, headerValue } from './security/http-guard'
import type { SessionRegistry } from './sessions'
import type { ElevenLabs } from './voice/elevenlabs'
import { handleStt, handleTts } from './voice/routes'

export type BridgeDeps = {
  config: BridgeConfig
  logger: Logger
  sessions: SessionRegistry
  broker: ConfirmationBroker
  voice: ElevenLabs | null
  describe: () => Omit<BridgeEventOf<'session_ready'>, 'type' | 'sessionId' | 'resumed'>
}

export type Bridge = {
  server: Server
  listen(): Promise<{ host: string; port: number }>
  close(): Promise<void>
}

const HEARTBEAT_MS = 30_000

export function createBridge(deps: BridgeDeps): Bridge {
  const { config, logger } = deps
  const log = logger.child({ component: 'http' })
  const startedAt = Date.now()

  const guard = { allowedOrigins: config.allowedOrigins, allowedHosts: config.allowedHosts, allowNoOrigin: config.allowNoOrigin }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0]
    const origin = headerValue(req.headers.origin)
    const stateChanging = req.method !== 'GET' && req.method !== 'HEAD'
    const verdict = guardRequest(req, guard, stateChanging)
    if (!verdict.ok) {
      log.warn('http.refused', { method: req.method, path, reason: verdict.reason })
      return sendJson(res, verdict.status, { error: 'forbidden' })
    }
    const cors = corsHeaders(origin)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...SECURITY_HEADERS, ...cors })
      res.end()
      return
    }

    if (req.method === 'GET' && path === '/health') {
      const { capabilities, model, wakePhrase } = deps.describe()
      return sendJson(
        res,
        200,
        {
          ok: true,
          name: 'clap-bridge',
          version: CLAP_VERSION,
          protocol: PROTOCOL_VERSION,
          uptimeS: Math.round((Date.now() - startedAt) / 1000),
          model,
          wakePhrase,
          capabilities,
          sessions: deps.sessions.size,
        },
        cors,
      )
    }

    if (req.method === 'POST' && path === '/api/tts') return handleTts(req, res, { voice: deps.voice, logger, cors })
    if (req.method === 'POST' && path === '/api/stt') return handleStt(req, res, { voice: deps.voice, logger, cors })

    sendJson(res, 404, { error: 'not found' }, cors)
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      log.error('http.unhandled', { error, path: req.url })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })
  server.headersTimeout = 15_000
  server.requestTimeout = 60_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: false })
  const alive = new WeakMap<WebSocket, boolean>()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0]
    const refuse = (status: number, reason: string) => {
      log.warn('ws.refused', { path, reason, origin: headerValue(req.headers.origin) ?? '(none)' })
      socket.write(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    if (path !== WS_PATH) return refuse(404, 'wrong path')
    const verdict = guardRequest(req, guard, true)
    if (!verdict.ok) return refuse(403, verdict.reason)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    handleConnection(ws, { sessions: deps.sessions, broker: deps.broker, logger, describe: deps.describe })
  })

  // Sockets that stop answering pings (a sleeping laptop, a killed tab) are
  // closed so their sessions detach and eventually free their agent process.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : config.port
          resolve({ host: config.host, port })
        })
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat)
        for (const ws of wss.clients) ws.close(1001, 'bridge shutting down')
        deps.sessions.closeAll()
        wss.close()
        server.close(() => resolve())
        // Keep-alive HTTP connections would otherwise hold close() open.
        server.closeAllConnections()
      }),
  }
}
