import { createServer, type Server } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandIPv6, FetchError, guardedFetch, guardedLookup, isBlockedAddress, isBlockedIPv4, isBlockedIPv6, vetUrl } from './ssrf'

const vetCode = (raw: string): string => {
  try {
    vetUrl(raw)
    return 'ok'
  } catch (error) {
    return (error as FetchError).code
  }
}

const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'ok'
  } catch (error) {
    expect(error).toBeInstanceOf(FetchError)
    return (error as FetchError).code
  }
}

/** Resolve every name to the test server, as if it were a public site. */
const toTestServer: LookupFunction = (_host, options, callback) => {
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
  else callback(null, '127.0.0.1', 4)
}

/** Resolve through the real guard, which sees localhost's private answer. */
const viaGuard: LookupFunction = (_host, options, callback) => guardedLookup('localhost', options, callback)

describe('isBlockedIPv4', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '1.2.3',
    'not an ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1'])(
    'allows %s',
    (ip) => {
      expect(isBlockedIPv4(ip)).toBe(false)
    },
  )
})

describe('expandIPv6', () => {
  it('expands compressed forms and embedded dotted quads', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIPv6('2001:db8::8:800:200c:417a')).toEqual([0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a])
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
    expect(expandIPv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
  })

  it.each(['1::2::3', 'gggg::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '::ffff:1.2.3.256', '1:2:3:4:5:6:7::8'])(
    'rejects %s',
    (ip) => {
      expect(expandIPv6(ip)).toBeNull()
    },
  )
})

describe('isBlockedIPv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated (SIIT) loopback'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['64:ff9b::10.0.0.1', 'NAT64 of a private address'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['100::1', 'discard-only'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['2002:7f00:1::1', '6to4 of loopback'],
    ['2002:c0a8:101::1', '6to4 of 192.168.1.1'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['5f00::1', 'outside global unicast'],
    ['1::1', 'outside global unicast'],
    ['nonsense', 'malformed'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(true)
  })

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1'])(
    'allows %s',
    (ip) => {
      expect(isBlockedIPv6(ip)).toBe(false)
    },
  )
})

describe('isBlockedAddress', () => {
  it('accepts bracketed IPv6 and refuses anything that is not an address', () => {
    expect(isBlockedAddress('[::1]')).toBe(true)
    expect(isBlockedAddress('[2606:4700:4700::1111]')).toBe(false)
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('example.com')).toBe(true)
  })
})

describe('vetUrl', () => {
  it('accepts ordinary public URLs', () => {
    expect(vetCode('https://example.com/a?b=c')).toBe('ok')
    expect(vetCode('http://example.com:8080/')).toBe('ok')
    expect(vetCode('http://example.com:443/')).toBe('ok')
    expect(vetCode('https://[2606:4700:4700::1111]/')).toBe('ok')
  })

  it('refuses other schemes, credentials and low ports', () => {
    expect(vetCode('not a url')).toBe('invalid_url')
    expect(vetCode('ftp://example.com/')).toBe('bad_scheme')
    expect(vetCode('file:///etc/passwd')).toBe('bad_scheme')
    expect(vetCode('javascript:alert(1)')).toBe('bad_scheme')
    expect(vetCode('http://user:pw@example.com/')).toBe('credentials_in_url')
    expect(vetCode('http://user@example.com/')).toBe('credentials_in_url')
    expect(vetCode('http://example.com:22/')).toBe('blocked_port')
    expect(vetCode('http://example.com:25/')).toBe('blocked_port')
  })

  it.each([
    'http://localhost/',
    'http://localhost./',
    'http://LOCALHOST:8080/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://router.home.arpa/',
    'http://nas.lan/',
    'http://wiki.corp/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://10.0.0.1:8080/',
  ])('refuses %s', (raw) => {
    expect(vetCode(raw)).toBe('blocked_address')
  })
})

describe('guardedLookup', () => {
  it('refuses a name that resolves to a private address', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup('localhost', {}, (err) => resolve(err))
    })
    expect(error?.code).toBe('EBLOCKEDADDRESS')
  })
})

describe('guardedFetch', () => {
  let server: Server
  let port = 0
  const site = (path: string) => `http://site.test:${port}${path}`
  const options = { maxBytes: 1_000, timeoutMs: 2_000, lookup: toTestServer }

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case '/hello':
          res.writeHead(200, { 'content-type': 'text/html; charset=ISO-8859-1' })
          return res.end('<p>hello</p>')
        case '/gzip':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
          return res.end(gzipSync('compressed hello'))
        case '/bomb':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
          return res.end(gzipSync(Buffer.alloc(5_000_000)))
        case '/declared-large':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5000' })
          return res.end('x'.repeat(5000))
        case '/streamed-large':
          res.writeHead(200, { 'content-type': 'text/plain' })
          for (let i = 0; i < 20; i++) res.write('y'.repeat(100))
          return res.end()
        case '/redirect':
          res.writeHead(302, { location: '/hello' })
          return res.end()
        case '/to-loopback':
          res.writeHead(301, { location: `http://127.0.0.1:${port}/hello` })
          return res.end()
        case '/to-localhost':
          res.writeHead(307, { location: `http://localhost:${port}/hello` })
          return res.end()
        case '/to-file':
          res.writeHead(302, { location: 'file:///etc/passwd' })
          return res.end()
        case '/loop':
          res.writeHead(302, { location: '/loop' })
          return res.end()
        case '/slow':
          return // never answers
        default:
          res.writeHead(404)
          return res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('fetches a page and reports its type and charset', async () => {
    const res = await guardedFetch(site('/hello'), options)
    expect(res).toMatchObject({ status: 200, contentType: 'text/html', charset: 'iso-8859-1', finalUrl: site('/hello') })
    expect(res.body.toString()).toBe('<p>hello</p>')
  })

  it('decompresses bodies', async () => {
    const res = await guardedFetch(site('/gzip'), options)
    expect(res.body.toString()).toBe('compressed hello')
  })

  it('follows a same-site redirect and reports where it landed', async () => {
    const res = await guardedFetch(site('/redirect'), options)
    expect(res.finalUrl).toBe(site('/hello'))
  })

  it('vets every redirect hop', async () => {
    expect(await failure(guardedFetch(site('/to-loopback'), options))).toBe('blocked_address')
    expect(await failure(guardedFetch(site('/to-localhost'), options))).toBe('blocked_address')
    expect(await failure(guardedFetch(site('/to-file'), options))).toBe('bad_scheme')
    expect(await failure(guardedFetch(site('/loop'), options))).toBe('too_many_redirects')
  })

  it('caps the body, after decompression', async () => {
    expect(await failure(guardedFetch(site('/declared-large'), options))).toBe('too_large')
    expect(await failure(guardedFetch(site('/streamed-large'), options))).toBe('too_large')
    expect(await failure(guardedFetch(site('/bomb'), options))).toBe('too_large')
  })

  it('times out and reports HTTP errors', async () => {
    expect(await failure(guardedFetch(site('/slow'), { ...options, timeoutMs: 150 }))).toBe('timeout')
    expect(await failure(guardedFetch(site('/missing'), options))).toBe('http_status')
  })

  it('refuses when the real DNS guard sees a private answer', async () => {
    expect(await failure(guardedFetch(site('/hello'), { ...options, lookup: viaGuard }))).toBe('blocked_address')
  })
})
