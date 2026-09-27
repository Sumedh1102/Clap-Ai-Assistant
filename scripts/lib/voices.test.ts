import { describe, expect, it } from 'vitest'
import { VoiceUpstreamError } from '../../bridge/voice/elevenlabs'
import { addLibraryVoice, findVoices, setEnvValue } from './voices'

type Call = { url: string; init: RequestInit }

function upstream(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    const path = call.url.replace('https://api.elevenlabs.io/v1', '').split('?')[0]!
    const route = routes[`${init?.method ?? 'GET'} ${path}`]
    return route ? route(call) : new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

const account = {
  voices: [
    { voice_id: 'acct-george', name: 'George', labels: { accent: 'british', gender: 'male' } },
    { voice_id: 'acct-dom', name: 'Dominic (mine)', labels: { accent: 'british', descriptive: 'calm' } },
  ],
}
const library = {
  voices: [
    { voice_id: 'lib-dom', public_owner_id: 'owner-1', name: 'Dominic - British, brooding, intense', accent: 'british', gender: 'male', age: 'middle_aged', descriptive: 'intense' },
    { voice_id: 'acct-dom', public_owner_id: 'owner-2', name: 'Dominic (mine)' },
  ],
}

describe('findVoices', () => {
  it('lists matching account voices first, then library voices not already owned', async () => {
    const { fn, calls } = upstream({
      'GET /voices': () => Response.json(account),
      'GET /shared-voices': () => Response.json(library),
    })
    const found = await findVoices('Dominic', 'sk_test', fn)
    expect(found).toEqual([
      { voiceId: 'acct-dom', name: 'Dominic (mine)', source: 'account', description: 'british — calm' },
      {
        voiceId: 'lib-dom',
        name: 'Dominic - British, brooding, intense',
        source: 'library',
        publicOwnerId: 'owner-1',
        description: 'british, male, middle_aged — intense',
      },
    ])
    expect(calls[1]!.url).toBe('https://api.elevenlabs.io/v1/shared-voices?search=Dominic&page_size=10')
    for (const call of calls) expect((call.init.headers as Record<string, string>)['xi-api-key']).toBe('sk_test')
  })

  it('reports upstream failures', async () => {
    const { fn } = upstream({ 'GET /voices': () => new Response('invalid api key', { status: 401 }) })
    const error = await findVoices('x', 'bad', fn).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VoiceUpstreamError)
    expect((error as VoiceUpstreamError).status).toBe(401)
  })
})

describe('addLibraryVoice', () => {
  it('adds a library voice to the account and returns its id', async () => {
    const { fn, calls } = upstream({ 'POST /voices/add/owner-1/lib-dom': () => Response.json({ voice_id: 'new-id' }) })
    const id = await addLibraryVoice(
      { voiceId: 'lib-dom', name: 'Dominic', source: 'library', publicOwnerId: 'owner-1', description: '' },
      'sk_test',
      fn,
    )
    expect(id).toBe('new-id')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ new_name: 'Dominic' })
  })

  it('needs no request for a voice already in the account', async () => {
    const { fn, calls } = upstream({})
    await expect(addLibraryVoice({ voiceId: 'acct-dom', name: 'D', source: 'account', description: '' }, 'k', fn)).resolves.toBe('acct-dom')
    expect(calls).toEqual([])
  })
})

describe('setEnvValue', () => {
  it('replaces the documented, commented-out line in place', () => {
    const file = '# The custom CLAP voice\n# CLAP_VOICE_ID=\nOTHER=1\n'
    expect(setEnvValue(file, 'CLAP_VOICE_ID', 'abc')).toBe('# The custom CLAP voice\nCLAP_VOICE_ID=abc\nOTHER=1\n')
  })

  it('replaces an existing value and leaves similar names alone', () => {
    const file = 'CLAP_VOICE_ID_OLD=x\nCLAP_VOICE_ID=old\n'
    expect(setEnvValue(file, 'CLAP_VOICE_ID', 'new')).toBe('CLAP_VOICE_ID_OLD=x\nCLAP_VOICE_ID=new\n')
  })

  it('appends when the key is absent', () => {
    expect(setEnvValue('', 'CLAP_VOICE_ID', 'abc')).toBe('CLAP_VOICE_ID=abc\n')
    expect(setEnvValue('A=1', 'CLAP_VOICE_ID', 'abc')).toBe('A=1\nCLAP_VOICE_ID=abc\n')
  })
})
