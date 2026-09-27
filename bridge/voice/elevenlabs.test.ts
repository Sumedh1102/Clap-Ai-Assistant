import { describe, expect, it } from 'vitest'
import { DEFAULT_ELEVENLABS_VOICE, parseConfig } from '../config'
import { audioExtension, ElevenLabs, VoiceUpstreamError } from './elevenlabs'

type Call = { url: string; init: RequestInit }

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { fn, calls }
}

const voiceConfig = (env: NodeJS.ProcessEnv = {}) => parseConfig({ ELEVENLABS_API_KEY: 'sk_test_0123456789', ...env }).voice

describe('ElevenLabs', () => {
  it('refuses to exist without a key', () => {
    expect(() => new ElevenLabs(parseConfig({}).voice)).toThrow(/ELEVENLABS_API_KEY/)
  })

  it('streams synthesis from the default voice with the key in a header only', async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }))
    const voice = new ElevenLabs(voiceConfig(), fn)
    const out = await voice.synthesize('Hello there.', new AbortController().signal)

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE}/stream?output_format=mp3_44100_128`)
    expect(url).not.toContain('sk_test')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('sk_test_0123456789')
    // No tuning configured: the voice's own settings apply.
    expect(JSON.parse(String(init.body))).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' })
    expect(out.contentType).toBe('audio/mpeg')
    expect(new Uint8Array(await new Response(out.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sends the custom voice and only the tuning that is set', async () => {
    const { fn, calls } = fakeFetch(() => new Response('audio'))
    const voice = new ElevenLabs(voiceConfig({ CLAP_VOICE_ID: 'CustomVoice01', CLAP_VOICE_STABILITY: '0.4', CLAP_VOICE_SPEED: '1.1' }), fn)
    await voice.synthesize('Hi', new AbortController().signal)
    expect(calls[0]!.url).toContain('/text-to-speech/CustomVoice01/stream')
    expect(JSON.parse(String(calls[0]!.init.body)).voice_settings).toEqual({ stability: 0.4, speed: 1.1 })
  })

  it('turns an upstream failure into a bounded error', async () => {
    const { fn } = fakeFetch(() => new Response('x'.repeat(1000), { status: 401 }))
    const voice = new ElevenLabs(voiceConfig(), fn)
    const error = await voice.synthesize('Hi', new AbortController().signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VoiceUpstreamError)
    expect((error as VoiceUpstreamError).status).toBe(401)
    expect((error as Error).message.length).toBeLessThan(340)
  })

  it('uploads audio for transcription as multipart and trims the text', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ text: '  what time is it  ' }))
    const voice = new ElevenLabs(voiceConfig({ CLAP_STT_MODEL: 'scribe_v2' }), fn)
    const text = await voice.transcribe(Buffer.from('audio-bytes'), 'audio/webm', new AbortController().signal)
    expect(text).toBe('what time is it')

    const { url, init } = calls[0]!
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    const form = init.body as FormData
    expect(form.get('model_id')).toBe('scribe_v2')
    const file = form.get('file') as File
    expect(file.name).toBe('speech.webm')
    expect(file.type).toBe('audio/webm')
    expect(await file.text()).toBe('audio-bytes')
  })

  it('treats a missing transcript as silence and a failure as an error', async () => {
    const empty = new ElevenLabs(voiceConfig(), fakeFetch(() => Response.json({})).fn)
    await expect(empty.transcribe(Buffer.from('a'), 'audio/ogg', new AbortController().signal)).resolves.toBe('')
    const failing = new ElevenLabs(voiceConfig(), fakeFetch(() => new Response('quota', { status: 429 })).fn)
    await expect(failing.transcribe(Buffer.from('a'), 'audio/ogg', new AbortController().signal)).rejects.toBeInstanceOf(
      VoiceUpstreamError,
    )
  })
})

describe('audioExtension', () => {
  it('maps recorder MIME types to file extensions', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(audioExtension('audio/ogg;codecs=opus')).toBe('ogg')
    expect(audioExtension('audio/mp4')).toBe('mp4')
    expect(audioExtension('audio/mpeg')).toBe('mp3')
    expect(audioExtension('audio/wav')).toBe('wav')
  })
})
