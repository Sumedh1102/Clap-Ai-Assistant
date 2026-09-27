import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CLAP_VERSION, PROTOCOL_VERSION } from '../shared/defaults'
import type { BridgeEvent, ClientMessage } from '../shared/protocol'
import { AgentSession } from './agent/runtime'
import { createBridge, type Bridge } from './app'
import { parseConfig, voiceCapabilities, type BridgeConfig } from './config'
import { silentLogger } from './logger'
import { ConfirmationBroker, PermissionGate } from './permissions'
import { SessionRegistry } from './sessions'
import { z } from 'zod'
import { CLAP_PROVENANCE, FakeSdk, frame, settle } from './testing/fake-sdk'
import { createToolRegistry } from './tools'
import { defineTool, sdkToolName } from './tools/registry'
import { ElevenLabs } from './voice/elevenlabs'

const UI = 'http://localhost:5173'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

type Harness = { bridge: Bridge; config: BridgeConfig; sdk: FakeSdk; port: number; sessions: SessionRegistry; upstream: string[] }

let harness: Harness

async function start(options: { voice?: boolean } = {}): Promise<Harness> {
  const port = await freePort()
  const env: NodeJS.ProcessEnv = { CLAP_BRIDGE_PORT: String(port), CLAP_LOG_FORMAT: 'json' }
  if (options.voice) env.ELEVENLABS_API_KEY = 'sk_test_0123456789'
  const config = parseConfig(env)
  const registry = createToolRegistry(config).register(
    defineTool({
      name: 'delete_files',
      label: 'Delete files',
      description: 'test',
      category: 'files',
      risk: 'high',
      inputSchema: { count: z.number() },
      summarize: ({ count }) => `Delete ${count} files`,
      handler: async () => ({ text: 'deleted' }),
    }),
  )
  const broker = new ConfirmationBroker({ timeoutMs: config.confirmTimeoutMs })
  const sdk = new FakeSdk()
  const sessions = new SessionRegistry({
    create: () =>
      new AgentSession({
        config,
        registry,
        gate: new PermissionGate(registry, config.policy),
        broker,
        logger: silentLogger,
        systemPrompt: 'test',
        queryFn: sdk.queryFn,
      }),
    graceMs: config.sessionGraceMs,
    logger: silentLogger,
  })
  const upstream: string[] = []
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    upstream.push(String(url))
    if (String(url).endsWith('/speech-to-text')) {
      const form = init?.body
      if (!(form instanceof FormData)) throw new Error('expected a multipart body')
      const file = form.get('file') as File
      return Response.json({ text: `heard ${file.size} bytes` })
    }
    return new Response(new Uint8Array([7, 7, 7]), { headers: { 'content-type': 'audio/mpeg' } })
  }) as typeof fetch
  const bridge = createBridge({
    config,
    logger: silentLogger,
    sessions,
    broker,
    voice: options.voice ? new ElevenLabs(config.voice, fakeFetch) : null,
    describe: () => ({
      protocol: PROTOCOL_VERSION,
      bridgeVersion: CLAP_VERSION,
      model: config.model,
      capabilities: voiceCapabilities(config),
      tools: registry.list(),
      wakePhrase: config.wakePhrase,
      policy: config.policy,
    }),
  })
  await bridge.listen()
  return { bridge, config, sdk, port, sessions, upstream }
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer }

function call(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: harness.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const post = (body: string) => call('POST', '/api/tts', { origin: UI }, body)
const stt = (type: string, body: Buffer) => call('POST', '/api/stt', { origin: UI, 'content-type': type }, body)

const json = (reply: Reply) => JSON.parse(reply.body.toString()) as Record<string, unknown>

/** A WebSocket client that records every event. */
class Client {
  readonly events: BridgeEvent[] = []
  readonly socket: WebSocket
  closed: { code: number; reason: string } | null = null
  refused: number | null = null

  constructor(options: { origin?: string; path?: string } = {}) {
    // `origin: ''` means a non-browser client that sends no Origin at all.
    const origin = options.origin ?? UI
    this.socket = new WebSocket(`ws://127.0.0.1:${harness.port}${options.path ?? '/ws'}`, origin ? { origin } : {})
    this.socket.on('message', (data) => this.events.push(JSON.parse(data.toString()) as BridgeEvent))
    this.socket.on('close', (code, reason) => (this.closed = { code, reason: reason.toString() }))
    this.socket.on('unexpected-response', (_req, res) => {
      this.refused = res.statusCode ?? 0
      this.socket.terminate()
    })
    this.socket.on('error', () => {})
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve()
      this.socket.once('open', () => resolve())
      this.socket.once('close', () => reject(new Error(`closed (${this.refused ?? 'no status'})`)))
    })
  }

  send(message: ClientMessage | string): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  async next<T extends BridgeEvent['type']>(type: T, timeoutMs = 1_000): Promise<Extract<BridgeEvent, { type: T }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.events.find((e) => e.type === type)
      if (found) {
        this.events.splice(this.events.indexOf(found), 1)
        return found as Extract<BridgeEvent, { type: T }>
      }
      if (Date.now() > deadline) throw new Error(`no ${type} event; got ${this.events.map((e) => e.type).join(', ')}`)
      await settle()
    }
  }

  async hello(resumeSessionId?: string) {
    await this.open()
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'test', ...(resumeSessionId ? { resumeSessionId } : {}) })
    return this.next('session_ready')
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    for (let i = 0; i < 200 && !this.closed; i++) await settle()
    return this.closed ?? { code: -1, reason: 'still open' }
  }

  close(): void {
    this.socket.close()
  }
}

const clients: Client[] = []
const client = (options?: { origin?: string; path?: string }) => {
  const c = new Client(options)
  clients.push(c)
  return c
}

beforeEach(async () => {
  harness = await start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.terminate()
  await harness.bridge.close()
})

describe('HTTP', () => {
  it('serves /health to scripts without CORS, with security headers', async () => {
    const reply = await call('GET', '/health')
    expect(reply.status).toBe(200)
    expect(json(reply)).toMatchObject({ ok: true, name: 'clap-bridge', protocol: PROTOCOL_VERSION, wakePhrase: 'hey clap', sessions: 0 })
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('lets only the HUD origin read responses', async () => {
    const hud = await call('GET', '/health', { origin: UI })
    expect(hud.headers['access-control-allow-origin']).toBe(UI)
    // A sandboxed frame or data: page sends "null"; it must not be able to read.
    const sandboxed = await call('GET', '/health', { origin: 'null' })
    expect(sandboxed.status).toBe(200)
    expect(sandboxed.headers['access-control-allow-origin']).toBeUndefined()
    expect((await call('GET', '/health', { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('refuses DNS-rebinding hosts', async () => {
    expect((await call('GET', '/health', { host: `attacker.example:${harness.port}` })).status).toBe(403)
  })

  it('answers preflight for the HUD and 404s unknown routes', async () => {
    const preflight = await call('OPTIONS', '/api/tts', { origin: UI })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS')
    expect((await call('GET', '/nope')).status).toBe(404)
  })

  it('requires an Origin on state-changing calls and reports missing voice', async () => {
    expect((await call('POST', '/api/tts', { 'content-type': 'application/json' }, '{"text":"hi"}')).status).toBe(403)
    const reply = await call('POST', '/api/tts', { origin: UI, 'content-type': 'application/json' }, '{"text":"hi"}')
    expect(reply.status).toBe(503)
  })
})

describe('voice proxy', () => {
  beforeEach(async () => {
    await harness.bridge.close()
    harness = await start({ voice: true })
  })

  it('streams synthesis from the upstream', async () => {
    const reply = await call('POST', '/api/tts', { origin: UI, 'content-type': 'application/json' }, '{"text":"Hello there."}')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('audio/mpeg')
    expect([...reply.body]).toEqual([7, 7, 7])
    expect(reply.headers['access-control-allow-origin']).toBe(UI)
  })

  it('validates synthesis requests', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post('{"text":"   "}')).status).toBe(400)
    expect((await post(JSON.stringify({ text: 'x'.repeat(1201) }))).status).toBe(400)
    expect((await post(JSON.stringify({ text: 'x'.repeat(20_000) }))).status).toBe(413)
    expect(harness.upstream).toEqual([])
  })

  it('transcribes audio, skipping clicks and refusing non-audio and oversized bodies', async () => {
    expect(json(await stt('audio/webm;codecs=opus', Buffer.alloc(4_000)))).toEqual({ text: 'heard 4000 bytes' })
    expect(json(await stt('audio/webm', Buffer.alloc(100)))).toEqual({ text: '' })
    expect((await stt('text/plain', Buffer.alloc(4_000))).status).toBe(415)
    expect((await stt('audio/webm', Buffer.alloc(11 * 1024 * 1024))).status).toBe(413)
    expect(harness.upstream).toHaveLength(1)
  })
})

describe('WebSocket', () => {
  it('refuses foreign origins, missing origins and other paths', async () => {
    const evil = client({ origin: 'https://evil.example' })
    await expect(evil.open()).rejects.toThrow()
    expect(evil.refused).toBe(403)
    const script = client({ origin: '' })
    await expect(script.open()).rejects.toThrow()
    expect(script.refused).toBe(403)
    const wrongPath = client({ path: '/socket' })
    await expect(wrongPath.open()).rejects.toThrow()
    expect(wrongPath.refused).toBe(404)
  })

  it('requires hello first and a matching protocol', async () => {
    const early = client()
    await early.open()
    early.send({ type: 'ping', t: 1 })
    expect(await early.next('error')).toMatchObject({ code: 'not_ready' })

    const old = client()
    await old.open()
    old.send({ type: 'hello', protocol: PROTOCOL_VERSION + 1, client: 'future' })
    expect(await old.next('error')).toMatchObject({ code: 'unsupported_protocol', recoverable: false })
    expect((await old.waitClosed()).code).toBe(1002)
  })

  it('starts a session and answers pings', async () => {
    const hud = client()
    const ready = await hud.hello()
    expect(ready).toMatchObject({ resumed: false, wakePhrase: 'hey clap', policy: { high: 'confirm' } })
    expect(ready.tools.map((t) => t.name)).toContain('get_time')
    hud.send({ type: 'ping', t: 123 })
    expect(await hud.next('pong')).toMatchObject({ t: 123 })
    expect(harness.sessions.size).toBe(1)
  })

  it('rejects malformed and binary messages without closing', async () => {
    const hud = client()
    await hud.hello()
    hud.send('{"type":"user_message","turnId":"bad id","text":"hi","source":"voice"}')
    expect(await hud.next('error')).toMatchObject({ code: 'bad_message', recoverable: true })
    hud.socket.send(Buffer.from([1, 2, 3]), { binary: true })
    expect(await hud.next('error')).toMatchObject({ code: 'bad_message' })
    hud.send({ type: 'ping', t: 1 })
    await hud.next('pong')
  })

  it('rate-limits a flood', async () => {
    const hud = client()
    await hud.hello()
    for (let i = 0; i < 120; i++) hud.send({ type: 'ping', t: i })
    expect(await hud.next('error')).toMatchObject({ code: 'rate_limited' })
    await settle()
    expect(hud.events.filter((e) => e.type === 'pong').length).toBeLessThan(60)
  })

  it('runs a turn end to end', async () => {
    const hud = client()
    await hud.hello()
    hud.send({ type: 'user_message', turnId: 'turn-1', text: 'what time is it', source: 'voice' })
    const user = await harness.sdk.last.nextUser(1_000)
    expect(user?.message).toEqual({ role: 'user', content: 'what time is it' })
    harness.sdk.last.send(frame.text('It is noon.', user!.uuid), frame.result(user!.uuid))
    expect(await hud.next('assistant_text')).toMatchObject({ turnId: 'turn-1', delta: 'It is noon.' })
    expect(await hud.next('turn_complete')).toMatchObject({ turnId: 'turn-1', text: 'It is noon.', interrupted: false })
  })

  it('resumes a session after a reload, but never shares one between tabs', async () => {
    const first = client()
    const ready = await first.hello()
    // A second tab asking for the same, still attached, session gets its own.
    const duplicate = client()
    expect(await duplicate.hello(ready.sessionId)).toMatchObject({ resumed: false })
    expect(harness.sessions.size).toBe(2)

    first.close()
    await first.waitClosed()
    await settle()
    const reloaded = client()
    expect(await reloaded.hello(ready.sessionId)).toMatchObject({ resumed: true, sessionId: ready.sessionId })
    expect(harness.sessions.size).toBe(2)
  })

  it('lets only the asking session answer a confirmation', async () => {
    const hud = client()
    await hud.hello()
    const query = harness.sdk.last
    const other = client()
    await other.hello()
    hud.send({ type: 'user_message', turnId: 'turn-1', text: 'clean up', source: 'voice' })
    await query.nextUser(1_000)
    const decision = query.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    const request = await hud.next('confirmation_request')
    expect(request).toMatchObject({ summary: 'Delete 3 files', risk: 'high' })

    // Even with the real request id, another session's answer is ignored.
    other.send({ type: 'confirmation_response', requestId: request.requestId, approved: true, via: 'click' })
    await settle()
    expect(hud.events.some((e) => e.type === 'confirmation_resolved')).toBe(false)

    hud.send({ type: 'confirmation_response', requestId: request.requestId, approved: true, via: 'key' })
    expect(await hud.next('confirmation_resolved')).toMatchObject({ approved: true, reason: 'user' })
    await expect(decision).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
  })

  it('denies a pending confirmation when the page goes away', async () => {
    const hud = client()
    await hud.hello()
    const query = harness.sdk.last
    hud.send({ type: 'user_message', turnId: 'turn-1', text: 'clean up', source: 'voice' })
    await query.nextUser(1_000)
    const decision = query.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    await hud.next('confirmation_request')
    hud.close()
    await expect(decision).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
})
