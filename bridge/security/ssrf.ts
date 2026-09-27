/**
 * Outbound fetches for tools, behind an SSRF gate.
 *
 * Every URL a tool fetches was chosen by a model that may have just read an
 * untrusted web page. Unlike a browser tab, this process can reach the LAN,
 * the router's admin page and cloud metadata endpoints — so the rules are:
 *
 *   1. Only http(s), no embedded credentials, no internal-looking hostnames,
 *      no privileged ports other than 80/443.
 *   2. IP literals are judged before any socket opens.
 *   3. Names are resolved ONCE, inside the socket's own `lookup` hook, and the
 *      whole name is refused if ANY answer is private. The connect uses the
 *      vetted address, so a DNS rebind between check and connect is impossible.
 *   4. Redirects are followed by hand and every hop is vetted again.
 *   5. Bodies are capped (after decompression, so a gzip bomb is refused) and
 *      every request has a deadline.
 *
 * The design follows the SSRF gate in adewaskar/jarvis (bridge/net.mjs, MIT);
 * this is a TypeScript re-implementation with a wider IPv6 table (NAT64, 6to4,
 * Teredo and other embeddings of IPv4).
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, isIPv4, isIPv6, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'

/** Messages are written for the user, so tools may repeat them verbatim. */
export class FetchError extends Error {
  readonly userSafe = true
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FetchError'
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** True for any IPv4 address a tool must never connect to. */
export function isBlockedIPv4(address: string): boolean {
  if (!isIPv4(address)) return true
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number]
  return (
    a === 0 || // "this network" — routes to the local host
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, tailnets
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  )
}

/** Expand an IPv6 address into eight 16-bit groups, or null if malformed. */
export function expandIPv6(address: string): number[] | null {
  let addr = address.split('%')[0]!.toLowerCase()
  // A trailing dotted quad ("::ffff:1.2.3.4") becomes two groups.
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (quad) {
    if (!isIPv4(quad[1]!)) return null
    const [p, q, r, s] = quad[1]!.split('.').map(Number) as [number, number, number, number]
    addr = addr.slice(0, quad.index) + `${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** True for any IPv6 address a tool must never connect to. */
export function isBlockedIPv6(address: string): boolean {
  const g = expandIPv6(address)
  if (!g) return true
  const [a, b, c, d, e, f, h7, h8] = g as [number, number, number, number, number, number, number, number]
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0)

  if (zeroTo(8)) return true // :: unspecified
  if (zeroTo(7) && h8 === 1) return true // ::1 loopback
  if (zeroTo(5) && f === 0xffff) return isBlockedIPv4(v4FromGroups(h7, h8)) // IPv4-mapped
  if (zeroTo(6)) return true // IPv4-compatible (deprecated) and other ::/96
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return isBlockedIPv4(v4FromGroups(h7, h8)) // NAT64 well-known prefix
  }
  if (a === 0x64 && b === 0xff9b && c === 1) return true // local-use NAT64
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true // discard-only
  if (a === 0x2001 && b < 0x200) return true // IETF assignments, incl. Teredo 2001::/32
  if (a === 0x2001 && b === 0xdb8) return true // documentation
  if (a === 0x2002) return isBlockedIPv4(v4FromGroups(b, c)) // 6to4 embeds an IPv4
  if ((a & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true // link-local
  if ((a & 0xffc0) === 0xfec0) return true // site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true // multicast
  return false
}

/** True for any address (v4 or v6, bracketed or not) a tool must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '')
  if (isIPv4(bare)) return isBlockedIPv4(bare)
  if (isIPv6(bare.split('%')[0]!)) return isBlockedIPv6(bare)
  return true
}

/**
 * Names that never mean a public website. `.local` is mDNS (printers, NAS
 * boxes); the rest are conventional internal suffixes.
 */
const INTERNAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/i

const ALLOWED_LOW_PORTS = new Set(['', '80', '443'])

/** Parse and vet a URL. Throws FetchError with a speakable message. */
export function vetUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new FetchError(400, 'invalid_url', 'That is not a valid web address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(400, 'bad_scheme', 'Only http and https addresses can be fetched.')
  }
  if (url.username || url.password) {
    throw new FetchError(400, 'credentials_in_url', 'Addresses with embedded credentials are not fetched.')
  }
  if (!ALLOWED_LOW_PORTS.has(url.port) && Number(url.port) < 1024) {
    throw new FetchError(403, 'blocked_port', 'That port is not one CLAP fetches from.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new FetchError(400, 'invalid_url', 'That address has no host.')
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw blockedError()
  } else if (!host.includes('.') || INTERNAL_NAME.test(host.replace(/\.$/, ''))) {
    throw blockedError()
  }
  return url
}

const blockedError = () =>
  new FetchError(403, 'blocked_address', 'That address is on a private or local network, which CLAP does not fetch.')

/**
 * The DNS hook every outbound socket uses. Resolves once, refuses the name if
 * any answer is private, and hands the vetted address straight to connect.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[]
    if (!list.length) return callback(new Error(`no address for ${hostname}`), '', 0)
    for (const entry of list) {
      if (isBlockedAddress(entry.address)) {
        const blocked = Object.assign(new Error(`${hostname} resolves to a private address`), {
          code: 'EBLOCKEDADDRESS',
        })
        return callback(blocked, '', 0)
      }
    }
    if (options.all) return callback(null, list)
    return callback(null, list[0]!.address, list[0]!.family)
  })
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 CLAP/0.1'

export type GuardedFetchOptions = {
  maxBytes: number
  timeoutMs: number
  accept?: string
  maxRedirects?: number
  signal?: AbortSignal
  /** For tests: replaces the DNS hook. */
  lookup?: LookupFunction
}

export type GuardedResponse = {
  status: number
  contentType: string
  charset: string | null
  body: Buffer
  finalUrl: string
}

function requestOnce(url: URL, options: GuardedFetchOptions, deadline: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const reqOptions: RequestOptions = {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: options.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
      lookup: options.lookup ?? guardedLookup,
      agent: false,
      signal: deadline,
    }
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, reqOptions)
    req.on('response', resolve)
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EBLOCKEDADDRESS') reject(blockedError())
      else if (deadline.aborted) reject(new FetchError(504, 'timeout', 'The site took too long to answer.'))
      else reject(new FetchError(502, 'unreachable', 'The site could not be reached.'))
    })
    req.end()
  })
}

function decoded(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim()
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(createGunzip())
  if (encoding === 'deflate') return res.pipe(createInflate())
  if (encoding === 'br') return res.pipe(createBrotliDecompress())
  return res
}

/** GET a URL through the gate, following up to `maxRedirects` vetted hops. */
export async function guardedFetch(raw: string, options: GuardedFetchOptions): Promise<GuardedResponse> {
  const deadline = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs)
  const maxRedirects = options.maxRedirects ?? 4
  let url = vetUrl(raw)

  for (let hop = 0; ; hop++) {
    const res = await requestOnce(url, options, deadline)
    const status = res.statusCode ?? 0
    const location = res.headers.location
    if (status >= 300 && status < 400 && location) {
      res.resume()
      if (hop >= maxRedirects) throw new FetchError(508, 'too_many_redirects', 'The site redirected too many times.')
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw new FetchError(502, 'bad_redirect', 'The site sent a broken redirect.')
      }
      url = vetUrl(next.href)
      continue
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new FetchError(status === 404 ? 404 : 502, 'http_status', `The site answered with status ${status}.`)
    }

    const declared = Number(res.headers['content-length'])
    if (Number.isFinite(declared) && declared > options.maxBytes && !res.headers['content-encoding']) {
      res.resume()
      throw new FetchError(413, 'too_large', 'That page is too large to read.')
    }

    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of decoded(res)) {
        size += (chunk as Buffer).length
        if (size > options.maxBytes) {
          res.destroy()
          throw new FetchError(413, 'too_large', 'That page is too large to read.')
        }
        chunks.push(chunk as Buffer)
      }
    } catch (err) {
      if (err instanceof FetchError) throw err
      if (deadline.aborted) throw new FetchError(504, 'timeout', 'The site took too long to answer.')
      throw new FetchError(502, 'bad_body', 'The page could not be read.')
    }

    const typeHeader = String(res.headers['content-type'] ?? '')
    const contentType = typeHeader.split(';')[0]!.trim().toLowerCase()
    const charset = /charset=["']?([\w-]+)/i.exec(typeHeader)?.[1]?.toLowerCase() ?? null
    return { status, contentType, charset, body: Buffer.concat(chunks), finalUrl: url.href }
  }
}
