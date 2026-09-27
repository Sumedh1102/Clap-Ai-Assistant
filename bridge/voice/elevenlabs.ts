/**
 * ElevenLabs text-to-speech and speech-to-text, called from the bridge so the
 * API key never reaches the browser.
 *
 * Endpoints follow the reference project's working usage (2026):
 *   POST /v1/text-to-speech/{voice_id}/stream   (JSON: text, model_id, voice_settings)
 *   POST /v1/speech-to-text                     (multipart: model_id, file)
 * Model ids are configurable (CLAP_TTS_MODEL, CLAP_STT_MODEL) so an upstream
 * rename is a configuration change, not a code change.
 */

import { DEFAULT_ELEVENLABS_VOICE, type BridgeConfig } from '../config'

const API = 'https://api.elevenlabs.io/v1'

export class VoiceUpstreamError extends Error {
  readonly status: number
  constructor(status: number, detail: string) {
    super(`ElevenLabs responded ${status}${detail ? `: ${detail}` : ''}`)
    this.name = 'VoiceUpstreamError'
    this.status = status
  }
}

type FetchFn = typeof fetch

async function detail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}

export function audioExtension(mime: string): string {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'mp4'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}

export class ElevenLabs {
  private readonly voice: BridgeConfig['voice']
  private readonly apiKey: string
  private readonly fetchFn: FetchFn

  constructor(voice: BridgeConfig['voice'], fetchFn: FetchFn = fetch) {
    if (!voice.elevenLabsApiKey) throw new Error('ElevenLabs needs ELEVENLABS_API_KEY')
    this.voice = voice
    this.apiKey = voice.elevenLabsApiKey
    this.fetchFn = fetchFn
  }

  get voiceId(): string {
    return this.voice.voiceId ?? DEFAULT_ELEVENLABS_VOICE
  }

  /** Start synthesis; the caller streams `body` straight through. */
  async synthesize(text: string, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
    const settings: Record<string, number> = {}
    if (this.voice.stability !== null) settings.stability = this.voice.stability
    if (this.voice.similarity !== null) settings.similarity_boost = this.voice.similarity
    if (this.voice.speed !== null) settings.speed = this.voice.speed

    const url = `${API}/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=${encodeURIComponent(this.voice.ttsOutputFormat)}`
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: this.voice.ttsModel,
        ...(Object.keys(settings).length ? { voice_settings: settings } : {}),
      }),
      signal,
    })
    if (!res.ok || !res.body) throw new VoiceUpstreamError(res.status, await detail(res))
    return { body: res.body, contentType: res.headers.get('content-type') ?? 'audio/mpeg' }
  }

  async transcribe(audio: Buffer, mime: string, signal: AbortSignal): Promise<string> {
    const form = new FormData()
    form.append('model_id', this.voice.sttModel)
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${audioExtension(mime)}`)
    const res = await this.fetchFn(`${API}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
      signal,
    })
    if (!res.ok) throw new VoiceUpstreamError(res.status, await detail(res))
    const data = (await res.json()) as { text?: unknown }
    return typeof data.text === 'string' ? data.text.trim() : ''
  }
}
