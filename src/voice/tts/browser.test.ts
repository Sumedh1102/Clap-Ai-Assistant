import { describe, expect, it } from 'vitest'
import { scoreVoice } from './browser'

const voice = (name: string, lang: string, localService = false) => ({ name, lang, localService })

const rank = (voices: ReturnType<typeof voice>[], lang: string) =>
  voices
    .map((v) => ({ v, s: scoreVoice(v, lang) }))
    .filter((x) => x.s > 0)
    .toSorted((a, b) => b.s - a.s)
    .map((x) => x.v.name)

describe('scoreVoice', () => {
  it('prefers a natural British male voice to match the cloud voice', () => {
    const edge = [
      voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
      voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'),
      voice('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB'),
    ]
    expect(rank(edge, 'en-US')[0]).toMatch(/Ryan/)

    const chrome = [voice('Google US English', 'en-US'), voice('Google UK English Female', 'en-GB'), voice('Google UK English Male', 'en-GB')]
    expect(rank(chrome, 'en-US')[0]).toBe('Google UK English Male')

    const mac = [voice('Samantha', 'en-US', true), voice('Daniel', 'en-GB', true), voice('Karen', 'en-AU', true)]
    expect(rank(mac, 'en-US')[0]).toBe('Daniel')
  })

  it('keeps the listener’s language and drops novelty voices', () => {
    expect(scoreVoice(voice('Thomas', 'fr-FR'), 'en-US')).toBeLessThan(0)
    expect(scoreVoice(voice('Bad News', 'en-US'), 'en-US')).toBeLessThan(0)
    expect(rank([voice('Anna', 'de-DE'), voice('Daniel', 'en-GB')], 'de-DE')).toEqual(['Anna'])
  })
})
