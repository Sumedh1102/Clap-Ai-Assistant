/**
 * Finding an ElevenLabs voice for CLAP, for `npm run voice:find`.
 *
 * A voice is either already in the account ("My Voices") or in the public
 * Voice Library, where it must be added to the account before the API will
 * speak with it. Endpoints (not reachable from the development environment,
 * so tested against a mocked upstream only):
 *
 *   GET  /v1/voices                                   the account's voices
 *   GET  /v1/shared-voices?search=…&page_size=…       the Voice Library
 *   POST /v1/voices/add/{public_owner_id}/{voice_id}  add a library voice
 */

import { ELEVENLABS_API, VoiceUpstreamError } from '../../bridge/voice/elevenlabs'

export type FoundVoice = {
  voiceId: string
  name: string
  /** Where it lives: already usable, or in the library and needing to be added. */
  source: 'account' | 'library'
  /** Library voices only: needed to add one to the account. */
  publicOwnerId?: string
  description: string
}

type FetchFn = typeof fetch

async function getJson(fetchFn: FetchFn, apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchFn(`${ELEVENLABS_API}${path}`, {
    ...init,
    headers: { 'xi-api-key': apiKey, accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new VoiceUpstreamError(res.status, detail.slice(0, 300))
  }
  return res.json()
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** "British, male, middle aged — brooding, intense" from whatever labels a voice carries. */
function describe(fields: Record<string, unknown>): string {
  const labels = (fields.labels && typeof fields.labels === 'object' ? fields.labels : {}) as Record<string, unknown>
  const traits = ['accent', 'gender', 'age'].map((k) => text(fields[k]) || text(labels[k])).filter(Boolean)
  const flavour = text(fields.descriptive) || text(labels.descriptive) || text(labels.description)
  return [traits.join(', '), flavour].filter(Boolean).join(' — ')
}

/** Voices whose name contains `query`, the account's first, then the library's. */
export async function findVoices(query: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<FoundVoice[]> {
  const needle = query.trim().toLowerCase()
  const own = (await getJson(fetchFn, apiKey, '/voices')) as { voices?: Array<Record<string, unknown>> }
  const found: FoundVoice[] = (own.voices ?? [])
    .filter((v) => text(v.name).toLowerCase().includes(needle))
    .map((v) => ({ voiceId: text(v.voice_id), name: text(v.name), source: 'account', description: describe(v) }))

  const params = new URLSearchParams({ search: query.trim(), page_size: '10' })
  const library = (await getJson(fetchFn, apiKey, `/shared-voices?${params}`)) as { voices?: Array<Record<string, unknown>> }
  const owned = new Set(found.map((v) => v.voiceId))
  for (const v of library.voices ?? []) {
    const voiceId = text(v.voice_id)
    if (!voiceId || owned.has(voiceId)) continue
    found.push({ voiceId, name: text(v.name), source: 'library', publicOwnerId: text(v.public_owner_id), description: describe(v) })
  }
  return found.filter((v) => v.voiceId && v.name)
}

/** Add a library voice to the account; returns the id to use for speech. */
export async function addLibraryVoice(voice: FoundVoice, apiKey: string, fetchFn: FetchFn = fetch): Promise<string> {
  if (voice.source === 'account') return voice.voiceId
  if (!voice.publicOwnerId) throw new Error(`"${voice.name}" has no owner id, so it cannot be added`)
  const path = `/voices/add/${encodeURIComponent(voice.publicOwnerId)}/${encodeURIComponent(voice.voiceId)}`
  const added = (await getJson(fetchFn, apiKey, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ new_name: voice.name }),
  })) as { voice_id?: unknown }
  return text(added.voice_id) || voice.voiceId
}

/**
 * Set KEY=value in the text of an env file: replace the first line that sets
 * it (commented out or not), or append it. Everything else is kept as is.
 */
export function setEnvValue(file: string, key: string, value: string): string {
  const line = new RegExp(`^[ \\t]*#?[ \\t]*${key}[ \\t]*=.*$`, 'm')
  if (line.test(file)) return file.replace(line, `${key}=${value}`)
  const separator = file === '' || file.endsWith('\n') ? '' : '\n'
  return `${file}${separator}${key}=${value}\n`
}

/** The name of `voiceId` in the account; throws VoiceUpstreamError if the key or voice is not usable. */
export async function voiceName(voiceId: string, apiKey: string, fetchFn: FetchFn = fetch): Promise<string> {
  const voice = (await getJson(fetchFn, apiKey, `/voices/${encodeURIComponent(voiceId)}`)) as { name?: unknown }
  return text(voice.name) || voiceId
}
