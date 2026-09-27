import { describe, expect, it } from 'vitest'
import { silentLogger } from '../logger'
import { createToolRegistry } from '.'
import { DEFAULT_RISK_POLICY } from '../../shared/risk'

const ctx = { sessionId: 's1', turnId: 't1', signal: new AbortController().signal, logger: silentLogger }
const registry = createToolRegistry({ policy: DEFAULT_RISK_POLICY, enableWebSearch: true })

describe('get_time', () => {
  it('reports the time in a named zone', async () => {
    const result = await registry.execute('get_time', { timezone: 'Asia/Tokyo' }, ctx)
    expect(result.ok && result.output.text).toMatch(/time zone Asia\/Tokyo; ISO \d{4}-\d{2}-\d{2}T/)
  })

  it('says so when the zone is unknown', async () => {
    await expect(registry.execute('get_time', { timezone: 'Mars/Olympus' }, ctx)).resolves.toEqual({
      ok: false,
      error: '"Mars/Olympus" is not a time zone I recognise.',
    })
  })
})

describe('system_info', () => {
  it('describes the machine', async () => {
    const result = await registry.execute('system_info', {}, ctx)
    expect(result.ok && result.output.text).toMatch(/^Operating system: .+\nUptime: .+\nMemory: .+ used of .+/)
  })
})

describe('createToolRegistry', () => {
  it('registers only low-risk read tools in this phase, and WebSearch on request', () => {
    expect(registry.list().map((t) => [t.name, t.risk])).toEqual([
      ['WebSearch', 'low'],
      ['get_time', 'low'],
      ['system_info', 'low'],
      ['web_fetch', 'low'],
    ])
    expect(createToolRegistry({ policy: DEFAULT_RISK_POLICY, enableWebSearch: false }).builtinNames()).toEqual([])
  })

  it('refuses web_fetch of a private address before any socket opens', async () => {
    const result = await registry.execute('web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' }, ctx)
    expect(result).toEqual({ ok: false, error: 'That address is on a private or local network, which CLAP does not fetch.' })
  })
})
