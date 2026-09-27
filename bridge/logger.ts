/**
 * Structured logging for the bridge.
 *
 * One object per event: timestamp, level, component, event name, and whatever
 * fields matter (sessionId, turnId, tool, ok, durationMs, …). Rendered as JSON
 * lines for collectors, or as one readable line per event on a terminal.
 *
 * Redaction is not optional. Field names that look like credentials are
 * masked, known secret values are scrubbed from every string, and binary data
 * (audio) is reduced to a byte count. The goal is that a log file can be
 * attached to a bug report without a second thought.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

export interface Logger {
  child(bindings: LogFields): Logger
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /** Start timing an operation; `end` logs it with `ok` and `durationMs`. */
  time(event: string, fields?: LogFields): { end(ok: boolean, extra?: LogFields): number }
}

export type LoggerOptions = {
  level?: LogLevel
  format?: 'pretty' | 'json'
  /** Exact secret values to scrub wherever they appear. */
  secrets?: string[]
  /** Where lines go. Defaults to stdout (stderr for warn/error). */
  write?: (line: string, level: LogLevel) => void
  now?: () => Date
  /** Include stack traces for errors. Off unless debugging. */
  stacks?: boolean
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|cookie|credential|xi-api-key)/i

/** Well-known credential shapes, scrubbed even if nobody registered them. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic keys
  /\bsk_[A-Za-z0-9]{20,}\b/g, // ElevenLabs-style keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
]

const MAX_STRING = 2000
const MAX_DEPTH = 5

export function createLogger(options: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info']
  const format = options.format ?? 'json'
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8)
  const now = options.now ?? (() => new Date())
  const write =
    options.write ??
    ((line: string, level: LogLevel) => {
      if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
      else process.stdout.write(`${line}\n`)
    })

  const scrubString = (value: string): string => {
    let out = value
    for (const secret of secrets) out = out.split(secret).join('[redacted]')
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…(${out.length} chars)` : out
  }

  const clean = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return scrubString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) {
      const out: LogFields = { name: value.name, message: scrubString(value.message) }
      const code = (value as { code?: unknown }).code
      if (code !== undefined) out.code = String(code)
      if (options.stacks && value.stack) out.stack = scrubString(value.stack)
      return out
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return `[${value.byteLength} bytes]`
    }
    if (depth >= MAX_DEPTH) return '[…]'
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1))
    if (typeof value === 'object') {
      const out: LogFields = {}
      for (const [key, v] of Object.entries(value as LogFields)) {
        // Numbers and booleans are never credentials ("output_tokens: 812" stays readable).
        const sensitive = SECRET_KEY.test(key) && (typeof v === 'string' || (typeof v === 'object' && v !== null))
        out[key] = sensitive ? '[redacted]' : clean(v, depth + 1)
      }
      return out
    }
    return String(value)
  }

  const emit = (level: LogLevel, event: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return
    const record = clean({ ...bindings, ...fields }, 0) as LogFields
    const ts = now().toISOString()
    write(format === 'json' ? JSON.stringify({ ts, level, event, ...record }) : pretty(ts, level, event, record), level)
  }

  return {
    child: (extra) => createLogger(options, { ...bindings, ...extra }),
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    time(event, fields) {
      const started = performance.now()
      return {
        end(ok, extra) {
          const durationMs = Math.round(performance.now() - started)
          emit(ok ? 'info' : 'warn', event, { ...fields, ...extra, ok, durationMs })
          return durationMs
        },
      }
    },
  }
}

const LEVEL_TAG: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }

/** `06:44:10.123 INFO  agent  turn.complete  session=ab12cd turn=9f00aa ok 1234ms` */
function pretty(ts: string, level: LogLevel, event: string, record: LogFields): string {
  const { component, ok, durationMs, ...rest } = record
  const parts = [ts.slice(11, 23), LEVEL_TAG[level], String(component ?? 'bridge').padEnd(10), event]
  if (ok === true) parts.push('ok')
  if (ok === false) parts.push('FAILED')
  if (typeof durationMs === 'number') parts.push(`${durationMs}ms`)
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    const shown = typeof value === 'string' ? shorten(key, value) : JSON.stringify(value)
    parts.push(`${key}=${shown}`)
  }
  return parts.join('  ')
}

/** Session and turn ids are UUIDs; eight characters is plenty to follow one by eye. */
function shorten(key: string, value: string): string {
  if ((key === 'sessionId' || key === 'turnId') && value.length > 8) return value.slice(0, 8)
  return /\s/.test(value) ? JSON.stringify(value) : value
}

/** A logger that discards everything — for tests. */
export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} })
