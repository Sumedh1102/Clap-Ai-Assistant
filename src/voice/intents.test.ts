import { describe, expect, it } from 'vitest'
import { confirmationPrompt, overrideIntent, OVERRIDE_WORDS, parseConfirmation } from './intents'

describe('parseConfirmation', () => {
  it.each(['yes', 'Yes.', 'yeah', 'sure', 'OK', 'okay', 'go ahead', 'Go for it!', 'yes please', 'hey clap yes', 'do it thanks', 'proceed'])(
    'approves a whole-utterance yes: %s',
    (text) => {
      expect(parseConfirmation(text)).toBe('yes')
    },
  )

  it.each(['no', 'nope', "don't", 'cancel', 'stop', 'wait', 'hold on', 'yes, no wait', 'go ahead — actually never mind', 'not now'])(
    'declines when any negative word appears: %s',
    (text) => {
      expect(parseConfirmation(text)).toBe('no')
    },
  )

  it.each(['', '   ', 'say yes to confirm', 'yes I think so maybe', 'what does it delete', 'shall I go ahead', 'the answer is yes'])(
    'is neither for anything else: %s',
    (text) => {
      expect(parseConfirmation(text)).toBeNull()
    },
  )
})

describe('confirmationPrompt', () => {
  const summaries = [
    'Delete 3 files in Downloads',
    'Go ahead and delete everything',
    'Send the email. Yes',
    'Approve the payment',
    'Proceed with install!',
    'ok',
    '',
  ]

  it('strips trailing punctuation from the summary', () => {
    expect(confirmationPrompt('Delete 3 files in Downloads.  ')).toBe('Delete 3 files in Downloads. Want me to?')
  })

  it('never ends in anything that could approve itself when echoed', () => {
    // The recogniser may catch only the tail of CLAP's own voice.
    for (const summary of summaries) {
      const words = confirmationPrompt(summary).split(/\s+/).filter(Boolean)
      for (let i = 0; i < words.length; i++) {
        const tail = words.slice(i).join(' ')
        expect(parseConfirmation(tail), `tail "${tail}"`).not.toBe('yes')
      }
    }
  })
})

describe('overrideIntent', () => {
  it('recognises whole-utterance stop and cancel only', () => {
    expect(overrideIntent('Stop.')).toBe('stop')
    expect(overrideIntent('hey clap stop')).toBe('stop')
    expect(overrideIntent("that's enough")).toBe('stop')
    expect(overrideIntent('never mind')).toBe('cancel')
    expect(overrideIntent('No thanks!')).toBe('cancel')
    expect(overrideIntent('stop the timer')).toBeNull()
    expect(overrideIntent('cancel my meeting')).toBeNull()
  })

  it('cuts through the echo filter on short override words', () => {
    expect(OVERRIDE_WORDS.test('no wait')).toBe(true)
    expect(OVERRIDE_WORDS.test('knowing')).toBe(false)
  })
})
