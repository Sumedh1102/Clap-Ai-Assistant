/**
 * One conversation with Claude, run through the Claude Agent SDK.
 *
 * The SDK is driven in streaming-input mode: a single `query()` consumes an
 * async generator of user messages for the life of the session, so the model
 * keeps the whole conversation. This class turns that stream into CLAP
 * protocol events and owns three hard problems:
 *
 * 1. Turn identity. Every event must name the turn it belongs to. Each user
 *    message is stamped with an SDK `uuid`; the SDK echoes it on the first
 *    frames of the reply and on the `result`, so frames are attributed exactly
 *    rather than by arrival order.
 *
 * 2. Interrupts. `interrupt()` returns at once, but the old turn keeps
 *    streaming until its `result` arrives (measured). A message delivered in
 *    that window can also be folded into the old turn. So the next message is
 *    held until the interrupted turn settles, with a cap in case it never does.
 *
 * 3. Tool permissions. The PreToolUse hook fires for every tool call, with
 *    trusted provenance, before it runs — so that is where the permission gate
 *    sits (and where confirmations are awaited). `canUseTool` is a fail-closed
 *    fallback that only allows calls the gate already approved.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BridgeEvent, ErrorCode } from '../../shared/protocol'
import type { BridgeConfig } from '../config'
import type { Logger } from '../logger'
import type { ConfirmationBroker, PermissionGate } from '../permissions'
import { ALWAYS_DISALLOWED_BUILTINS } from '../tools'
import { createClapMcpServer } from '../tools/mcp'
import { cleanSummary, CLAP_MCP_SERVER, type ToolContext, type ToolRegistry } from '../tools/registry'

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

export type AgentSessionOptions = {
  id?: string
  config: BridgeConfig
  registry: ToolRegistry
  gate: PermissionGate
  broker: ConfirmationBroker
  logger: Logger
  systemPrompt: string
  /** Injected in tests; defaults to the SDK's `query`. */
  queryFn?: QueryFn
  /** How long an interrupted turn may take to settle before the next is sent anyway. */
  settleCapMs?: number
  /** Environment for the Claude Code subprocess (secrets already removed). */
  agentEnv?: Record<string, string | undefined>
}

type RunningTool = { name: string; label: string; startedAt: number }

type Turn = {
  id: string
  sdkUuid: string
  text: string
  source: 'voice' | 'text'
  submittedAt: number
  deliveredAt: number | null
  answer: string
  interrupted: boolean
  responding: boolean
  /** A text block ended; the next one needs a separator so sentences don't fuse. */
  needsBreak: boolean
  running: Map<string, RunningTool>
  abort: AbortController
}

/** Spoken when a turn ends badly. Plain sentences: they may be read aloud. */
const RESULT_FAILURES: Record<string, string> = {
  error_during_execution: 'That request failed part way through.',
  error_max_turns: 'That took too many steps, so I stopped.',
  error_max_budget_usd: 'That reached the spending limit for one request.',
  error_max_structured_output_retries: "I couldn't put the answer together.",
}

const ASSISTANT_ERRORS: Partial<Record<SDKAssistantMessageError, { code: ErrorCode; message: string }>> = {
  authentication_failed: {
    code: 'agent_unavailable',
    message: "I can't reach Claude because Claude Code isn't logged in. Run claude in a terminal, log in, and try again.",
  },
  oauth_org_not_allowed: {
    code: 'agent_unavailable',
    message: "This Claude account isn't allowed to use Claude Code here.",
  },
  account_on_hold: { code: 'agent_unavailable', message: 'The Claude account is on hold.' },
  verification_required: {
    code: 'agent_unavailable',
    message: 'The Claude account needs verification. Run claude in a terminal to finish it.',
  },
  billing_error: { code: 'agent_unavailable', message: 'Claude refused the request because of a billing problem.' },
  cloud_credential_error: { code: 'agent_unavailable', message: 'The cloud credentials for Claude are not working.' },
  rate_limit: { code: 'turn_failed', message: 'Claude is rate limiting requests. Try again in a moment.' },
  overloaded: { code: 'turn_failed', message: 'Claude is overloaded right now. Try again in a moment.' },
  model_not_found: { code: 'agent_unavailable', message: "The configured model isn't available. Check CLAP_MODEL." },
  invalid_request: { code: 'turn_failed', message: 'Claude rejected that request.' },
  server_error: { code: 'turn_failed', message: 'Claude had a server error. Try again.' },
}

const DEFAULT_SETTLE_CAP_MS = 2_500

const allow = (): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
})

/** Deny messages go to the model, which will relay them; keep them plain. */
const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `CLAP did not run this tool: ${reason} Tell the user in one short sentence and do not retry it.`,
  },
})

export class AgentSession {
  readonly id: string
  private readonly options: AgentSessionOptions
  private readonly logger: Logger
  private readonly queryFn: QueryFn
  private readonly settleCapMs: number

  private emitFn: ((event: BridgeEvent) => void) | null = null
  private query: Query | null = null
  private generation = 0
  private closed = false

  /** Submitted but not yet handed to the SDK. At most one in practice. */
  private queue: Turn[] = []
  /** Handed to the SDK, waiting for its `result`. */
  private active: Turn[] = []
  /** The turn un-stamped stream frames belong to. */
  private current: Turn | null = null
  private wake: (() => void) | null = null
  private capTimer: ReturnType<typeof setTimeout> | null = null
  private capExpired = false
  private lastAssistantError: SDKAssistantMessageError | null = null
  /** Tool-use ids the gate approved; `canUseTool` allows only these. */
  private readonly approved = new Set<string>()

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.id = options.id ?? randomUUID()
    this.logger = options.logger.child({ component: 'agent', sessionId: this.id })
    this.queryFn = options.queryFn ?? (sdkQuery as QueryFn)
    this.settleCapMs = options.settleCapMs ?? DEFAULT_SETTLE_CAP_MS
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  attach(emit: (event: BridgeEvent) => void): void {
    this.emitFn = emit
  }

  detach(): void {
    this.emitFn = null
  }

  get isBusy(): boolean {
    return this.queue.length > 0 || this.active.some((t) => !t.interrupted)
  }

  /** Start the Claude Code process now so the first answer isn't waiting on it. */
  warmUp(): void {
    this.ensureQuery()
  }

  /** A new user message. Supersedes anything in flight. */
  submit(turnId: string, text: string, source: 'voice' | 'text'): void {
    if (this.closed) return
    this.dropQueued()
    if (this.active.some((t) => !t.interrupted)) this.interruptActive('superseded')
    this.queue.push({
      id: turnId,
      sdkUuid: randomUUID(),
      text,
      source,
      submittedAt: Date.now(),
      deliveredAt: null,
      answer: '',
      interrupted: false,
      responding: false,
      needsBreak: false,
      running: new Map(),
      abort: new AbortController(),
    })
    this.logger.info('turn.submitted', { turnId, source, chars: text.length })
    this.ensureQuery()
    this.pump()
  }

  /** Stop whatever is in flight (barge-in, cancel, stand down). */
  interrupt(reason: string): void {
    this.dropQueued()
    this.interruptActive(reason)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.clearCap()
    this.options.broker.cancelSession(this.id)
    for (const turn of this.active) turn.abort.abort()
    this.active = []
    this.queue = []
    this.pump()
    this.stopQuery()
    this.logger.info('session.closed')
  }

  // ---------------------------------------------------------------------------
  // Turn bookkeeping
  // ---------------------------------------------------------------------------

  private emit(event: BridgeEvent): void {
    this.emitFn?.(event)
  }

  private dropQueued(): void {
    for (const turn of this.queue) {
      this.emit({ type: 'turn_complete', turnId: turn.id, text: '', interrupted: true, durationMs: 0 })
    }
    this.queue = []
  }

  private interruptActive(reason: string): void {
    const running = this.active.filter((t) => !t.interrupted)
    if (!running.length) return
    for (const turn of running) {
      turn.interrupted = true
      turn.abort.abort()
    }
    this.options.broker.cancelSession(this.id)
    this.logger.info('turn.interrupted', { turnId: running[0]!.id, reason })
    this.clearCap()
    this.capExpired = false
    this.capTimer = setTimeout(() => {
      this.capTimer = null
      this.capExpired = true
      this.logger.warn('turn.settle_cap_reached', { waitedMs: this.settleCapMs })
      this.pump()
    }, this.settleCapMs)
    void this.query?.interrupt().catch((error: unknown) => this.logger.warn('agent.interrupt_failed', { error }))
  }

  private clearCap(): void {
    if (this.capTimer) clearTimeout(this.capTimer)
    this.capTimer = null
  }

  /** Wake the input generator so it re-checks whether it may deliver. */
  private pump(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  private nextDeliverable(): Turn | null {
    if (!this.queue.length) return null
    if (this.active.length && !this.capExpired) return null
    if (this.active.length) {
      // The interrupted turn never reported back. Stop waiting for it; its
      // late frames, if any, are still attributed by uuid.
      for (const stuck of this.active) this.finishTurn(stuck, { interrupted: true })
      this.active = []
      this.current = null
    }
    this.capExpired = false
    return this.queue.shift() ?? null
  }

  private async *input(generation: number): AsyncGenerator<SDKUserMessage> {
    while (!this.closed && generation === this.generation) {
      const turn = this.nextDeliverable()
      if (!turn) {
        await new Promise<void>((resolve) => (this.wake = resolve))
        continue
      }
      turn.deliveredAt = Date.now()
      this.active.push(turn)
      this.current ??= turn
      this.emit({ type: 'state_change', turnId: turn.id, activity: 'thinking' })
      yield {
        type: 'user',
        message: { role: 'user', content: turn.text },
        parent_tool_use_id: null,
        origin: { kind: 'human' },
        uuid: turn.sdkUuid as SDKUserMessage['uuid'],
      }
    }
  }

  /** Which turn a frame belongs to, re-syncing on the SDK's uuid stamps. */
  private turnFor(frame: { user_message_uuid?: string }): Turn | null {
    const stamp = frame.user_message_uuid
    if (stamp) {
      const stamped = this.active.find((t) => t.sdkUuid === stamp)
      if (stamped) this.current = stamped
    }
    return this.current ?? this.active[0] ?? null
  }

  private finishTurn(turn: Turn, outcome: { interrupted: boolean; failure?: { code: ErrorCode; message: string } }): void {
    for (const [toolUseId, tool] of turn.running) {
      this.approved.delete(toolUseId)
      this.emit({
        type: 'tool_error',
        turnId: turn.id,
        toolUseId,
        name: tool.name,
        durationMs: Date.now() - tool.startedAt,
        error: 'Stopped before it finished.',
        denied: false,
      })
    }
    turn.running.clear()
    if (outcome.failure) {
      this.emit({ type: 'error', turnId: turn.id, code: outcome.failure.code, message: outcome.failure.message, recoverable: true })
    }
    this.emit({
      type: 'turn_complete',
      turnId: turn.id,
      text: turn.answer,
      interrupted: outcome.interrupted,
      durationMs: Date.now() - (turn.deliveredAt ?? turn.submittedAt),
    })
  }

  // ---------------------------------------------------------------------------
  // The SDK session
  // ---------------------------------------------------------------------------

  private ensureQuery(): void {
    if (this.query || this.closed) return
    const generation = ++this.generation
    const { config, registry } = this.options
    const builtins = registry.builtinNames()

    const options: Options = {
      model: config.model,
      effort: config.effort,
      systemPrompt: this.options.systemPrompt,
      tools: builtins,
      allowedTools: [],
      disallowedTools: ALWAYS_DISALLOWED_BUILTINS.filter((name) => !builtins.includes(name)),
      mcpServers: { [CLAP_MCP_SERVER]: createClapMcpServer(registry, () => this.toolContext()) },
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'default',
      includePartialMessages: true,
      maxTurns: config.maxTurns,
      persistSession: config.persistSessions,
      cwd: homedir(),
      env: this.options.agentEnv,
      hooks: {
        // Timeout in seconds: long enough to wait out a confirmation.
        PreToolUse: [{ hooks: [this.preToolUse], timeout: Math.ceil(config.confirmTimeoutMs / 1000) + 15 }],
        PostToolUse: [{ hooks: [this.postToolUse] }],
        PostToolUseFailure: [{ hooks: [this.postToolUse] }],
      },
      canUseTool: this.canUseTool,
      stderr: (data: string) => {
        if (config.debug) this.logger.debug('sdk.stderr', { line: data.trim().slice(0, 500) })
      },
    }

    this.logger.info('session.starting', { model: config.model, effort: config.effort, builtins })
    let query: Query
    try {
      query = this.queryFn({ prompt: this.input(generation), options })
    } catch (error) {
      this.fail(error)
      return
    }
    this.query = query
    void this.consume(query, generation)
  }

  private stopQuery(): void {
    const query = this.query
    this.query = null
    try {
      query?.close()
    } catch (error) {
      this.logger.debug('agent.close_failed', { error })
    }
  }

  private async consume(query: Query, generation: number): Promise<void> {
    try {
      for await (const message of query) {
        if (generation !== this.generation || this.closed) return
        this.handle(message)
      }
      if (!this.closed && generation === this.generation) this.fail(new Error('the Claude Code process exited'))
    } catch (error) {
      if (!this.closed && generation === this.generation) this.fail(error)
    }
  }

  /** The SDK session died. Report it, reset, and start fresh on the next message. */
  private fail(error: unknown): void {
    this.logger.error('session.failed', { error })
    this.generation++
    this.stopQuery()
    this.clearCap()
    this.options.broker.cancelSession(this.id)
    const failure = describeFailure(error, this.lastAssistantError)
    this.lastAssistantError = null
    const affected = [...this.active, ...this.queue]
    this.active = []
    this.queue = []
    this.current = null
    this.approved.clear()
    for (const turn of affected) {
      turn.abort.abort()
      this.finishTurn(turn, { interrupted: turn.interrupted, failure: turn.interrupted ? undefined : failure })
    }
    if (!affected.length) this.emit({ type: 'error', code: failure.code, message: failure.message, recoverable: true })
    this.emit({ type: 'state_change', turnId: null, activity: 'idle' })
    this.pump()
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case 'stream_event': {
        if (message.parent_tool_use_id) return
        const turn = this.turnFor(message)
        if (!turn) return
        const event = message.event
        if (event.type === 'content_block_stop' && turn.responding) {
          turn.needsBreak = true
          return
        }
        if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta' || !event.delta.text) return
        if (turn.interrupted) return
        let delta = event.delta.text
        if (turn.needsBreak && turn.answer && !/\s$/.test(turn.answer)) delta = `\n\n${delta}`
        turn.needsBreak = false
        if (!turn.responding) {
          turn.responding = true
          this.emit({ type: 'state_change', turnId: turn.id, activity: 'responding' })
        }
        turn.answer += delta
        this.emit({ type: 'assistant_text', turnId: turn.id, delta })
        return
      }

      case 'assistant': {
        if (message.parent_tool_use_id) return
        this.turnFor(message)
        if (message.error) {
          this.lastAssistantError = message.error
          this.logger.warn('agent.assistant_error', { error: message.error })
        }
        return
      }

      case 'result': {
        const stamp = message.user_message_uuid
        const turn = (stamp && this.active.find((t) => t.sdkUuid === stamp)) || this.current || this.active[0]
        if (!turn) {
          this.logger.debug('agent.result_without_turn', { subtype: message.subtype })
          return
        }
        this.active = this.active.filter((t) => t !== turn)
        if (this.current === turn) this.current = null

        const failed = message.subtype !== 'success' || message.is_error
        let failure: { code: ErrorCode; message: string } | undefined
        if (!turn.interrupted && failed) {
          const resultText = message.subtype === 'success' ? message.result : message.errors.join(' ')
          failure =
            (this.lastAssistantError && ASSISTANT_ERRORS[this.lastAssistantError]) ||
            (/log ?in|api key|auth/i.test(resultText) ? ASSISTANT_ERRORS.authentication_failed : undefined) || {
              code: 'turn_failed',
              message: RESULT_FAILURES[message.subtype] ?? "That didn't work. Try again.",
            }
          this.logger.warn('turn.failed', { turnId: turn.id, subtype: message.subtype, detail: resultText.slice(0, 300) })
        }
        if (!turn.interrupted && !failed && !turn.answer.trim() && message.subtype === 'success' && message.result) {
          // Some builds deliver the final text only in the result.
          turn.answer = message.result
          this.emit({ type: 'assistant_text', turnId: turn.id, delta: message.result })
        }
        this.lastAssistantError = null

        this.logger.info('turn.complete', {
          turnId: turn.id,
          ok: !failure,
          interrupted: turn.interrupted,
          subtype: message.subtype,
          durationMs: Date.now() - (turn.deliveredAt ?? turn.submittedAt),
          apiMs: message.duration_api_ms,
          turns: message.num_turns,
          costUsd: message.total_cost_usd,
        })
        this.finishTurn(turn, { interrupted: turn.interrupted, failure })

        if (!this.active.length) {
          this.clearCap()
          this.capExpired = false
          this.emit({ type: 'state_change', turnId: null, activity: 'idle' })
        }
        this.pump()
        return
      }

      case 'system': {
        if (message.subtype === 'init') {
          const servers = message.mcp_servers.map((s) => `${s.name}:${s.status}`)
          this.logger.info('session.ready', { model: message.model, tools: message.tools.length, servers })
          const clap = message.mcp_servers.find((s) => s.name === CLAP_MCP_SERVER)
          if (clap && clap.status !== 'connected') this.logger.error('tools.server_unavailable', { status: clap.status })
        }
        return
      }

      default:
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Tool hooks
  // ---------------------------------------------------------------------------

  private toolContext(): ToolContext {
    const turn = this.current ?? this.active[0] ?? null
    return {
      sessionId: this.id,
      turnId: turn?.id ?? null,
      signal: turn?.abort.signal ?? AbortSignal.abort(),
      logger: this.logger.child({ component: 'tools', turnId: turn?.id }),
    }
  }

  private readonly preToolUse: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    // The call belongs to the turn the stream is on. If that turn has been
    // interrupted, the call is refused — it must not borrow a newer turn.
    const streaming = this.current ?? this.active[0] ?? null
    const turn = streaming && !streaming.interrupted ? streaming : null
    const decision = this.options.gate.decide(input.tool_name, input.tool_input, input.mcp_server)
    const log = this.logger.child({ turnId: turn?.id, tool: input.tool_name, toolUseId: input.tool_use_id })
    const name = decision.tool?.name ?? input.tool_name.slice(0, 120)

    const refuse = (reason: string, error: string): HookJSONOutput => {
      log.warn('tool.denied', { reason })
      if (turn) {
        this.emit({ type: 'tool_error', turnId: turn.id, toolUseId: input.tool_use_id, name, durationMs: 0, error, denied: true })
      }
      return deny(reason)
    }

    if (!turn) return refuse('the request was interrupted.', 'Interrupted.')
    if (decision.action === 'deny') return refuse(decision.reason, decision.reason)

    if (decision.action === 'confirm') {
      log.info('tool.confirmation_requested', { risk: decision.tool.risk })
      const outcome = await this.options.broker.request({
        sessionId: this.id,
        turnId: turn.id,
        tool: decision.tool,
        summary: decision.summary,
        signal: AbortSignal.any([signal, turn.abort.signal]),
        send: (event) => this.emit(event),
      })
      log.info('tool.confirmation_resolved', { approved: outcome.approved, reason: outcome.reason })
      if (!outcome.approved) {
        return outcome.reason === 'timeout'
          ? refuse('the user did not confirm in time.', 'Not confirmed in time.')
          : refuse('the user did not approve it.', 'Not approved.')
      }
      if (turn.interrupted) return refuse('the request was interrupted.', 'Interrupted.')
    }

    this.approved.add(input.tool_use_id)
    turn.running.set(input.tool_use_id, { name: decision.tool.name, label: decision.tool.label, startedAt: Date.now() })
    turn.responding = false
    log.info('tool.started', { risk: decision.tool.risk, decision: decision.action })
    this.emit({
      type: 'tool_start',
      turnId: turn.id,
      toolUseId: input.tool_use_id,
      name: decision.tool.name,
      label: decision.tool.label,
      risk: decision.tool.risk,
      summary: decision.summary,
    })
    this.emit({ type: 'state_change', turnId: turn.id, activity: 'executing' })
    return allow()
  }

  private readonly postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {}
    const id = input.tool_use_id
    this.approved.delete(id)
    const turn = this.active.find((t) => t.running.has(id))
    const tool = turn?.running.get(id)
    if (!turn || !tool) return {}
    turn.running.delete(id)
    const durationMs = input.duration_ms ?? Date.now() - tool.startedAt

    const failed =
      input.hook_event_name === 'PostToolUseFailure' ||
      (typeof input.tool_response === 'object' && input.tool_response !== null && (input.tool_response as { isError?: unknown }).isError === true)
    const log = this.logger.child({ turnId: turn.id, tool: tool.name, toolUseId: id })

    if (failed) {
      const raw = input.hook_event_name === 'PostToolUseFailure' ? input.error : errorText(input.tool_response)
      log.warn('tool.finished', { ok: false, durationMs, error: raw })
      this.emit({
        type: 'tool_error',
        turnId: turn.id,
        toolUseId: id,
        name: tool.name,
        durationMs,
        error: cleanSummary(raw || `${tool.label} failed.`),
        denied: false,
      })
    } else {
      log.info('tool.finished', { ok: true, durationMs })
      this.emit({ type: 'tool_result', turnId: turn.id, toolUseId: id, name: tool.name, durationMs, summary: `${tool.label} finished` })
    }
    if (!turn.running.size && !turn.interrupted) {
      this.emit({ type: 'state_change', turnId: turn.id, activity: 'thinking' })
    }
    return {}
  }

  private readonly canUseTool: CanUseTool = async (toolName, _input, { toolUseID }) => {
    if (this.approved.has(toolUseID)) return { behavior: 'allow', toolUseID }
    this.logger.warn('tool.unapproved_permission_request', { tool: toolName, toolUseId: toolUseID })
    return { behavior: 'deny', message: 'CLAP did not approve this tool call.', toolUseID }
  }
}

function errorText(response: unknown): string {
  const content = (response as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join(' ')
      .trim()
  }
  return ''
}

/** Turn an SDK failure into something the user can act on. */
export function describeFailure(
  error: unknown,
  assistantError: SDKAssistantMessageError | null,
): { code: ErrorCode; message: string } {
  const known = assistantError ? ASSISTANT_ERRORS[assistantError] : undefined
  if (known) return known
  const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ''}` : String(error)
  if (/ENOENT|not found|spawn/i.test(text)) {
    return {
      code: 'agent_unavailable',
      message: "Claude Code couldn't be started on this machine. Run npm run doctor to see what's missing.",
    }
  }
  if (/auth|login|401|403/i.test(text)) return ASSISTANT_ERRORS.authentication_failed!
  return {
    code: 'agent_failed',
    message: "I lost my connection to Claude. I'll reconnect on your next request.",
  }
}
