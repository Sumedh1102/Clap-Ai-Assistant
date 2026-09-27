import { describe, expect, it } from 'vitest'
import { allowedOrigin, checkHost, checkOrigin, corsHeaders, guardRequest, headerValue, type HttpGuardConfig } from './http-guard'

const config: HttpGuardConfig = {
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  allowedHosts: ['127.0.0.1:7719', 'localhost:7719', '[::1]:7719'],
  allowNoOrigin: false,
}

const req = (headers: Record<string, string | string[]>) => ({ headers })

describe('checkHost', () => {
  it('accepts loopback names on the bridge port, case-insensitively', () => {
    expect(checkHost('127.0.0.1:7719', config)).toEqual({ ok: true })
    expect(checkHost('LocalHost:7719', config)).toEqual({ ok: true })
    expect(checkHost('[::1]:7719', config)).toEqual({ ok: true })
  })

  it('refuses rebinding hosts, other ports and a missing header', () => {
    expect(checkHost('attacker.example:7719', config)).toMatchObject({ ok: false, status: 403 })
    expect(checkHost('127.0.0.1:80', config)).toMatchObject({ ok: false, status: 403 })
    expect(checkHost('127.0.0.1', config)).toMatchObject({ ok: false, status: 403 })
    expect(checkHost(undefined, config)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('checkOrigin', () => {
  it('accepts exactly the allowlisted origins', () => {
    expect(checkOrigin('http://localhost:5173', config, true)).toEqual({ ok: true })
    expect(checkOrigin('http://localhost:5173/', config, true)).toEqual({ ok: true })
    expect(checkOrigin('http://localhost:5174', config, true)).toMatchObject({ ok: false })
    expect(checkOrigin('https://localhost:5173', config, true)).toMatchObject({ ok: false })
    expect(checkOrigin('http://localhost:5173.evil.example', config, true)).toMatchObject({ ok: false })
    // A foreign origin is refused even where an Origin is not required.
    expect(checkOrigin('https://evil.example', config, false)).toMatchObject({ ok: false, status: 403 })
  })

  it('treats a missing or "null" origin as a non-browser client', () => {
    expect(checkOrigin(undefined, config, true)).toMatchObject({ ok: false, reason: 'missing Origin' })
    expect(checkOrigin('null', config, true)).toMatchObject({ ok: false, reason: 'missing Origin' })
    expect(checkOrigin(undefined, config, false)).toEqual({ ok: true })
    expect(checkOrigin(undefined, { ...config, allowNoOrigin: true }, true)).toEqual({ ok: true })
  })
})

describe('guardRequest', () => {
  it('checks the host first, then the origin', () => {
    expect(guardRequest(req({ host: 'evil.example:7719', origin: 'http://localhost:5173' }), config, true)).toMatchObject({
      ok: false,
      reason: 'host evil.example:7719 not allowed',
    })
    expect(guardRequest(req({ host: '127.0.0.1:7719', origin: 'https://evil.example' }), config, true)).toMatchObject({
      ok: false,
      reason: 'origin https://evil.example not allowed',
    })
    expect(guardRequest(req({ host: '127.0.0.1:7719', origin: 'http://localhost:5173' }), config, true)).toEqual({ ok: true })
  })
})

describe('CORS', () => {
  it('reflects only allowlisted origins, never a wildcard or "null"', () => {
    expect(allowedOrigin('http://localhost:5173', config)).toBe('http://localhost:5173')
    expect(allowedOrigin('null', config)).toBeUndefined()
    expect(allowedOrigin('https://evil.example', config)).toBeUndefined()
    expect(allowedOrigin(undefined, config)).toBeUndefined()

    expect(corsHeaders('http://localhost:5173')).toMatchObject({ 'access-control-allow-origin': 'http://localhost:5173', vary: 'origin' })
    expect(corsHeaders(undefined)).toEqual({ vary: 'origin' })
  })

  it('takes the first value of a repeated header', () => {
    expect(headerValue(['a', 'b'])).toBe('a')
    expect(headerValue('a')).toBe('a')
    expect(headerValue(undefined)).toBeUndefined()
  })
})
