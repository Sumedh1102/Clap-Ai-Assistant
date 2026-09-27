import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BridgeEvent } from '../../shared/protocol'
import { agentEnvironment, parseConfig } from '../config'
import { silentLogger } from '../logger'
import { ConfirmationBroker, PermissionGate } from '../permissions'
import { createToolRegistry } from '../tools'
import { defineTool, sdkToolName } from '../tools/registry'
import { CLAP_PROVENANCE, FakeSdk, frame, settle } from '../testing/fake-sdk'
import { AgentSession, describeFailure } from './runtime'

const deleteFiles = defineTool({
  name: 'delete_files',
  label: 'Delete files',
  description: 'test',
  category: 'files',
  risk: 'high',
  inputSchema: { count: z.number() },
  summarize: ({ count }) => `Delete ${count} files`,
  handler: async () => ({ text: 'deleted' }),
})

const sessions: AgentSession[] = []

function setup(options: { settleCapMs?: number; confirmTimeoutMs?: number } = {}) {
  const config = parseConfig({ CLAP_LOG_FORMAT: 'json', ELEVENLABS_API_KEY: 'sk_should_not_leak_0000' })
  const registry = createToolRegistry(config).register(deleteFiles)
  const broker = new ConfirmationBroker({ timeoutMs: options.confirmTimeoutMs ?? 5_000 })
  const sdk = new FakeSdk()
  const events: BridgeEvent[] = []
  const session = new AgentSession({
    id: 'session-1',
    config,
    registry,
    gate: new PermissionGate(registry, config.policy),
    broker,
    logger: silentLogger,
    systemPrompt: 'You are CLAP.',
    queryFn: sdk.queryFn,
    settleCapMs: options.settleCapMs ?? 1_000,
    agentEnv: agentEnvironment({ PATH: '/usr/bin', ELEVENLABS_API_KEY: 'sk_should_not_leak_0000' }),
  })
  session.attach((event) => events.push(event))
  sessions.push(session)
  const of = <T extends BridgeEvent['type']>(type: T) => events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type)
  return { session, sdk, events, broker, of }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
})

describe('SDK options', () => {
  it('starts Claude Code locked down, before the first message', async () => {
    const { session, sdk } = setup()
    session.warmUp()
    const { options } = sdk.last
    expect(options.tools).toEqual(['WebSearch'])
    expect(options.allowedTools).toEqual([])
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'Task', 'Skill']))
    expect(options.disallowedTools).not.toContain('WebSearch')
    expect(options.permissionMode).toBe('default')
    expect(options.strictMcpConfig).toBe(true)
    expect(options.settingSources).toEqual([])
    expect(options.persistSession).toBe(false)
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['clap'])
    expect(options.canUseTool).toBeTypeOf('function')
    expect(options.hooks?.PreToolUse).toHaveLength(1)
    expect(options.env?.ELEVENLABS_API_KEY).toBeUndefined()
    expect(options.model).toBe('claude-opus-5')
    expect(options.fallbackModel).toBe('claude-opus-4-8')
    expect(options.env?.PATH).toBe('/usr/bin')
    // Only one Claude Code process per session.
    session.warmUp()
    await settle()
    expect(sdk.queries).toHaveLength(1)
  })
})

describe('a turn', () => {
  it('streams the answer and completes', async () => {
    const { session, sdk, events } = setup()
    session.submit('t1', 'what time is it', 'voice')
    const user = await sdk.last.nextUser()
    expect(user?.message).toEqual({ role: 'user', content: 'what time is it' })
    sdk.last.send(frame.text('It is ', user!.uuid), frame.text('noon.'), frame.result(user!.uuid, { result: 'It is noon.' }))
    await settle()
    expect(events.map((e) => [e.type, 'activity' in e ? e.activity : 'delta' in e ? e.delta : 'text' in e ? e.text : ''])).toEqual([
      ['state_change', 'thinking'],
      ['state_change', 'responding'],
      ['assistant_text', 'It is '],
      ['assistant_text', 'noon.'],
      ['turn_complete', 'It is noon.'],
      ['state_change', 'idle'],
    ])
    expect(events[4]).toMatchObject({ turnId: 't1', interrupted: false })
    expect(session.isBusy).toBe(false)
  })

  it('separates text blocks so sentences do not fuse', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'hi', 'text')
    const user = await sdk.last.nextUser()
    sdk.last.send(frame.text('Let me check.', user!.uuid), frame.blockStop(), frame.text('It is noon.'), frame.result(user!.uuid))
    await settle()
    expect(of('turn_complete')[0]?.text).toBe('Let me check.\n\nIt is noon.')
  })

  it('uses the result text when nothing was streamed', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'hi', 'text')
    const user = await sdk.last.nextUser()
    sdk.last.send(frame.result(user!.uuid, { result: 'Hello.' }))
    await settle()
    expect(of('assistant_text').map((e) => e.delta)).toEqual(['Hello.'])
    expect(of('turn_complete')[0]?.text).toBe('Hello.')
  })
})

describe('interrupts', () => {
  it('ends an interrupted turn as interrupted, not as an error, and drops its late text', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'tell me a story', 'voice')
    const user = await sdk.last.nextUser()
    sdk.last.send(frame.text('Once upon', user!.uuid))
    await settle()
    session.interrupt('barge_in')
    expect(sdk.last.interrupts).toBe(1)
    sdk.last.send(frame.text(' a time'), frame.result(user!.uuid, { subtype: 'error_during_execution' }))
    await settle()
    expect(of('assistant_text').map((e) => e.delta)).toEqual(['Once upon'])
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', interrupted: true, text: 'Once upon' })])
    expect(of('error')).toEqual([])
  })

  it('holds the next message until the interrupted turn settles', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'first', 'voice')
    const first = await sdk.last.nextUser()
    session.submit('t2', 'second', 'voice')
    // Delivered now, it would be folded into the old turn.
    expect(await sdk.last.nextUser(50)).toBeNull()
    sdk.last.send(frame.result(first!.uuid))
    const second = await sdk.last.nextUser()
    expect(second?.message).toEqual({ role: 'user', content: 'second' })
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', interrupted: true })])

    sdk.last.send(frame.text('Second answer.', second!.uuid), frame.result(second!.uuid))
    await settle()
    expect(of('turn_complete')[1]).toMatchObject({ turnId: 't2', interrupted: false, text: 'Second answer.' })
  })

  it('reports a superseded message that was never sent as interrupted', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'first', 'voice')
    await sdk.last.nextUser()
    session.submit('t2', 'second', 'voice')
    session.submit('t3', 'third', 'voice')
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't2', interrupted: true, durationMs: 0 })])
  })

  it('stops waiting after the settle cap, and a late result cannot end the next turn', async () => {
    const { session, sdk, of } = setup({ settleCapMs: 40 })
    session.submit('t1', 'first', 'voice')
    const first = await sdk.last.nextUser()
    session.submit('t2', 'second', 'voice')
    const second = await sdk.last.nextUser(500)
    expect(second?.message).toEqual({ role: 'user', content: 'second' })
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', interrupted: true })])

    // The old turn's result finally arrives, stamped with its own uuid.
    sdk.last.send(frame.result(first!.uuid, { subtype: 'error_during_execution' }))
    await settle()
    expect(of('turn_complete')).toHaveLength(1)

    sdk.last.send(frame.text('Second answer.', second!.uuid), frame.result(second!.uuid))
    await settle()
    expect(of('turn_complete')[1]).toMatchObject({ turnId: 't2', interrupted: false, text: 'Second answer.' })
    expect(of('assistant_text').map((e) => [e.turnId, e.delta])).toEqual([['t2', 'Second answer.']])
  })

  it('drops the abandoned turn’s late frames once it identifies itself', async () => {
    const { session, sdk, of } = setup({ settleCapMs: 40 })
    session.submit('t1', 'first', 'voice')
    const first = await sdk.last.nextUser()
    session.submit('t2', 'second', 'voice')
    const second = await sdk.last.nextUser(500)
    sdk.last.send(frame.text('old words', first!.uuid), frame.text(' more old words'), frame.result(first!.uuid))
    sdk.last.send(frame.text('New answer.', second!.uuid), frame.result(second!.uuid))
    await settle()
    expect(of('assistant_text').map((e) => [e.turnId, e.delta])).toEqual([['t2', 'New answer.']])
    expect(of('turn_complete')[1]).toMatchObject({ turnId: 't2', text: 'New answer.' })
  })
})

describe('tools', () => {
  it('allows a low-risk CLAP tool and reports it', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'time?', 'voice')
    await sdk.last.nextUser()
    const decision = await sdk.last.preToolUse(sdkToolName('get_time'), {}, 'toolu_1', CLAP_PROVENANCE)
    expect(decision).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(of('tool_start')).toEqual([
      expect.objectContaining({ turnId: 't1', toolUseId: 'toolu_1', name: 'get_time', risk: 'low', summary: 'Checking the time' }),
    ])
    // canUseTool allows exactly the calls the hook approved.
    await expect(sdk.last.canUseTool(sdkToolName('get_time'), 'toolu_1')).resolves.toMatchObject({ behavior: 'allow' })
    await expect(sdk.last.canUseTool(sdkToolName('get_time'), 'toolu_other')).resolves.toMatchObject({ behavior: 'deny' })

    await sdk.last.postToolUse(sdkToolName('get_time'), 'toolu_1')
    expect(of('tool_result')).toEqual([expect.objectContaining({ toolUseId: 'toolu_1', name: 'get_time', durationMs: 5 })])
    expect(of('state_change').map((e) => e.activity)).toEqual(['thinking', 'executing', 'thinking'])
    // Finished calls are no longer approved.
    await expect(sdk.last.canUseTool(sdkToolName('get_time'), 'toolu_1')).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('reports failed tool calls in plain words', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'read it', 'voice')
    await sdk.last.nextUser()
    await sdk.last.preToolUse(sdkToolName('web_fetch'), { url: 'https://example.com' }, 'toolu_1', CLAP_PROVENANCE)
    await sdk.last.postToolUse(sdkToolName('web_fetch'), 'toolu_1', { isError: true, content: [{ type: 'text', text: 'The site\ncould not be reached.' }] })
    await sdk.last.preToolUse(sdkToolName('get_time'), {}, 'toolu_2', CLAP_PROVENANCE)
    await sdk.last.postToolUseFailure(sdkToolName('get_time'), 'toolu_2', 'boom')
    expect(of('tool_error').map((e) => [e.toolUseId, e.error, e.denied])).toEqual([
      ['toolu_1', 'The site could not be reached.', false],
      ['toolu_2', 'boom', false],
    ])
  })

  it('denies tools CLAP does not offer, telling the model not to retry', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'delete my home folder', 'voice')
    await sdk.last.nextUser()
    const decision = await sdk.last.preToolUse('Bash', { command: 'rm -rf ~' }, 'toolu_1')
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(JSON.stringify(decision)).toMatch(/not available to CLAP.*do not retry/)
    expect(of('tool_error')).toEqual([expect.objectContaining({ toolUseId: 'toolu_1', name: 'Bash', denied: true })])
    expect(of('tool_start')).toEqual([])
    await expect(sdk.last.canUseTool('Bash', 'toolu_1')).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('asks before a high-risk tool and runs it only when approved', async () => {
    const { session, sdk, broker, of } = setup()
    session.submit('t1', 'clean up', 'voice')
    await sdk.last.nextUser()
    const pending = sdk.last.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    await settle()
    const request = of('confirmation_request')[0]!
    expect(request).toMatchObject({ turnId: 't1', name: 'delete_files', risk: 'high', summary: 'Delete 3 files' })
    expect(of('tool_start')).toEqual([])
    // Another session cannot answer it.
    expect(broker.respond('someone-else', request.requestId, true)).toBe('wrong_session')
    expect(broker.respond('session-1', request.requestId, true)).toBe('accepted')
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
    expect(of('tool_start')).toHaveLength(1)
  })

  it('refuses a high-risk tool that is declined, times out or is interrupted', async () => {
    const declined = setup()
    declined.session.submit('t1', 'clean up', 'voice')
    await declined.sdk.last.nextUser()
    const answer = declined.sdk.last.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    await settle()
    declined.broker.respond('session-1', declined.of('confirmation_request')[0]!.requestId, false)
    expect(JSON.stringify(await answer)).toMatch(/did not approve/)
    expect(declined.of('tool_error')).toEqual([expect.objectContaining({ error: 'Not approved.', denied: true })])

    const slow = setup({ confirmTimeoutMs: 30 })
    slow.session.submit('t1', 'clean up', 'voice')
    await slow.sdk.last.nextUser()
    const late = await slow.sdk.last.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    expect(JSON.stringify(late)).toMatch(/did not confirm in time/)

    const cut = setup()
    cut.session.submit('t1', 'clean up', 'voice')
    await cut.sdk.last.nextUser()
    const waiting = cut.sdk.last.preToolUse(sdkToolName('delete_files'), { count: 3 }, 'toolu_1', CLAP_PROVENANCE)
    await settle()
    cut.session.interrupt('barge_in')
    expect(await waiting).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(cut.broker.pendingCount()).toBe(0)
  })

  it('refuses tool calls for an interrupted turn instead of borrowing a newer one', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'first', 'voice')
    await sdk.last.nextUser()
    session.interrupt('barge_in')
    const decision = await sdk.last.preToolUse(sdkToolName('get_time'), {}, 'toolu_1', CLAP_PROVENANCE)
    expect(JSON.stringify(decision)).toMatch(/interrupted/)
    expect(of('tool_start')).toEqual([])
  })

  it('reports tools still running when a turn ends', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'time?', 'voice')
    const user = await sdk.last.nextUser()
    await sdk.last.preToolUse(sdkToolName('get_time'), {}, 'toolu_1', CLAP_PROVENANCE)
    sdk.last.send(frame.result(user!.uuid))
    await settle()
    expect(of('tool_error')).toEqual([expect.objectContaining({ toolUseId: 'toolu_1', error: 'Stopped before it finished.' })])
  })
})

describe('refusals', () => {
  it('says plainly that it cannot help, rather than "try again"', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'something it declines', 'voice')
    const user = await sdk.last.nextUser()
    sdk.last.send(
      frame.system('model_refusal_no_fallback', { original_model: 'claude-opus-5', api_refusal_category: 'cyber' }),
      frame.result(user!.uuid, { subtype: 'success', is_error: true, result: 'API Error: unable to respond to this request' }),
    )
    await settle()
    expect(of('error')).toEqual([expect.objectContaining({ turnId: 't1', message: "I can't help with that one." })])
    // The raw refusal text is not read out as if it were the answer.
    expect(of('assistant_text')).toEqual([])
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', text: '' })])
  })

  it('drops a refused partial when the fallback model takes the turn', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'a borderline question', 'voice')
    const user = await sdk.last.nextUser()
    sdk.last.send(
      frame.text('Refused part', user!.uuid),
      frame.system('model_refusal_fallback', {
        trigger: 'refusal',
        direction: 'retry',
        scope: 'session',
        original_model: 'claude-opus-5',
        fallback_model: 'claude-opus-4-8',
      }),
      frame.text('The real answer.'),
      frame.result(user!.uuid),
    )
    await settle()
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', text: 'The real answer.', interrupted: false })])
    expect(of('error')).toEqual([])
  })
})

describe('failures', () => {
  it('turns a failed result into a speakable error', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'do many things', 'voice')
    const user = await sdk.last.nextUser()
    sdk.last.send(frame.result(user!.uuid, { subtype: 'error_max_turns', errors: ['max turns'] }))
    await settle()
    expect(of('error')).toEqual([
      expect.objectContaining({ turnId: 't1', code: 'turn_failed', message: 'That took too many steps, so I stopped.', recoverable: true }),
    ])
    expect(of('turn_complete')).toEqual([expect.objectContaining({ turnId: 't1', interrupted: false })])
  })

  it('prefers the assistant error the SDK reported', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'hi', 'voice')
    const user = await sdk.last.nextUser()
    sdk.last.send(frame.assistantError('rate_limit', user!.uuid), frame.result(user!.uuid, { subtype: 'success', is_error: true, result: 'API Error' }))
    await settle()
    expect(of('error')[0]?.message).toBe('Claude is rate limiting requests. Try again in a moment.')
  })

  it('recovers from the Claude Code process dying', async () => {
    const { session, sdk, of } = setup()
    session.submit('t1', 'hi', 'voice')
    await sdk.last.nextUser()
    sdk.last.crash(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
    await settle()
    expect(of('error')[0]).toMatchObject({ turnId: 't1', code: 'agent_unavailable' })
    expect(of('turn_complete')).toHaveLength(1)
    expect(of('state_change').at(-1)).toMatchObject({ activity: 'idle' })

    // The next message starts a fresh process.
    session.submit('t2', 'again', 'voice')
    expect(sdk.queries).toHaveLength(2)
    expect((await sdk.last.nextUser())?.message).toEqual({ role: 'user', content: 'again' })
  })

  it('reports an unexpected exit even with nothing in flight', async () => {
    const { session, sdk, of } = setup()
    session.warmUp()
    sdk.last.end()
    await settle()
    expect(of('error')).toEqual([expect.objectContaining({ code: 'agent_failed' })])
  })

  it('maps failures to messages a user can act on', () => {
    expect(describeFailure(new Error('spawn node ENOENT'), null).code).toBe('agent_unavailable')
    expect(describeFailure(new Error('401 Unauthorized'), null).message).toMatch(/isn't logged in/)
    expect(describeFailure(new Error('socket hang up'), null).code).toBe('agent_failed')
    expect(describeFailure(new Error('anything'), 'billing_error').message).toMatch(/billing/)
  })
})

describe('close', () => {
  it('cancels pending confirmations and stops the process', async () => {
    const { session, sdk, broker } = setup()
    session.submit('t1', 'clean up', 'voice')
    await sdk.last.nextUser()
    const waiting = sdk.last.preToolUse(sdkToolName('delete_files'), { count: 1 }, 'toolu_1', CLAP_PROVENANCE)
    await settle()
    session.close()
    expect(await waiting).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(broker.pendingCount()).toBe(0)
    expect(sdk.last.closed).toBe(true)
    // Closed sessions accept nothing.
    session.submit('t2', 'hello?', 'voice')
    expect(sdk.queries).toHaveLength(1)
  })
})
