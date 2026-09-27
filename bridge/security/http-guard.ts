/**
 * Who may talk to the bridge.
 *
 * Two independent checks, both exact-match:
 *
 * Host — defeats DNS rebinding. A page on http://attacker.example:7719 whose
 * name is re-pointed at 127.0.0.1 is same-origin *to itself*, so its GET
 * requests carry no Origin header at all. Its Host header, though, still says
 * attacker.example. Only loopback names on our port are accepted.
 *
 * Origin — a WebSocket handshake is not covered by the same-origin policy: any
 * page in any tab can open ws://127.0.0.1:7719 and the browser will happily
 * attach. The Origin header is the only thing that separates the CLAP HUD from
 * someone else's page, so it must match the allowlist exactly. A missing Origin
 * means a non-browser client (a script, or local malware) and is refused on the
 * socket unless CLAP_ALLOW_NO_ORIGIN=1.
 */

import type { IncomingMessage } from 'node:http'

export type HttpGuardConfig = {
  allowedOrigins: readonly string[]
  allowedHosts: readonly string[]
  allowNoOrigin: boolean
}

export type GuardVerdict = { ok: true } | { ok: false; status: 400 | 403; reason: string }

export function checkHost(host: string | undefined, config: HttpGuardConfig): GuardVerdict {
  if (!host) return { ok: false, status: 400, reason: 'missing Host header' }
  return config.allowedHosts.includes(host.toLowerCase())
    ? { ok: true }
    : { ok: false, status: 403, reason: `host ${host} not allowed` }
}

/**
 * @param requireOrigin true for the WebSocket and for state-changing HTTP calls
 *   (browsers always send Origin on those); false for simple GETs like /health,
 *   which scripts and `npm run doctor` call without one.
 */
export function checkOrigin(
  origin: string | undefined,
  config: HttpGuardConfig,
  requireOrigin: boolean,
): GuardVerdict {
  if (!origin || origin === 'null') {
    if (!requireOrigin || config.allowNoOrigin) return { ok: true }
    return { ok: false, status: 403, reason: 'missing Origin' }
  }
  return config.allowedOrigins.includes(origin.toLowerCase().replace(/\/+$/, ''))
    ? { ok: true }
    : { ok: false, status: 403, reason: `origin ${origin} not allowed` }
}

/** Both checks for one request, in the order that gives the clearest refusal. */
export function guardRequest(
  req: Pick<IncomingMessage, 'headers'>,
  config: HttpGuardConfig,
  requireOrigin: boolean,
): GuardVerdict {
  const host = checkHost(req.headers.host, config)
  if (!host.ok) return host
  return checkOrigin(headerValue(req.headers.origin), config, requireOrigin)
}

/**
 * CORS headers reflecting an *already validated* origin. Never `*`: a wildcard
 * would let any page on the internet read what the bridge returns.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
    headers['access-control-allow-headers'] = 'content-type'
    headers['access-control-max-age'] = '600'
  }
  return headers
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
