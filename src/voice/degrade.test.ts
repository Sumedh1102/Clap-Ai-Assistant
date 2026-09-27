import { describe, expect, it } from 'vitest'
import type { EngineSelection } from './capabilities'
import { degrade } from './input'

const selection = (wake: EngineSelection['wake'], stt: EngineSelection['stt']): EngineSelection => ({
  wake,
  stt,
  tts: ['browser'],
  notes: [],
})
const options = { allowCloudWake: true, cloudStt: false, webSpeech: true }

describe('degrade', () => {
  it('falls back from on-device to cloud recognition', () => {
    expect(degrade(selection('webspeech-local', 'webspeech-local'), 'local-recognition', options)).toMatchObject({
      wake: 'webspeech-cloud',
      stt: 'webspeech-cloud',
    })
    expect(degrade(selection('webspeech-local', 'webspeech-local'), 'local-recognition', { ...options, cloudStt: true, allowCloudWake: false })).toMatchObject({
      wake: 'push-to-talk',
      stt: 'bridge-cloud',
    })
  })

  it('offers push-to-talk after a browser failure only if something can still transcribe', () => {
    const withCloud = degrade(selection('webspeech-cloud', 'webspeech-cloud'), 'browser-recognition', { ...options, cloudStt: true })
    expect(withCloud).toMatchObject({ wake: 'push-to-talk', stt: 'bridge-cloud' })
    expect(withCloud.notes.at(-1)).toMatch(/press Space to talk/)

    const nothingLeft = degrade(selection('webspeech-cloud', 'webspeech-cloud'), 'browser-recognition', options)
    expect(nothingLeft).toMatchObject({ wake: 'push-to-talk', stt: 'none' })
    expect(nothingLeft.notes.at(-1)).toMatch(/type to CLAP instead/)
    expect(nothingLeft.notes.at(-1)).not.toMatch(/Space/)
  })

  it('moves cloud transcription failures to the browser recogniser, if there is one', () => {
    expect(degrade(selection('webspeech-local', 'bridge-cloud'), 'cloud-stt', options)).toMatchObject({ stt: 'webspeech-local' })
    const cloudOnly = degrade(selection('push-to-talk', 'bridge-cloud'), 'cloud-stt', options)
    expect(cloudOnly.stt).toBe('webspeech-cloud')
    expect(cloudOnly.notes.at(-1)).toMatch(/using the browser recogniser/)

    const nothingLeft = degrade(selection('push-to-talk', 'bridge-cloud'), 'cloud-stt', { ...options, webSpeech: false })
    expect(nothingLeft.stt).toBe('none')
    expect(nothingLeft.notes.at(-1)).toMatch(/type to CLAP instead/)
  })

  it('keeps earlier notes', () => {
    const start = { ...selection('webspeech-cloud', 'webspeech-cloud'), notes: ['first'] }
    expect(degrade(start, 'browser-recognition', options).notes[0]).toBe('first')
  })
})
