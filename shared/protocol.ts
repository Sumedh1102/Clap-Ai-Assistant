/**
 * The CLAP WebSocket protocol, version 1.
 *
 * One definition, used by both ends: the bridge validates every message the
 * HUD sends, and the HUD validates every event the bridge sends. Types are
 * inferred from the schemas, so the two can never drift apart. The event
 * tables in docs/clap-architecture.md §3 describe what each one means.
 */

import { z } from 'zod'
import { MAX_USER_TEXT_CHARS, PROTOCOL_VERSION } from './defaults'
import { MEMORY_CATEGORIES, POLICY_ACTIONS, RISK_LEVELS, TOOL_CATEGORIES } from './risk'

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Ids minted by either side: UUIDs or similar. Never free text. */
const Id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid id')

/** SDK tool-use ids ("toolu_…"). Opaque, but bounded. */
const ToolUseId = z.string().min(1).max(200)

const Timestamp = z.number().finite().nonnegative()
const Duration = z.number().finite().nonnegative().max(86_400_000)

export const RiskLevelSchema = z.enum(RISK_LEVELS)
export const AgentActivitySchema = z.enum(['idle', 'thinking', 'executing', 'responding'])
export type AgentActivity = z.infer<typeof AgentActivitySchema>

// ---------------------------------------------------------------------------
// Client → bridge
// ---------------------------------------------------------------------------

export const HelloSchema = z.object({
  type: z.literal('hello'),
  /** Any version is accepted here so a mismatch gets a specific error, not a parse failure. */
  protocol: z.number().int().positive(),
  client: z.string().min(1).max(64),
  resumeSessionId: Id.optional(),
})

export const UserMessageSchema = z.object({
  type: z.literal('user_message'),
  turnId: Id,
  text: z.string().trim().min(1).max(MAX_USER_TEXT_CHARS),
  source: z.enum(['voice', 'text']),
})

export const InterruptSchema = z.object({
  type: z.literal('interrupt'),
  turnId: Id.optional(),
  reason: z.enum(['barge_in', 'user_cancel', 'stand_down']),
})

export const WakeDetectedSchema = z.object({
  type: z.literal('wake_detected'),
  engine: z.string().min(1).max(40),
  at: Timestamp,
})

export const SpeechStartSchema = z.object({
  type: z.literal('speech_start'),
  at: Timestamp,
})

export const SpeechStopSchema = z.object({
  type: z.literal('speech_stop'),
  at: Timestamp,
  durationMs: Duration.optional(),
})

export const AssistantSpeechStartSchema = z.object({
  type: z.literal('assistant_speech_start'),
  turnId: Id,
  provider: z.string().min(1).max(40),
})

export const AssistantSpeechEndSchema = z.object({
  type: z.literal('assistant_speech_end'),
  turnId: Id,
  interrupted: z.boolean(),
})

export const ConfirmationResponseSchema = z.object({
  type: z.literal('confirmation_response'),
  requestId: Id,
  approved: z.boolean(),
  via: z.enum(['voice', 'click', 'key']),
})

export const PingSchema = z.object({
  type: z.literal('ping'),
  t: Timestamp,
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  UserMessageSchema,
  InterruptSchema,
  WakeDetectedSchema,
  SpeechStartSchema,
  SpeechStopSchema,
  AssistantSpeechStartSchema,
  AssistantSpeechEndSchema,
  ConfirmationResponseSchema,
  PingSchema,
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type ClientMessageType = ClientMessage['type']
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>

// ---------------------------------------------------------------------------
// Bridge → client
// ---------------------------------------------------------------------------

export const ToolInfoSchema = z.object({
  name: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  category: z.enum(TOOL_CATEGORIES),
  risk: RiskLevelSchema,
  requiresConfirmation: z.boolean(),
})
export type ToolInfo = z.infer<typeof ToolInfoSchema>

export const CapabilitiesSchema = z.object({
  stt: z.object({ cloud: z.boolean(), provider: z.string().nullable() }),
  tts: z.object({
    cloud: z.boolean(),
    provider: z.string().nullable(),
    customVoice: z.boolean(),
  }),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

export const RiskPolicySchema = z.object({
  low: z.enum(POLICY_ACTIONS),
  medium: z.enum(POLICY_ACTIONS),
  high: z.enum(['confirm', 'deny']),
})

export const SessionReadySchema = z.object({
  type: z.literal('session_ready'),
  protocol: z.literal(PROTOCOL_VERSION),
  sessionId: Id,
  resumed: z.boolean(),
  bridgeVersion: z.string().max(40),
  model: z.string().max(100),
  capabilities: CapabilitiesSchema,
  tools: z.array(ToolInfoSchema).max(500),
  wakePhrase: z.string().min(1).max(60),
  policy: RiskPolicySchema,
})

export const StateChangeSchema = z.object({
  type: z.literal('state_change'),
  turnId: Id.nullable(),
  activity: AgentActivitySchema,
})

export const AssistantTextSchema = z.object({
  type: z.literal('assistant_text'),
  turnId: Id,
  delta: z.string().max(20_000),
})

export const TurnCompleteSchema = z.object({
  type: z.literal('turn_complete'),
  turnId: Id,
  text: z.string().max(200_000),
  interrupted: z.boolean(),
  durationMs: Duration,
})

export const ToolStartSchema = z.object({
  type: z.literal('tool_start'),
  turnId: Id,
  toolUseId: ToolUseId,
  name: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  risk: RiskLevelSchema,
  summary: z.string().max(300),
})

export const ToolResultSchema = z.object({
  type: z.literal('tool_result'),
  turnId: Id,
  toolUseId: ToolUseId,
  name: z.string().min(1).max(120),
  durationMs: Duration,
  summary: z.string().max(300),
})

export const ToolErrorSchema = z.object({
  type: z.literal('tool_error'),
  turnId: Id,
  toolUseId: ToolUseId,
  name: z.string().min(1).max(120),
  durationMs: Duration,
  error: z.string().max(500),
  denied: z.boolean(),
})

export const ConfirmationRequestSchema = z.object({
  type: z.literal('confirmation_request'),
  requestId: Id,
  turnId: Id,
  name: z.string().min(1).max(120),
  label: z.string().min(1).max(80),
  risk: RiskLevelSchema,
  summary: z.string().max(300),
  expiresAt: Timestamp,
})

export const ConfirmationResolvedSchema = z.object({
  type: z.literal('confirmation_resolved'),
  requestId: Id,
  approved: z.boolean(),
  reason: z.enum(['user', 'timeout', 'cancelled']),
})

export const MemoryUpdateSchema = z.object({
  type: z.literal('memory_update'),
  op: z.enum(['remember', 'forget', 'update']),
  category: z.enum(MEMORY_CATEGORIES),
  key: z.string().min(1).max(120),
  summary: z.string().max(300),
})

export const ERROR_CODES = [
  'bad_message',
  'unsupported_protocol',
  'rate_limited',
  'not_ready',
  'agent_unavailable',
  'agent_failed',
  'turn_failed',
  'internal',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  turnId: Id.optional(),
  code: z.enum(ERROR_CODES),
  /** Plain words, safe to show and to speak. Never a stack trace. */
  message: z.string().min(1).max(500),
  recoverable: z.boolean(),
})

export const PongSchema = z.object({
  type: z.literal('pong'),
  t: Timestamp,
  serverTime: Timestamp,
})

export const BridgeEventSchema = z.discriminatedUnion('type', [
  SessionReadySchema,
  StateChangeSchema,
  AssistantTextSchema,
  TurnCompleteSchema,
  ToolStartSchema,
  ToolResultSchema,
  ToolErrorSchema,
  ConfirmationRequestSchema,
  ConfirmationResolvedSchema,
  MemoryUpdateSchema,
  ErrorEventSchema,
  PongSchema,
])

export type BridgeEvent = z.infer<typeof BridgeEventSchema>
export type BridgeEventType = BridgeEvent['type']
export type BridgeEventOf<T extends BridgeEventType> = Extract<BridgeEvent, { type: T }>

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A short, human-readable account of why a message was rejected. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(message)'}: ${issue.message}`)
    .join('; ')
}

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const result = schema.safeParse(data)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: describeIssues(result.error) }
}

export const parseClientMessage = (raw: string): ParseResult<ClientMessage> =>
  parseWith(ClientMessageSchema, raw)

export const parseBridgeEvent = (raw: string): ParseResult<BridgeEvent> =>
  parseWith(BridgeEventSchema, raw)
