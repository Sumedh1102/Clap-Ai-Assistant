import { describe, expect, it } from 'vitest'
import { sanitizeForDisplay, toSpeakable } from './text'

describe('sanitizeForDisplay', () => {
  it('removes control, bidi-override and zero-width characters', () => {
    expect(sanitizeForDisplay('a\u0000b\u0007c\u009bd')).toBe('abcd')
    // "evil‮txt.exe" would render reversed.
    expect(sanitizeForDisplay('file‮txt.exe')).toBe('filetxt.exe')
    expect(sanitizeForDisplay('pay​pal﻿')).toBe('paypal')
    expect(sanitizeForDisplay('line\nbreak\ttab')).toBe('line\nbreak\ttab')
  })

  it('bounds the length', () => {
    expect(sanitizeForDisplay('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('toSpeakable', () => {
  it('drops markdown syntax and keeps the words', () => {
    expect(toSpeakable('## Heading\n- **bold** item\n1. _first_ `code`\n> quoted ~~old~~')).toBe(
      'Heading bold item first code quoted old',
    )
  })

  it('never reads code blocks or URLs aloud', () => {
    expect(toSpeakable('Run this:\n```\nrm -rf /\n```\nThen relax.')).toBe('Run this: Then relax.')
    expect(toSpeakable('See [the docs](https://example.com/a?b=c) for more.')).toBe('See the docs for more.')
    expect(toSpeakable('It is at https://example.com/page.')).toBe('It is at .')
    expect(toSpeakable('Sources: https://a.example/x, https://b.example/y; done')).toBe('Sources: , ; done')
    expect(toSpeakable('(https://en.wikipedia.org/wiki/Foo_(bar)) ok')).toBe('()) ok')
  })

  it('removes emoji', () => {
    expect(toSpeakable('Done 👍🏽 🇵🇹 ❤️')).toBe('Done 🏽')
  })

  it('stays fast on hostile input', () => {
    const hostile = [
      `http://a${'.'.repeat(20_000)}x`,
      `http://${'.,'.repeat(10_000)})x`,
      '[a]('.repeat(5_000),
      '*a'.repeat(10_000),
      '```'.repeat(6_000),
    ]
    for (const input of hostile) {
      const started = performance.now()
      toSpeakable(input)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })
})
