import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DEFAULT_RISK_POLICY, type RiskPolicy } from '../../shared/risk'
import { silentLogger } from '../logger'
import { cleanSummary, defineTool, ToolFailure, ToolRegistry, userSafeMessage, type ToolContext } from './registry'

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  sessionId: 's1',
  turnId: 't1',
  signal,
  logger: silentLogger,
})

const echo = defineTool({
  name: 'echo',
  label: 'Echo',
  description: 'Echo the input.',
  category: 'system',
  risk: 'low',
  inputSchema: { text: z.string().max(10) },
  summarize: ({ text }) => `Echoing ${text}`,
  handler: async ({ text }) => ({ text }),
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ToolRegistry.register', () => {
  it('rejects malformed and duplicate names', () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY)
    expect(() => registry.register({ ...echo, name: 'Echo' })).toThrow(/invalid tool name/)
    expect(() => registry.register({ ...echo, name: 'mcp__x' })).not.toThrow()
    registry.register(echo)
    expect(() => registry.register(echo)).toThrow(/registered twice/)
  })

  it('forces confirmation for high risk whatever the definition says', () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY)
      .register({ ...echo, name: 'wipe', risk: 'high', requiresConfirmation: false })
      .registerBuiltin({ name: 'Danger', label: 'Danger', category: 'system', risk: 'high', requiresConfirmation: false })
    expect(registry.list().map((t) => [t.name, t.requiresConfirmation])).toEqual([
      ['Danger', true],
      ['wipe', true],
    ])
  })
})

describe('summaries', () => {
  it('fall back to the label on bad input or a throwing summarizer', () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY)
      .register(echo)
      .register({
        ...echo,
        name: 'broken',
        summarize: () => {
          throw new Error('boom')
        },
      })
    expect(registry.get('echo')!.summarize({ text: 'hi' })).toBe('Echoing hi')
    expect(registry.get('echo')!.summarize({ text: 42 })).toBe('Echo')
    expect(registry.get('broken')!.summarize({ text: 'hi' })).toBe('Echo')
  })

  it('strip control characters and bound the length', () => {
    expect(cleanSummary('a\u0000b\nc\u001b[31m  d')).toBe('a b c [31m d')
    const long = cleanSummary('x'.repeat(500))
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('ToolRegistry.execute', () => {
  it('validates input and returns the output', async () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register(echo)
    await expect(registry.execute('echo', { text: 'hello' }, ctx())).resolves.toEqual({ ok: true, output: { text: 'hello' } })
    const bad = await registry.execute('echo', { text: 'far too long for this' }, ctx())
    expect(bad).toMatchObject({ ok: false })
    expect(!bad.ok && bad.error).toMatch(/^The request for Echo was invalid \(text: /)
  })

  it('strips unknown keys instead of refusing the call', async () => {
    const seen: unknown[] = []
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register({
      ...echo,
      handler: async (input) => {
        seen.push(input)
        return { text: 'ok' }
      },
    })
    await registry.execute('echo', { text: 'hi', extra: true }, ctx())
    expect(seen).toEqual([{ text: 'hi' }])
  })

  it('refuses unknown tools and tools the policy denies', async () => {
    const policy: RiskPolicy = { low: 'deny', medium: 'allow', high: 'confirm' }
    const registry = new ToolRegistry(policy).register(echo)
    await expect(registry.execute('nope', {}, ctx())).resolves.toEqual({ ok: false, error: 'That tool does not exist.' })
    await expect(registry.execute('echo', { text: 'hi' }, ctx())).resolves.toEqual({
      ok: false,
      error: 'Echo is disabled by the permission policy.',
    })
  })

  it('passes user-safe failures through and hides everything else', async () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY)
      .register({
        ...echo,
        name: 'safe',
        handler: async () => {
          throw new ToolFailure('That file is locked.')
        },
      })
      .register({
        ...echo,
        name: 'leaky',
        handler: async () => {
          throw new Error('ENOENT /home/someone/.secret')
        },
      })
    await expect(registry.execute('safe', { text: 'x' }, ctx())).resolves.toEqual({ ok: false, error: 'That file is locked.' })
    await expect(registry.execute('leaky', { text: 'x' }, ctx())).resolves.toEqual({
      ok: false,
      error: 'Echo failed unexpectedly.',
    })
  })

  it('truncates long output', async () => {
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register({
      ...echo,
      handler: async () => ({ text: 'y'.repeat(30_000) }),
    })
    const result = await registry.execute('echo', { text: 'x' }, ctx())
    expect(result.ok && result.output.text.endsWith('[output truncated]')).toBe(true)
    expect(result.ok && result.output.text.length).toBeLessThan(24_100)
  })

  it('stops a tool that runs past its timeout', async () => {
    vi.useFakeTimers()
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register({
      ...echo,
      timeoutMs: 1_000,
      handler: () => new Promise(() => {}),
    })
    const pending = registry.execute('echo', { text: 'x' }, ctx())
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toEqual({ ok: false, error: 'Echo took too long and was stopped.' })
  })

  it('reports cancellation when the turn is interrupted mid-call', async () => {
    const turn = new AbortController()
    let toolSignal: AbortSignal | undefined
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register({
      ...echo,
      handler: (_, c) => {
        toolSignal = c.signal
        return new Promise(() => {})
      },
    })
    const pending = registry.execute('echo', { text: 'x' }, ctx(turn.signal))
    turn.abort()
    await expect(pending).resolves.toEqual({ ok: false, error: 'Echo was cancelled.' })
    expect(toolSignal?.aborted).toBe(true)
  })

  it('does not start a tool for a turn that was already interrupted', async () => {
    const run = vi.fn(() => new Promise<never>(() => {}))
    const registry = new ToolRegistry(DEFAULT_RISK_POLICY).register({ ...echo, handler: run })
    await expect(registry.execute('echo', { text: 'x' }, ctx(AbortSignal.abort()))).resolves.toEqual({
      ok: false,
      error: 'Echo was cancelled.',
    })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('userSafeMessage', () => {
  it('only trusts errors marked user-safe', () => {
    expect(userSafeMessage(new ToolFailure('fine'))).toBe('fine')
    expect(userSafeMessage(new Error('internal'))).toBeNull()
    expect(userSafeMessage('string')).toBeNull()
  })
})
