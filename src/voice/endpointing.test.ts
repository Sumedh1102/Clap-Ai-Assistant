import { describe, expect, it } from 'vitest'
import { ENDPOINT_TIMINGS, holdTime, UtteranceAssembler } from './endpointing'

const { settleMs, continueMs, maxHoldMs } = ENDPOINT_TIMINGS

describe('holdTime', () => {
  it('sends a finished sentence at once', () => {
    expect(holdTime('What time is it?')).toBe(0)
    expect(holdTime('Turn it off.')).toBe(0)
    expect(holdTime('He said "go."')).toBe(0)
  })

  it('waits for the rest of an unfinished sentence', () => {
    expect(holdTime('remind me to')).toBe(continueMs)
    expect(holdTime('add milk, eggs,')).toBe(continueMs)
    expect(holdTime('what is the weather in')).toBe(continueMs)
    expect(holdTime('um')).toBe(continueMs)
    expect(holdTime('')).toBe(continueMs)
    // Two words that are not a complete short reply.
    expect(holdTime('play some')).toBe(continueMs)
    expect(holdTime('open spotify')).toBe(continueMs)
  })

  it('settles briefly on complete-looking speech without punctuation', () => {
    expect(holdTime('what time is it')).toBe(settleMs)
    expect(holdTime('thank you')).toBe(settleMs)
    expect(holdTime('Yes')).toBe(settleMs)
    expect(holdTime('never mind')).toBe(settleMs)
  })
})

function fakeTimers() {
  let now = 0
  let pending: { fn: () => void; at: number } | null = null
  return {
    timers: {
      set: (fn: () => void, ms: number) => (pending = { fn, at: now + ms }),
      clear: (handle: unknown) => {
        if (pending === handle) pending = null
      },
      now: () => now,
    },
    advance(ms: number) {
      now += ms
      if (pending && pending.at <= now) {
        const { fn } = pending
        pending = null
        fn()
      }
    },
  }
}

describe('UtteranceAssembler', () => {
  it('joins segments and sends once the thought is finished', () => {
    const { timers, advance } = fakeTimers()
    const sent: string[] = []
    const partials: string[] = []
    const assembler = new UtteranceAssembler({ emit: (t) => sent.push(t), partial: (t) => partials.push(t) }, timers)
    assembler.feed('remind me to')
    advance(continueMs - 1)
    expect(sent).toEqual([])
    assembler.feed(' buy milk ')
    expect(partials).toEqual(['remind me to', 'remind me to buy milk'])
    advance(settleMs)
    expect(sent).toEqual(['remind me to buy milk'])
    expect(assembler.current()).toBe('')
  })

  it('sends punctuated sentences immediately', () => {
    const { timers } = fakeTimers()
    const sent: string[] = []
    new UtteranceAssembler({ emit: (t) => sent.push(t) }, timers).feed('What time is it?')
    expect(sent).toEqual(['What time is it?'])
  })

  it('holds while the user is audibly still speaking, but never past the cap', () => {
    const { timers, advance } = fakeTimers()
    const sent: string[] = []
    const assembler = new UtteranceAssembler({ emit: (t) => sent.push(t) }, timers)
    assembler.feed('so the thing is.', true)
    advance(maxHoldMs - 1)
    expect(sent).toEqual([])
    advance(1)
    expect(sent).toEqual(['so the thing is.'])
  })

  it('discards on cancel and ignores empty segments', () => {
    const { timers, advance } = fakeTimers()
    const sent: string[] = []
    const assembler = new UtteranceAssembler({ emit: (t) => sent.push(t) }, timers)
    assembler.feed('   ')
    assembler.feed('turn off the')
    assembler.cancel()
    advance(maxHoldMs)
    assembler.flush()
    expect(sent).toEqual([])
  })
})
