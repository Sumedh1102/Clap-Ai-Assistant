import { describe, expect, it } from 'vitest'
import { createLogger, type LogLevel } from './logger'

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: { line: string; level: LogLevel }[] = []
  const logger = createLogger({
    now: () => new Date('2026-01-02T03:04:05.678Z'),
    ...options,
    write: (line, level) => lines.push({ line, level }),
  })
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>) }
}

describe('createLogger', () => {
  it('writes one JSON object per event with bindings', () => {
    const { logger, records } = capture()
    logger.child({ component: 'ws' }).info('ws.hello', { sessionId: 's1' })
    expect(records()).toEqual([{ ts: '2026-01-02T03:04:05.678Z', level: 'info', event: 'ws.hello', component: 'ws', sessionId: 's1' }])
  })

  it('filters by level', () => {
    const { logger, lines } = capture({ level: 'warn' })
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })

  it('masks credential-looking fields but keeps numeric ones readable', () => {
    const { logger, records } = capture()
    logger.info('x', { apiKey: 'abc', headers: { authorization: 'Bearer zzz', 'xi-api-key': 'k' }, output_tokens: 812, token: 5 })
    expect(records()[0]).toMatchObject({
      apiKey: '[redacted]',
      headers: { authorization: '[redacted]', 'xi-api-key': '[redacted]' },
      output_tokens: 812,
      token: 5,
    })
  })

  it('scrubs registered secrets and well-known key shapes from every string', () => {
    const { logger, records } = capture({ secrets: ['my-long-secret-value', 'short'] })
    logger.error('upstream', {
      detail: 'failed with my-long-secret-value in the body',
      nested: ['sk-ant-api03-ABCDEFGHIJKLMNOP', 'Bearer abcdefghijklmnop.qrs'],
      error: new Error('key sk_0123456789abcdefghij0123 rejected'),
      note: 'short is too short to be treated as a secret',
    })
    const record = records()[0]!
    expect(record.detail).toBe('failed with [redacted] in the body')
    expect(record.nested).toEqual(['[redacted]', '[redacted]'])
    expect(record.error).toEqual({ name: 'Error', message: 'key [redacted] rejected' })
    expect(record.note).toBe('short is too short to be treated as a secret')
  })

  it('reduces binary data to a byte count and bounds depth and length', () => {
    const { logger, records } = capture()
    logger.info('x', {
      audio: new Uint8Array(4096),
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
      long: 'z'.repeat(2500),
    })
    const record = records()[0]!
    expect(record.audio).toBe('[4096 bytes]')
    expect(JSON.stringify(record.deep)).toContain('[…]')
    expect(String(record.long)).toMatch(/…\(2500 chars\)$/)
  })

  it('includes stacks only when asked', () => {
    const plain = capture()
    plain.logger.error('x', { error: new Error('boom') })
    expect(plain.records()[0]!.error).not.toHaveProperty('stack')
    const debug = capture({ stacks: true })
    debug.logger.error('x', { error: new Error('boom') })
    expect(debug.records()[0]!.error).toHaveProperty('stack')
  })

  it('times operations and logs failures as warnings', () => {
    const { logger, records, lines } = capture()
    logger.time('tool.execute', { tool: 'get_time' }).end(false, { error: new Error('nope') })
    expect(lines[0]!.level).toBe('warn')
    expect(records()[0]).toMatchObject({ event: 'tool.execute', tool: 'get_time', ok: false, error: { message: 'nope' } })
    expect(typeof records()[0]!.durationMs).toBe('number')
  })

  it('renders a readable line in pretty mode', () => {
    const { logger, lines } = capture({ format: 'pretty' })
    logger.child({ component: 'agent' }).info('turn.complete', { sessionId: '0123456789abcdef', ok: true, durationMs: 1234, note: 'two words' })
    expect(lines[0]!.line).toBe('03:04:05.678  INFO   agent       turn.complete  ok  1234ms  sessionId=01234567  note="two words"')
  })
})
