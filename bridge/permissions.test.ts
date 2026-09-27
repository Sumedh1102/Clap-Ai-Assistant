import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DEFAULT_RISK_POLICY, type RiskLevel, type RiskPolicy } from '../shared/risk'
import { ConfirmationBroker, PermissionGate } from './permissions'
import { defineTool, sdkToolName, ToolRegistry, type ToolMeta } from './tools/registry'

const SDK = { name: 'clap', source: 'sdk' }

function tool(name: string, risk: RiskLevel, requiresConfirmation = false) {
  return defineTool({
    name,
    label: `Label ${name}`,
    description: 'test tool',
    category: 'system',
    risk,
    requiresConfirmation,
    inputSchema: { path: z.string().optional() },
    summarize: ({ path }) => (path ? `Touching ${path}` : 'Touching nothing'),
    handler: async () => ({ text: 'ok' }),
  })
}

function registry(policy: RiskPolicy = DEFAULT_RISK_POLICY): ToolRegistry {
  return new ToolRegistry(policy)
    .register(tool('read_thing', 'low'))
    .register(tool('edit_thing', 'medium'))
    .register(tool('careful_thing', 'medium', true))
    .register(tool('delete_thing', 'high'))
    .registerBuiltin({ name: 'WebSearch', label: 'Web search', category: 'web', risk: 'low', requiresConfirmation: false })
}

describe('PermissionGate', () => {
  it('allows low and medium risk under the default policy', () => {
    const gate = new PermissionGate(registry(), DEFAULT_RISK_POLICY)
    expect(gate.decide(sdkToolName('read_thing'), {}, SDK)).toMatchObject({ action: 'allow', summary: 'Touching nothing' })
    expect(gate.decide(sdkToolName('edit_thing'), { path: 'a.txt' }, SDK)).toMatchObject({
      action: 'allow',
      summary: 'Touching a.txt',
    })
  })

  it('always confirms high risk and tools that require confirmation', () => {
    const gate = new PermissionGate(registry(), DEFAULT_RISK_POLICY)
    expect(gate.decide(sdkToolName('delete_thing'), {}, SDK).action).toBe('confirm')
    expect(gate.decide(sdkToolName('careful_thing'), {}, SDK).action).toBe('confirm')
  })

  it('confirms high risk even if a policy object claims "allow"', () => {
    // RiskPolicy's type forbids this; the gate must not depend on the type alone.
    const policy = { low: 'allow', medium: 'allow', high: 'allow' } as unknown as RiskPolicy
    const gate = new PermissionGate(registry(policy), policy)
    expect(gate.decide(sdkToolName('delete_thing'), {}, SDK).action).toBe('confirm')
  })

  it('applies confirm and deny policies per level', () => {
    const policy: RiskPolicy = { low: 'allow', medium: 'confirm', high: 'deny' }
    const gate = new PermissionGate(registry(policy), policy)
    expect(gate.decide(sdkToolName('edit_thing'), {}, SDK).action).toBe('confirm')
    const denied = gate.decide(sdkToolName('delete_thing'), {}, SDK)
    expect(denied).toMatchObject({ action: 'deny', reason: 'Label delete_thing is turned off by the permission policy.' })
  })

  it('denies tools it does not know', () => {
    const gate = new PermissionGate(registry(), DEFAULT_RISK_POLICY)
    expect(gate.decide('Bash', { command: 'rm -rf /' })).toMatchObject({ action: 'deny', tool: null })
    expect(gate.decide(sdkToolName('nope'), {}, SDK)).toMatchObject({ action: 'deny', tool: null })
  })

  it('keys trust on provenance, not on the tool name', () => {
    const gate = new PermissionGate(registry(), DEFAULT_RISK_POLICY)
    // A configured MCP server that also calls itself "clap".
    expect(gate.decide(sdkToolName('read_thing'), {}, { name: 'clap', source: 'user' }).action).toBe('deny')
    // The in-process source, but another server's name.
    expect(gate.decide('mcp__other__read_thing', {}, { name: 'other', source: 'sdk' }).action).toBe('deny')
    // An MCP-style name with no provenance at all.
    expect(gate.decide(sdkToolName('read_thing'), {}).action).toBe('deny')
    // A built-in name that arrives with MCP provenance is not the built-in.
    expect(gate.decide('WebSearch', {}, SDK).action).toBe('deny')
    expect(gate.decide('WebSearch', { query: 'weather' }).action).toBe('allow')
  })

  it('bounds the summary of an unknown tool name', () => {
    const gate = new PermissionGate(registry(), DEFAULT_RISK_POLICY)
    expect(gate.decide('x'.repeat(500), {}).summary).toHaveLength(120)
  })
})

describe('ConfirmationBroker', () => {
  const meta: ToolMeta = {
    name: 'delete_thing',
    label: 'Delete',
    category: 'files',
    risk: 'high',
    requiresConfirmation: true,
    summarize: () => 'Delete 3 files',
  }

  let ids = 0
  const newBroker = () => new ConfirmationBroker({ timeoutMs: 5_000, newId: () => `req-${++ids}`, now: () => 1_000 })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces a request and resolves with the user answer', async () => {
    const broker = newBroker()
    const sent: unknown[] = []
    const outcome = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: 'Delete 3 files', send: (e) => sent.push(e) })
    const request = sent[0] as { type: string; requestId: string; expiresAt: number }
    expect(request).toMatchObject({ type: 'confirmation_request', turnId: 't1', risk: 'high', summary: 'Delete 3 files', expiresAt: 6_000 })

    expect(broker.respond('s1', request.requestId, true)).toBe('accepted')
    await expect(outcome).resolves.toEqual({ approved: true, reason: 'user' })
    expect(sent[1]).toMatchObject({ type: 'confirmation_resolved', requestId: request.requestId, approved: true, reason: 'user' })
    expect(broker.pendingCount()).toBe(0)
  })

  it('answers each request at most once', async () => {
    const broker = newBroker()
    const sent: { requestId?: string }[] = []
    const outcome = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', send: (e) => sent.push(e) })
    const id = sent[0]!.requestId!
    expect(broker.respond('s1', id, false)).toBe('accepted')
    expect(broker.respond('s1', id, true)).toBe('unknown')
    await expect(outcome).resolves.toEqual({ approved: false, reason: 'user' })
    expect(sent).toHaveLength(2)
  })

  it('refuses an answer from another session', async () => {
    const broker = newBroker()
    const sent: { requestId?: string }[] = []
    const outcome = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', send: (e) => sent.push(e) })
    const id = sent[0]!.requestId!
    expect(broker.respond('s2', id, true)).toBe('wrong_session')
    expect(broker.pendingCount('s1')).toBe(1)
    broker.respond('s1', id, false)
    await expect(outcome).resolves.toMatchObject({ approved: false })
  })

  it('denies on timeout', async () => {
    const broker = newBroker()
    const sent: unknown[] = []
    const outcome = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', send: (e) => sent.push(e) })
    vi.advanceTimersByTime(5_000)
    await expect(outcome).resolves.toEqual({ approved: false, reason: 'timeout' })
    expect(sent[1]).toMatchObject({ type: 'confirmation_resolved', approved: false, reason: 'timeout' })
  })

  it('denies when the turn is aborted, before or during the wait', async () => {
    const broker = newBroker()
    const during = new AbortController()
    const outcome = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', signal: during.signal, send: () => {} })
    during.abort()
    await expect(outcome).resolves.toEqual({ approved: false, reason: 'cancelled' })

    const sent: { type: string }[] = []
    const before = AbortSignal.abort()
    const early = broker.request({ sessionId: 's1', turnId: 't2', tool: meta, summary: '', signal: before, send: (e) => sent.push(e) })
    await expect(early).resolves.toEqual({ approved: false, reason: 'cancelled' })
    // Nothing is asked that was never going to be answerable.
    expect(sent.map((e) => e.type)).not.toContain('confirmation_request')
    expect(broker.pendingCount()).toBe(0)
  })

  it('cancels everything a session is waiting on, and nothing else', async () => {
    const broker = newBroker()
    const a = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', send: () => {} })
    const b = broker.request({ sessionId: 's1', turnId: 't1', tool: meta, summary: '', send: () => {} })
    const other = broker.request({ sessionId: 's2', turnId: 't9', tool: meta, summary: '', send: () => {} })
    expect(broker.cancelSession('s1')).toBe(2)
    await expect(a).resolves.toEqual({ approved: false, reason: 'cancelled' })
    await expect(b).resolves.toEqual({ approved: false, reason: 'cancelled' })
    expect(broker.pendingCount('s2')).toBe(1)
    broker.cancelSession('s2')
    await other
  })
})
