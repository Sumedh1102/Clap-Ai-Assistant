/**
 * Bridge configuration, read from the environment and validated once.
 *
 * The same parser runs in the bridge, `npm run doctor` and `npm start`, so a
 * preflight check can never disagree with what the bridge will actually do.
 * Problems are collected rather than thrown one at a time: a user with three
 * typos should hear about all three at once, each naming its variable.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CLAP_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_UI_PORT,
  DEFAULT_WAKE_PHRASE,
} from '../shared/defaults'
import { DEFAULT_RISK_POLICY, type PolicyAction, type RiskPolicy } from '../shared/risk'

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

export type LogFormat = 'pretty' | 'json'

export type VoiceProviderChoice = 'auto' | 'elevenlabs' | 'none'

export type BridgeConfig = {
  host: string
  port: number
  uiPort: number
  /** Exact origins allowed to open the socket and call the HTTP API. */
  allowedOrigins: string[]
  /** Exact Host header values accepted (DNS-rebinding defence). */
  allowedHosts: string[]
  allowNoOrigin: boolean

  model: string
  effort: Effort
  maxTurns: number
  enableWebSearch: boolean
  persistSessions: boolean
  sessionGraceMs: number

  wakePhrase: string
  policy: RiskPolicy
  confirmTimeoutMs: number

  dataDir: string
  debug: boolean
  logFormat: LogFormat

  voice: {
    elevenLabsApiKey: string | null
    ttsProvider: VoiceProviderChoice
    sttProvider: VoiceProviderChoice
    voiceId: string | null
    ttsModel: string
    sttModel: string
    ttsOutputFormat: string
    stability: number | null
    similarity: number | null
    speed: number | null
  }
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** The ElevenLabs "George" stock voice — used until the custom CLAP voice exists. */
export const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function parseConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const problems: string[] = []

  const text = (name: string): string | undefined => {
    const value = env[name]?.trim()
    return value ? value : undefined
  }

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name}="${raw}" must be a whole number between ${min} and ${max}.`)
      return fallback
    }
    return n
  }

  const num = (name: string, min: number, max: number): number | null => {
    const raw = text(name)
    if (raw === undefined) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${name}="${raw}" must be a number between ${min} and ${max}.`)
      return null
    }
    return n
  }

  const flag = (name: string, fallback: boolean): boolean => {
    const raw = text(name)?.toLowerCase()
    if (raw === undefined) return fallback
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true
    if (['0', 'false', 'no', 'off'].includes(raw)) return false
    problems.push(`${name}="${raw}" must be 1/0 or true/false.`)
    return fallback
  }

  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = text(name)
    if (raw === undefined) return fallback
    if ((allowed as readonly string[]).includes(raw)) return raw as T
    problems.push(`${name}="${raw}" must be one of: ${allowed.join(', ')}.`)
    return fallback
  }

  // --- network ------------------------------------------------------------
  const host = text('CLAP_BRIDGE_HOST') ?? DEFAULT_BRIDGE_HOST
  const allowNonLoopback = flag('CLAP_ALLOW_NON_LOOPBACK', false)
  if (!LOOPBACK_HOSTS.has(host) && !allowNonLoopback) {
    problems.push(
      `CLAP_BRIDGE_HOST="${host}" is not a loopback address. The bridge controls tools on ` +
        'this machine; binding it to a network interface exposes it. Set ' +
        'CLAP_ALLOW_NON_LOOPBACK=1 only if you understand that.',
    )
  }
  const port = int('CLAP_BRIDGE_PORT', DEFAULT_BRIDGE_PORT, 1024, 65535)
  const uiPort = int('CLAP_UI_PORT', DEFAULT_UI_PORT, 1024, 65535)
  if (port === uiPort) problems.push('CLAP_BRIDGE_PORT and CLAP_UI_PORT must differ.')

  const allowedOrigins = new Set([`http://localhost:${uiPort}`, `http://127.0.0.1:${uiPort}`])
  for (const entry of (text('CLAP_ALLOWED_ORIGINS') ?? '').split(',')) {
    const raw = entry.trim()
    if (!raw) continue
    const origin = normalizeOrigin(raw)
    if (!origin) problems.push(`CLAP_ALLOWED_ORIGINS entry "${raw}" is not an origin like http://localhost:5173.`)
    else allowedOrigins.add(origin)
  }

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  if (!LOOPBACK_HOSTS.has(host)) allowedHosts.add(`${host.includes(':') ? `[${host}]` : host}:${port}`)

  // --- agent --------------------------------------------------------------
  const model = text('CLAP_MODEL') ?? 'claude-opus-5'
  if (!/^[a-z0-9][a-z0-9.\-[\]]{1,80}$/i.test(model)) {
    problems.push(`CLAP_MODEL="${model}" does not look like a model id (e.g. claude-opus-5).`)
  }

  // --- wake phrase ----------------------------------------------------------
  const wakePhrase = (text('CLAP_WAKE_PHRASE') ?? DEFAULT_WAKE_PHRASE).toLowerCase().replace(/\s+/g, ' ')
  if (!/^[a-z][a-z' ]{1,58}[a-z]$/.test(wakePhrase) || wakePhrase.split(' ').length > 5) {
    problems.push(
      `CLAP_WAKE_PHRASE="${wakePhrase}" must be 1–5 words of letters, e.g. "hey clap".`,
    )
  } else if (wakePhrase.split(' ').length < 2) {
    problems.push(
      `CLAP_WAKE_PHRASE="${wakePhrase}" is a single word. Use at least two words ` +
        '(e.g. "hey clap") so ordinary conversation does not wake CLAP.',
    )
  }

  // --- permissions ------------------------------------------------------------
  const medium = choice<PolicyAction>('CLAP_POLICY_MEDIUM', ['allow', 'confirm', 'deny'], DEFAULT_RISK_POLICY.medium)
  const rawHigh = text('CLAP_POLICY_HIGH')
  let high: RiskPolicy['high'] = DEFAULT_RISK_POLICY.high
  if (rawHigh === 'allow') {
    problems.push('CLAP_POLICY_HIGH cannot be "allow": high-risk actions always need confirmation. Use confirm or deny.')
  } else if (rawHigh !== undefined) {
    high = choice<RiskPolicy['high']>('CLAP_POLICY_HIGH', ['confirm', 'deny'], DEFAULT_RISK_POLICY.high)
  }

  // --- voice ------------------------------------------------------------------
  const elevenLabsApiKey = text('ELEVENLABS_API_KEY') ?? null
  const voice: BridgeConfig['voice'] = {
    elevenLabsApiKey,
    ttsProvider: choice<VoiceProviderChoice>('CLAP_TTS_PROVIDER', ['auto', 'elevenlabs', 'none'], 'auto'),
    sttProvider: choice<VoiceProviderChoice>('CLAP_STT_PROVIDER', ['auto', 'elevenlabs', 'none'], 'auto'),
    voiceId: text('CLAP_VOICE_ID') ?? null,
    ttsModel: text('CLAP_TTS_MODEL') ?? 'eleven_flash_v2_5',
    sttModel: text('CLAP_STT_MODEL') ?? 'scribe_v1',
    ttsOutputFormat: text('CLAP_TTS_OUTPUT_FORMAT') ?? 'mp3_44100_128',
    stability: num('CLAP_VOICE_STABILITY', 0, 1),
    similarity: num('CLAP_VOICE_SIMILARITY', 0, 1),
    speed: num('CLAP_VOICE_SPEED', 0.7, 1.2),
  }
  if (voice.voiceId && !/^[A-Za-z0-9]{8,64}$/.test(voice.voiceId)) {
    problems.push(`CLAP_VOICE_ID="${voice.voiceId}" does not look like an ElevenLabs voice id.`)
  }
  if (!elevenLabsApiKey && (voice.ttsProvider === 'elevenlabs' || voice.sttProvider === 'elevenlabs')) {
    problems.push('CLAP_TTS_PROVIDER/CLAP_STT_PROVIDER is "elevenlabs" but ELEVENLABS_API_KEY is not set.')
  }

  const config: BridgeConfig = {
    host,
    port,
    uiPort,
    allowedOrigins: [...allowedOrigins],
    allowedHosts: [...allowedHosts],
    allowNoOrigin: flag('CLAP_ALLOW_NO_ORIGIN', false),
    model,
    effort: choice<Effort>('CLAP_EFFORT', EFFORT_LEVELS, 'medium'),
    maxTurns: int('CLAP_MAX_TURNS', 20, 1, 100),
    enableWebSearch: flag('CLAP_ENABLE_WEB_SEARCH', true),
    persistSessions: flag('CLAP_PERSIST_SESSIONS', false),
    sessionGraceMs: int('CLAP_SESSION_GRACE_S', 120, 0, 3600) * 1000,
    wakePhrase,
    policy: { low: 'allow', medium, high },
    confirmTimeoutMs: int('CLAP_CONFIRM_TIMEOUT_S', 45, 5, 300) * 1000,
    dataDir: text('CLAP_DATA_DIR') ?? join(homedir(), '.clap'),
    debug: flag('CLAP_DEBUG', false),
    logFormat: resolveLogFormat(choice('CLAP_LOG_FORMAT', ['pretty', 'json', 'auto'] as const, 'auto')),
    voice,
  }

  if (problems.length) throw new ConfigError(problems)
  return config
}

/** `auto` means readable lines on a terminal and JSON when piped to a file or collector. */
function resolveLogFormat(choice: LogFormat | 'auto'): LogFormat {
  if (choice !== 'auto') return choice
  return process.stdout.isTTY ? 'pretty' : 'json'
}

/** `http://LocalHost:5173/` → `http://localhost:5173`; null if not an origin. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

/** Which cloud speech features are usable, given the configuration. */
export function voiceCapabilities(config: BridgeConfig) {
  const key = Boolean(config.voice.elevenLabsApiKey)
  const tts = key && config.voice.ttsProvider !== 'none'
  const stt = key && config.voice.sttProvider !== 'none'
  return {
    stt: { cloud: stt, provider: stt ? 'elevenlabs' : null },
    tts: { cloud: tts, provider: tts ? 'elevenlabs' : null, customVoice: tts && Boolean(config.voice.voiceId) },
  }
}

/** Every configured secret value, so the logger can scrub them anywhere. */
export function secretValues(config: BridgeConfig): string[] {
  return [config.voice.elevenLabsApiKey].filter((v): v is string => Boolean(v && v.length >= 8))
}

/**
 * The Claude Code subprocess inherits the environment, minus CLAP's own
 * secrets: it has no business holding the ElevenLabs key, and with shell tools
 * disabled nothing should be able to read it anyway — this makes that certain.
 */
export function agentEnvironment(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env }
  delete out.ELEVENLABS_API_KEY
  out.CLAUDE_AGENT_SDK_CLIENT_APP = `clap/${CLAP_VERSION}`
  return out
}
