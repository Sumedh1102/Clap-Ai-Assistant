/**
 * A scripted stand-in for the Claude Agent SDK's `query()`, for tests.
 *
 * It consumes the session's prompt stream the way the SDK does, lets a test
 * push SDK frames back, and invokes the session's own hooks and `canUseTool`
 * the way Claude Code would around a tool call.
 */

import { randomUUID } from 'node:crypto'
import type {
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../agent/runtime'

export const CLAP_PROVENANCE = { name: 'clap', source: 'sdk' }

export class FakeQuery {
  readonly options: Options
  readonly received: SDKUserMessage[] = []
  interrupts = 0
  closed = false
  private taken = 0
  private readonly outbox: Array<{ message?: SDKMessage; error?: unknown; done?: boolean }> = []
  private reader: (() => void) | null = null
  private arrival: (() => void) | null = null

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options
    void (async () => {
      for await (const message of prompt) {
        this.received.push(message)
        this.arrival?.()
      }
    })()
  }

  /** The next user message the session delivers, or null if none arrives in time. */
  async nextUser(timeoutMs = 200): Promise<SDKUserMessage | null> {
    const deadline = Date.now() + timeoutMs
    while (this.received.length <= this.taken) {
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.arrival = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    return this.received[this.taken++]!
  }

  send(...messages: SDKMessage[]): void {
    for (const message of messages) this.outbox.push({ message })
    this.wakeReader()
  }

  /** The Claude Code process exits (the stream ends) or crashes (it throws). */
  end(): void {
    this.outbox.push({ done: true })
    this.wakeReader()
  }

  crash(error: unknown): void {
    this.outbox.push({ error })
    this.wakeReader()
  }

  async interrupt(): Promise<void> {
    this.interrupts++
  }

  close(): void {
    this.closed = true
    this.end()
  }

  preToolUse(toolName: string, toolInput: unknown, toolUseId: string, mcpServer?: { name: string; source: string }, signal?: AbortSignal) {
    return this.hook('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      mcp_server: mcpServer,
    }, signal)
  }

  postToolUse(toolName: string, toolUseId: string, toolResponse: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
    return this.hook('PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: {},
      tool_response: toolResponse,
      tool_use_id: toolUseId,
      duration_ms: 5,
    })
  }

  postToolUseFailure(toolName: string, toolUseId: string, error: string) {
    return this.hook('PostToolUseFailure', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: toolName,
      tool_input: {},
      tool_use_id: toolUseId,
      error,
    })
  }

  canUseTool(toolName: string, toolUseId: string): Promise<PermissionResult | null> {
    return this.options.canUseTool!(toolName, {}, { signal: new AbortController().signal, toolUseID: toolUseId } as never)
  }

  private hook(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure', input: object, signal?: AbortSignal): Promise<HookJSONOutput> {
    const callback = this.options.hooks?.[event]?.[0]?.hooks[0] as HookCallback
    const base = { session_id: 'sdk-session', transcript_path: '/dev/null', cwd: '/' }
    return callback({ ...base, ...input } as never, (input as { tool_use_id?: string }).tool_use_id, {
      signal: signal ?? new AbortController().signal,
    })
  }

  private wakeReader(): void {
    const reader = this.reader
    this.reader = null
    reader?.()
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        while (!this.outbox.length) await new Promise<void>((resolve) => (this.reader = resolve))
        const item = this.outbox.shift()!
        if (item.error) throw item.error
        if (item.done) return { done: true, value: undefined }
        return { done: false, value: item.message! }
      },
    }
  }
}

export class FakeSdk {
  readonly queries: FakeQuery[] = []
  private readonly onQuery: (query: FakeQuery) => void

  /** @param onQuery called for each new Claude Code "process", e.g. to drive it automatically. */
  constructor(onQuery: (query: FakeQuery) => void = () => {}) {
    this.onQuery = onQuery
  }

  readonly queryFn: QueryFn = ({ prompt, options }) => {
    const query = new FakeQuery(prompt, options)
    this.queries.push(query)
    this.onQuery(query)
    return query as unknown as Query
  }

  get last(): FakeQuery {
    const query = this.queries[this.queries.length - 1]
    if (!query) throw new Error('no query has been started')
    return query
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const common = () => ({ uuid: randomUUID(), session_id: 'sdk-session', parent_tool_use_id: null })

export const frame = {
  text(text: string, stamp?: string): SDKMessage {
    return {
      ...common(),
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      ...(stamp ? { user_message_uuid: stamp } : {}),
    } as unknown as SDKMessage
  },

  blockStop(): SDKMessage {
    return { ...common(), type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } as unknown as SDKMessage
  },

  assistantError(error: string, stamp?: string): SDKMessage {
    return {
      ...common(),
      type: 'assistant',
      message: { role: 'assistant', content: [] },
      error,
      ...(stamp ? { user_message_uuid: stamp } : {}),
    } as unknown as SDKMessage
  },

  result(stamp: string | undefined, fields: { subtype?: string; result?: string; errors?: string[]; is_error?: boolean } = {}): SDKMessage {
    const subtype = fields.subtype ?? 'success'
    return {
      ...common(),
      type: 'result',
      subtype,
      is_error: fields.is_error ?? subtype !== 'success',
      ...(subtype === 'success' ? { result: fields.result ?? '' } : { errors: fields.errors ?? [] }),
      duration_ms: 10,
      duration_api_ms: 8,
      num_turns: 1,
      total_cost_usd: 0,
      ...(stamp ? { user_message_uuid: stamp } : {}),
    } as unknown as SDKMessage
  },
}

/** Let queued promise callbacks and zero-delay timers run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
