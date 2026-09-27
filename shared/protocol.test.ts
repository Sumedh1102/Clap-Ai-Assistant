import { describe, expect, it } from 'vitest'
import { MAX_USER_TEXT_CHARS, PROTOCOL_VERSION } from './defaults'
import { parseBridgeEvent, parseClientMessage } from './protocol'

const json = (value: unknown) => JSON.stringify(value)

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage(json({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'clap-hud' }))).toMatchObject({ ok: true })
    expect(parseClientMessage(json({ type: 'user_message', turnId: 't-1', text: '  what time is it  ', source: 'voice' }))).toEqual({
      ok: true,
      value: { type: 'user_message', turnId: 't-1', text: 'what time is it', source: 'voice' },
    })
    expect(parseClientMessage(json({ type: 'confirmation_response', requestId: 'r_1', approved: true, via: 'key' }))).toMatchObject({
      ok: true,
    })
  })

  it('accepts any protocol number in hello so a mismatch can be reported specifically', () => {
    expect(parseClientMessage(json({ type: 'hello', protocol: 99, client: 'future' }))).toMatchObject({ ok: true })
  })

  it('rejects malformed input with a short reason', () => {
    expect(parseClientMessage('{not json')).toEqual({ ok: false, error: 'not valid JSON' })
    expect(parseClientMessage(json({ type: 'launch_missiles' }))).toMatchObject({ ok: false })
    expect(parseClientMessage(json({ type: 'user_message', turnId: 't1', text: '   ', source: 'voice' }))).toMatchObject({ ok: false })
    expect(
      parseClientMessage(json({ type: 'user_message', turnId: 't1', text: 'x'.repeat(MAX_USER_TEXT_CHARS + 1), source: 'text' })),
    ).toMatchObject({ ok: false })
    const bad = parseClientMessage(json({ type: 'user_message', turnId: 't1', text: 'hi', source: 'telepathy' }))
    expect(!bad.ok && bad.error).toMatch(/^source: /)
  })

  it('refuses free-text ids', () => {
    for (const turnId of ['', 'has space', '../../etc', 'x'.repeat(101), 'emoji😀']) {
      expect(parseClientMessage(json({ type: 'user_message', turnId, text: 'hi', source: 'text' })).ok).toBe(false)
    }
    expect(parseClientMessage(json({ type: 'hello', protocol: 1, client: 'x', resumeSessionId: 'a b' })).ok).toBe(false)
  })

  it('rejects non-finite and negative numbers', () => {
    expect(parseClientMessage('{"type":"ping","t":-1}').ok).toBe(false)
    expect(parseClientMessage('{"type":"ping","t":1e400}').ok).toBe(false)
  })
})

describe('parseBridgeEvent', () => {
  it('accepts well-formed events', () => {
    expect(
      parseBridgeEvent(
        json({ type: 'turn_complete', turnId: 't1', text: 'It is noon.', interrupted: false, durationMs: 1200 }),
      ),
    ).toMatchObject({ ok: true })
    expect(parseBridgeEvent(json({ type: 'error', code: 'rate_limited', message: 'Slow down.', recoverable: true }))).toMatchObject({
      ok: true,
    })
  })

  it('only accepts a session_ready for this protocol version', () => {
    const ready = {
      type: 'session_ready',
      protocol: PROTOCOL_VERSION,
      sessionId: 's1',
      resumed: false,
      bridgeVersion: '0.1.0',
      model: 'claude',
      capabilities: { stt: { cloud: false, provider: null }, tts: { cloud: false, provider: null, customVoice: false } },
      tools: [],
      wakePhrase: 'hey clap',
      policy: { low: 'allow', medium: 'allow', high: 'confirm' },
    }
    expect(parseBridgeEvent(json(ready)).ok).toBe(true)
    expect(parseBridgeEvent(json({ ...ready, protocol: PROTOCOL_VERSION + 1 })).ok).toBe(false)
    expect(parseBridgeEvent(json({ ...ready, policy: { ...ready.policy, high: 'allow' } })).ok).toBe(false)
  })

  it('rejects unknown error codes and empty messages', () => {
    expect(parseBridgeEvent(json({ type: 'error', code: 'teapot', message: 'x', recoverable: true })).ok).toBe(false)
    expect(parseBridgeEvent(json({ type: 'error', code: 'internal', message: '', recoverable: true })).ok).toBe(false)
  })
})
