import { describe, expect, it } from 'vitest'
import { createWakeMatcher, editDistance, phonetic, stripLeadingWake, tokenize } from './wake'

const heyClap = createWakeMatcher('hey clap')

describe('createWakeMatcher("hey clap")', () => {
  it.each(['hey clap', 'Hey, CLAP!', 'hi clap', 'hey klap', 'hey clapp', 'hey claps', 'heyclap', 'ok so hey clap'])(
    'matches %s',
    (text) => {
      expect(heyClap(text).matched).toBe(true)
    },
  )

  it.each(['clap', 'give them a clap', 'hey chap', 'hey slap', 'the audience clapped', 'hey clapton', 'clap hey', 'hey there clap'])(
    'does not match %s',
    (text) => {
      expect(heyClap(text).matched).toBe(false)
    },
  )

  it('returns what followed the phrase, without leading punctuation', () => {
    expect(heyClap("Hey CLAP, what's the time?")).toEqual({ matched: true, index: 0, trailing: "what's the time?" })
    expect(heyClap('um heyclap - lights off')).toEqual({ matched: true, index: 3, trailing: 'lights off' })
    expect(heyClap('hey clap')).toMatchObject({ trailing: '' })
  })
})

describe('custom wake phrases', () => {
  it('works for any phrase, with one edit allowed on long words', () => {
    const computer = createWakeMatcher('okay computer')
    expect(computer('okay computer').matched).toBe(true)
    expect(computer('okay computor').matched).toBe(true)
    expect(computer('okay commuter').matched).toBe(true)
    expect(computer('okay compute').matched).toBe(true)
    expect(computer('okay combustor').matched).toBe(false)
  })

  it('rejects an empty phrase', () => {
    expect(() => createWakeMatcher('  ')).toThrow(/empty/)
  })
})

describe('stripLeadingWake', () => {
  it('removes the phrase only when it addresses CLAP at the start', () => {
    expect(stripLeadingWake('hey clap what is on today', heyClap)).toBe('what is on today')
    expect(stripLeadingWake('okay, um, hey clap, lights off', heyClap)).toBe('lights off')
    expect(stripLeadingWake('tell them hey clap is great', heyClap)).toBe('tell them hey clap is great')
    expect(stripLeadingWake('what is on today', heyClap)).toBe('what is on today')
  })
})

describe('helpers', () => {
  it('tokenizes words with apostrophes and offsets', () => {
    expect(tokenize("What's up, Doc?")).toEqual([
      { word: 'whats', start: 0, end: 6 },
      { word: 'up', start: 7, end: 9 },
      { word: 'doc', start: 11, end: 14 },
    ])
  })

  it('normalises recogniser spellings', () => {
    expect(phonetic('Klapp')).toBe('clap')
    expect(phonetic('clacks')).toBe('clac')
    expect(phonetic('phone')).toBe('fone')
    expect(phonetic('bus')).toBe('bus')
  })

  it('computes edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
  })
})
