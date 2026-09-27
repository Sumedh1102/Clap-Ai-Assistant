import { describe, expect, it } from 'vitest'
import { EchoWindow, isLikelyEcho } from './echo'

const answer = 'The forecast for Lisbon tomorrow is sunny with a high of twenty four degrees.'

describe('isLikelyEcho', () => {
  it('recognises a mangled copy of what CLAP is saying', () => {
    expect(isLikelyEcho('forecast for lisbon tomorrow sunny', answer)).toBe(true)
    expect(isLikelyEcho('the forecast for lisbon is sunny with a high', answer)).toBe(true)
  })

  it('lets a real follow-up through even if it shares common words', () => {
    expect(isLikelyEcho('what about the second one', answer)).toBe(false)
    expect(isLikelyEcho('and what about Porto on Friday', answer)).toBe(false)
  })

  it('lets short override words through even if CLAP just said them', () => {
    expect(isLikelyEcho('no wait', 'There is no file by that name.')).toBe(false)
    expect(isLikelyEcho('stop', 'Say stop to interrupt me.')).toBe(false)
    // A full echoed sentence containing "no" is still echo.
    expect(isLikelyEcho('there is no file by that name', 'There is no file by that name.')).toBe(true)
  })

  it('demands a total match when nothing distinctive was heard', () => {
    expect(isLikelyEcho('it is', 'It is noon.')).toBe(true)
    expect(isLikelyEcho('is it', 'Sunny.')).toBe(false)
    expect(isLikelyEcho('yes', 'Yes.')).toBe(false)
  })

  it('never calls anything echo while CLAP is silent, and drops empty noise', () => {
    expect(isLikelyEcho('forecast for lisbon', '')).toBe(false)
    expect(isLikelyEcho(' ... ', answer)).toBe(true)
  })
})

describe('EchoWindow', () => {
  it('keeps the previous sentence for a short tail after it stops', () => {
    let now = 0
    const window = new EchoWindow(1_000, () => now)
    window.speaking('First sentence.')
    expect(window.text()).toBe('First sentence.')
    window.speaking('Second sentence.')
    expect(window.text()).toBe('Second sentence. First sentence.')
    window.stopped()
    now = 500
    expect(window.text()).toBe('Second sentence.')
    now = 1_000
    expect(window.text()).toBe('')
  })
})
