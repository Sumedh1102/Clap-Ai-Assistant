import { describe, expect, it } from 'vitest'
import { RESTART_CODE, RESTART_LIMIT, shouldRestart } from '../start'
import { parseConfig } from '../../bridge/config'
import { checkConfig, checkNode, checkVoice, failed, findClaudeBinary, formatChecks, parseAuthStatus, portFree } from './checks'

describe('checkNode', () => {
  it('requires Node 20.11 or newer', () => {
    expect(checkNode('20.11.0').status).toBe('ok')
    expect(checkNode('22.1.0').status).toBe('ok')
    expect(checkNode('20.10.9')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/20\.11/) })
    expect(checkNode('18.19.0').status).toBe('fail')
  })
})

describe('parseAuthStatus', () => {
  it('reads claude auth status --json', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token"}')).toEqual({ loggedIn: true, method: 'oauth_token' })
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, method: null })
    expect(parseAuthStatus('Not logged in')).toEqual({ loggedIn: false, method: null })
  })
})

describe('checkConfig', () => {
  it('uses the bridge parser and lists every problem', () => {
    expect(checkConfig({}).check.status).toBe('ok')
    const bad = checkConfig({ CLAP_POLICY_HIGH: 'allow', CLAP_UI_PORT: 'x' })
    expect(bad.config).toBeNull()
    expect(bad.check.status).toBe('fail')
    expect(bad.check.detail.split('\n')).toHaveLength(2)
  })
})

describe('findClaudeBinary', () => {
  it('finds nothing for a platform without a package', () => {
    expect(findClaudeBinary('plan9', 'x64')).toBeNull()
  })
})

describe('portFree', () => {
  it('reports a port in use', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    expect(await portFree('127.0.0.1', port)).toBe(false)
    await new Promise((resolve) => server.close(resolve))
    expect(await portFree('127.0.0.1', port)).toBe(true)
  })
})

describe('formatChecks', () => {
  it('marks each check and shows fixes only for problems', () => {
    const text = formatChecks([
      { name: 'A', status: 'ok', detail: 'fine', fix: 'never shown' },
      { name: 'B', status: 'warn', detail: 'hmm', fix: 'maybe do this' },
      { name: 'C', status: 'fail', detail: 'line one\nline two', fix: 'do that' },
    ])
    expect(text).toBe(
      ['  ✓ A: fine', '  ! B: hmm', '      → maybe do this', '  ✗ C: line one', '      line two', '      → do that'].join('\n'),
    )
    expect(failed([{ name: 'x', status: 'warn', detail: '' }])).toBe(false)
  })
})

describe('shouldRestart', () => {
  it('restarts only a bridge that asked for it, a few times a minute', () => {
    expect(shouldRestart(0, [], 0)).toBe(false)
    expect(shouldRestart(1, [], 0)).toBe(false)
    expect(shouldRestart(null, [], 0)).toBe(false)
    const now = 1_000_000
    const recent = Array.from({ length: RESTART_LIMIT.count }, (_, i) => now - i * 1_000)
    expect(shouldRestart(RESTART_CODE, recent.slice(1), now)).toBe(true)
    expect(shouldRestart(RESTART_CODE, recent, now)).toBe(false)
    expect(shouldRestart(RESTART_CODE, recent.map((t) => t - RESTART_LIMIT.windowMs), now)).toBe(true)
  })
})

const keyed = (env: NodeJS.ProcessEnv = {}) => parseConfig({ ELEVENLABS_API_KEY: 'sk_test_0123456789', ...env })

describe('checkVoice', () => {
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request) => {
      calls.push(String(url))
      return status === 200 ? Response.json(body) : new Response(String(body), { status })
    }) as typeof fetch
  let calls: string[] = []

  it('warns, without a network call, when there is no key', async () => {
    calls = []
    expect(await checkVoice(parseConfig({}), answer(200, {}))).toMatchObject({ status: 'warn', detail: 'browser voice and recognition only' })
    expect(calls).toEqual([])
  })

  it('confirms the configured voice by name', async () => {
    calls = []
    const check = await checkVoice(keyed({ CLAP_VOICE_ID: 'Dominic0001' }), answer(200, { name: 'Dominic' }))
    expect(check).toEqual({ name: 'Voice', status: 'ok', detail: 'cloud voice "Dominic", cloud transcription' })
    expect(calls).toEqual(['https://api.elevenlabs.io/v1/voices/Dominic0001'])
  })

  it('points at the stock voice until CLAP_VOICE_ID is set', async () => {
    const check = await checkVoice(keyed({ CLAP_STT_PROVIDER: 'none' }), answer(200, { name: 'George' }))
    expect(check.detail).toBe('cloud voice "George" (stock; set CLAP_VOICE_ID), browser transcription')
  })

  it('explains a missing voice, a bad key and a blocked network', async () => {
    const missing = await checkVoice(keyed({ CLAP_VOICE_ID: 'Gone00000001' }), answer(404, 'voice_not_found'))
    expect(missing).toMatchObject({ status: 'warn', fix: 'Run npm run voice:find -- dominic --use 1.' })
    expect(missing.detail).toMatch(/Gone00000001 is not in this ElevenLabs account/)
    expect((await checkVoice(keyed(), answer(401, 'bad key'))).detail).toMatch(/rejected the API key/)
    const blocked = await checkVoice(keyed(), answer(403, 'Host not in allowlist: api.elevenlabs.io'))
    expect(blocked.detail).toMatch(/403: Host not in allowlist/)
    expect(blocked.status).toBe('warn')
  })
})
