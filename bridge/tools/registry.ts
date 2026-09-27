/**
 * The tool registry.
 *
 * Every capability CLAP can use is declared here with the metadata the
 * permission model needs (risk, confirmation, category) and a zod input schema.
 * The registry is also the last line of defence: `execute` re-validates input,
 * re-checks the static policy, enforces a timeout and turns every failure into
 * a plain sentence, so a single broken tool can never take a turn down.
 *
 * Two kinds of entry:
 *   - CLAP tools, implemented here and exposed to the agent through an
 *     in-process MCP server (see ./mcp.ts) as `mcp__clap__<name>`.
 *   - Built-in Claude Code tools CLAP chooses to enable (e.g. WebSearch). They
 *     have no handler here, but they carry the same metadata so the gate and
 *     the HUD treat them identically.
 */

import { z } from 'zod'
import type { ToolInfo } from '../../shared/protocol'
import type { RiskLevel, RiskPolicy, ToolCategory } from '../../shared/risk'
import type { Logger } from '../logger'

export const CLAP_MCP_SERVER = 'clap'
export const sdkToolName = (name: string) => `mcp__${CLAP_MCP_SERVER}__${name}`

export type ToolContext = {
  sessionId: string
  turnId: string | null
  /** Aborted when the turn is interrupted or the tool times out. */
  signal: AbortSignal
  logger: Logger
}

export type ToolOutput = {
  /** What the model reads. Plain text, kept short. */
  text: string
}

/** What the permission gate and the HUD need to know about a tool. */
export type ToolMeta = {
  name: string
  label: string
  category: ToolCategory
  risk: RiskLevel
  requiresConfirmation: boolean
  /** A short description of one specific call ("Reading example.com"). Never throws. */
  summarize(input: unknown): string
}

type Shape = z.ZodRawShape

export type ClapToolDefinition<S extends Shape> = {
  name: string
  label: string
  /** Model-facing guidance: what it does and when to use it. */
  description: string
  category: ToolCategory
  risk: RiskLevel
  requiresConfirmation?: boolean
  inputSchema: S
  summarize?: (input: z.infer<z.ZodObject<S>>) => string
  timeoutMs?: number
  handler: (input: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>
}

/** Identity function that lets TypeScript infer the handler's input type. */
export function defineTool<S extends Shape>(definition: ClapToolDefinition<S>): ClapToolDefinition<S> {
  return definition
}

export type RegisteredTool = ToolMeta & {
  kind: 'clap'
  description: string
  inputSchema: Shape
  timeoutMs: number
  parse(input: unknown): { ok: true; value: unknown } | { ok: false; error: string }
  run(input: unknown, ctx: ToolContext): Promise<ToolOutput>
}

export type BuiltinTool = ToolMeta & { kind: 'builtin' }

export type ExecuteResult = { ok: true; output: ToolOutput } | { ok: false; error: string }

/**
 * Errors whose message was written for the user (and may be spoken). Anything
 * else is logged in full and reported with a generic sentence.
 */
export class ToolFailure extends Error {
  readonly userSafe = true
  constructor(message: string) {
    super(message)
    this.name = 'ToolFailure'
  }
}

export function userSafeMessage(error: unknown): string | null {
  if (error instanceof Error && (error as { userSafe?: unknown }).userSafe === true) return error.message
  return null
}

const NAME = /^[a-z][a-z0-9_]{1,62}$/
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_OUTPUT_CHARS = 24_000
const MAX_SUMMARY_CHARS = 200

/** Trim model-derived text for display: no control characters, bounded length. */
export function cleanSummary(text: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping them is the point
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS - 1)}…` : flat
}

export class ToolRegistry {
  private readonly clap = new Map<string, RegisteredTool>()
  private readonly builtins = new Map<string, BuiltinTool>()
  private readonly policy: RiskPolicy

  constructor(policy: RiskPolicy) {
    this.policy = policy
  }

  register<S extends Shape>(definition: ClapToolDefinition<S>): this {
    if (!NAME.test(definition.name)) throw new Error(`invalid tool name "${definition.name}"`)
    if (this.clap.has(definition.name)) throw new Error(`tool "${definition.name}" registered twice`)
    // Unknown keys are stripped rather than rejected: models occasionally add
    // a stray field, and refusing the whole call for it helps nobody.
    const schema = z.object(definition.inputSchema)
    const label = definition.label

    this.clap.set(definition.name, {
      kind: 'clap',
      name: definition.name,
      label,
      description: definition.description,
      category: definition.category,
      risk: definition.risk,
      // HIGH always confirms, whatever the definition says.
      requiresConfirmation: definition.risk === 'high' || Boolean(definition.requiresConfirmation),
      inputSchema: definition.inputSchema,
      timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      parse(input) {
        const result = schema.safeParse(input ?? {})
        if (result.success) return { ok: true, value: result.data }
        const issue = result.error.issues[0]
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
        return { ok: false, error: `${where}${issue?.message ?? 'invalid input'}` }
      },
      run: (input, ctx) => definition.handler(input as z.infer<z.ZodObject<S>>, ctx),
      summarize(input) {
        try {
          const result = schema.safeParse(input ?? {})
          if (result.success && definition.summarize) return cleanSummary(definition.summarize(result.data))
        } catch {
          /* a summary is decoration; never let it fail a call */
        }
        return label
      },
    })
    return this
  }

  registerBuiltin(meta: Omit<BuiltinTool, 'kind' | 'summarize'> & { summarize?: (input: unknown) => string }): this {
    const label = meta.label
    const summarize = meta.summarize
    this.builtins.set(meta.name, {
      ...meta,
      kind: 'builtin',
      requiresConfirmation: meta.risk === 'high' || meta.requiresConfirmation,
      summarize(input) {
        try {
          return summarize ? cleanSummary(summarize(input)) : label
        } catch {
          return label
        }
      },
    })
    return this
  }

  get(name: string): RegisteredTool | undefined {
    return this.clap.get(name)
  }

  clapTools(): RegisteredTool[] {
    return [...this.clap.values()]
  }

  builtinNames(): string[] {
    return [...this.builtins.keys()]
  }

  /**
   * Map a tool name as the SDK reports it to its metadata.
   *
   * Trust is keyed on provenance, not on the name: an MCP tool only counts as a
   * CLAP tool when the SDK says it came from the in-process server CLAP
   * registered (`source: 'sdk'`). A configured server that happened to be
   * called "clap" would not pass.
   */
  resolve(sdkName: string, provenance?: { name: string; source: string }): ToolMeta | undefined {
    if (sdkName.startsWith('mcp__')) {
      if (!provenance || provenance.source !== 'sdk' || provenance.name !== CLAP_MCP_SERVER) return undefined
      const prefix = `mcp__${CLAP_MCP_SERVER}__`
      return sdkName.startsWith(prefix) ? this.clap.get(sdkName.slice(prefix.length)) : undefined
    }
    return provenance ? undefined : this.builtins.get(sdkName)
  }

  /** What the HUD is told about the available tools. */
  list(): ToolInfo[] {
    return [...this.builtins.values(), ...this.clap.values()].map((t) => ({
      name: t.name,
      label: t.label,
      category: t.category,
      risk: t.risk,
      requiresConfirmation: t.requiresConfirmation,
    }))
  }

  /**
   * Run a CLAP tool. Never throws. The permission gate has already approved
   * this call in the PreToolUse hook; the static policy is checked again here
   * so that a hole in one layer is not a hole in both.
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ExecuteResult> {
    const tool = this.clap.get(name)
    if (!tool) return { ok: false, error: 'That tool does not exist.' }
    if (this.policy[tool.risk] === 'deny') {
      return { ok: false, error: `${tool.label} is disabled by the permission policy.` }
    }
    const parsed = tool.parse(input)
    if (!parsed.ok) return { ok: false, error: `The request for ${tool.label} was invalid (${parsed.error}).` }

    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason)
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new ToolFailure(`${tool.label} took too long and was stopped.`)), tool.timeoutMs)
    const timing = ctx.logger.time('tool.execute', { tool: name, risk: tool.risk })

    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      // If the tool finishes first, a later abort must not surface as an
      // unhandled rejection of this losing promise.
      aborted.catch(() => {})
      const output = await Promise.race([tool.run(parsed.value, { ...ctx, signal: controller.signal }), aborted])
      timing.end(true)
      const text = output.text.length > MAX_OUTPUT_CHARS ? `${output.text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : output.text
      return { ok: true, output: { text } }
    } catch (error) {
      timing.end(false, { error })
      if (ctx.signal.aborted) return { ok: false, error: `${tool.label} was cancelled.` }
      return { ok: false, error: userSafeMessage(error) ?? `${tool.label} failed unexpectedly.` }
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}
