import { describe, expect, it } from 'vitest'
import { EchoWindow } from '../echo'
import { FallbackVoiceProvider } from './fallback'
import { Speaker } from './speaker'
import { VoiceError, type SpeakOptions, type VoiceProvider } from './types'

/** A provider whose playback the test finishes by hand. */
class FakeVoice implements VoiceProvider {
  readonly id: string
  readonly spoken: string[] = []
  readonly prepared: string[] = []
  stops = 0
  private playing: { resolve: () => void; reject: (e: unknown) => void } | null = null
  failWith: Error | null = null

  constructor(id = 'fake') {
    this.id = id
  }

  getCapabilities() {
    return { id: this.id, cloud: false, customVoice: false, analysable: false }
  }
  prepare(text: string) {
    this.prepared.push(text)
  }
  speak(text: string, options: SpeakOptions): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith)
    this.spoken.push(text)
    return new Promise((resolve, reject) => {
      this.playing = { resolve, reject }
      options.signal.addEventListener('abort', () => resolve(), { once: true })
      options.onStart?.()
    })
  }
  /** Finish the sentence now playing. */
  finish() {
    const playing = this.playing
    this.playing = null
    playing?.resolve()
  }
  stop() {
    this.stops++
    this.finish()
  }
  isSpeaking() {
    return this.playing !== null
  }
  level() {
    return this.playing ? 0.5 : 0
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Speaker', () => {
  it('speaks sentences in order as they stream in, preparing the next', async () => {
    const voice = new FakeVoice()
    const events: string[] = []
    const echo = new EchoWindow()
    const speaker = new Speaker(voice, { onAudible: () => events.push('audible'), onSilent: () => events.push('silent') }, echo)

    speaker.push('It is **noon**. The weather is ')
    expect(voice.spoken).toEqual(['It is noon.'])
    expect(echo.text()).toBe('It is noon.')
    speaker.push('fine. Anything else?')
    expect(voice.prepared).toEqual(['The weather is fine.'])

    const ended = speaker.end()
    voice.finish()
    await tick()
    expect(voice.spoken).toEqual(['It is noon.', 'The weather is fine.'])
    voice.finish()
    await tick()
    voice.finish()
    await ended
    expect(voice.spoken).toEqual(['It is noon.', 'The weather is fine.', 'Anything else?'])
    expect(events).toEqual(['audible', 'audible', 'audible', 'silent'])
    expect(speaker.hasSpoken).toBe(true)
  })

  it('never reads a code block aloud, even streamed line by line', async () => {
    const voice = new FakeVoice()
    const speaker = new Speaker(voice)
    for (const delta of ['Run this:\n`', '``bash\nrm -rf ~/tmp\n', '```\n']) speaker.push(delta)
    const ended = speaker.end()
    voice.finish()
    await ended
    expect(voice.spoken).toEqual(['Run this:'])

    const said = new FakeVoice()
    const notice = new Speaker(said)
    notice.say('Try:\n```\nnpm test\n```\nThat is all.')
    const done = notice.end()
    said.finish()
    await tick()
    said.finish()
    await done
    expect(said.spoken).toEqual(['Try:', 'That is all.'])
  })

  it('skips text with nothing to say', async () => {
    const voice = new FakeVoice()
    const speaker = new Speaker(voice)
    speaker.push('```\ncode only\n```\n')
    speaker.push('https://example.com/ ')
    await speaker.end()
    expect(voice.spoken).toEqual([])
    expect(speaker.hasSpoken).toBe(false)
  })

  it('stops at once on cancel, settles end(), and ignores later text', async () => {
    const voice = new FakeVoice()
    const speaker = new Speaker(voice)
    speaker.push('One. Two. Three. ')
    const ended = speaker.end()
    speaker.cancel()
    await ended
    expect(voice.spoken).toEqual(['One.'])
    expect(voice.stops).toBe(1)
    speaker.push('Four. ')
    speaker.say('Five.')
    await speaker.end()
    expect(voice.spoken).toEqual(['One.'])
    expect(speaker.isCancelled).toBe(true)
  })

  it('reports a failed sentence and carries on with the next', async () => {
    const voice = new FakeVoice()
    const errors: unknown[] = []
    const speaker = new Speaker(voice, { onError: (e) => errors.push(e) })
    voice.failWith = new VoiceError('fake', 'broken')
    speaker.say('First.')
    await tick()
    voice.failWith = null
    speaker.say('Second.')
    const ended = speaker.end()
    voice.finish()
    await ended
    expect(errors).toHaveLength(1)
    expect(voice.spoken).toEqual(['Second.'])
  })
})

describe('FallbackVoiceProvider', () => {
  it('retries a failed sentence on the next voice and skips a voice after two failures', async () => {
    const cloud = new FakeVoice('cloud')
    const browser = new FakeVoice('browser')
    const fallbacks: Array<[string, string | null]> = []
    const chain = new FallbackVoiceProvider([cloud, browser], (from, to) => fallbacks.push([from, to]))
    cloud.failWith = new VoiceError('cloud', 'offline')
    const signal = new AbortController().signal

    const first = chain.speak('One.', { signal })
    await tick()
    browser.finish()
    await first
    expect(browser.spoken).toEqual(['One.'])
    expect(chain.id).toBe('cloud')

    const second = chain.speak('Two.', { signal })
    await tick()
    browser.finish()
    await second
    // Two failures in a row: the cloud voice is out for the session.
    expect(chain.id).toBe('browser')
    expect(fallbacks).toEqual([
      ['cloud', 'browser'],
      ['cloud', 'browser'],
    ])
  })

  it('throws when no voice can speak, and stays quiet when aborted', async () => {
    const only = new FakeVoice('only')
    only.failWith = new VoiceError('only', 'nope')
    const chain = new FallbackVoiceProvider([only])
    await expect(chain.speak('Hi.', { signal: new AbortController().signal })).rejects.toThrow('no voice is available')
    await expect(chain.speak('Hi.', { signal: AbortSignal.abort() })).resolves.toBeUndefined()
    expect(() => new FallbackVoiceProvider([])).toThrow()
  })

  it('stops every voice in the chain', () => {
    const a = new FakeVoice('a')
    const b = new FakeVoice('b')
    new FallbackVoiceProvider([a, b]).stop()
    expect([a.stops, b.stops]).toEqual([1, 1])
  })
})
