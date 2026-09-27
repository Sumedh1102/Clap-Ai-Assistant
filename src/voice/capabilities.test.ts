import { describe, expect, it } from 'vitest'
import type { Capabilities } from '../../shared/protocol'
import { describeEngines, selectEngines, type BrowserCapabilities, type EnginePreferences } from './capabilities'

const chromeLocal: BrowserCapabilities = {
  secureContext: true,
  microphone: true,
  mediaRecorder: true,
  webSpeech: true,
  localRecognition: 'available',
  speechSynthesis: true,
  audioWorklet: true,
  webgl: true,
}
const chromeCloudOnly: BrowserCapabilities = { ...chromeLocal, localRecognition: 'unavailable' }
const firefox: BrowserCapabilities = { ...chromeLocal, webSpeech: false, localRecognition: 'unavailable' }
const noMic: BrowserCapabilities = { ...chromeLocal, microphone: false }

const bridgeNone: Capabilities = { stt: { cloud: false, provider: null }, tts: { cloud: false, provider: null, customVoice: false } }
const bridgeCloud: Capabilities = {
  stt: { cloud: true, provider: 'elevenlabs' },
  tts: { cloud: true, provider: 'elevenlabs', customVoice: true },
}

const auto: EnginePreferences = { wake: 'auto', allowCloudWake: true, stt: 'auto', tts: 'auto' }

describe('selectEngines', () => {
  it('prefers on-device wake and cloud speech when both exist', () => {
    expect(selectEngines(chromeLocal, bridgeCloud, auto)).toMatchObject({
      wake: 'webspeech-local',
      stt: 'bridge-cloud',
      tts: ['bridge-cloud', 'browser'],
    })
  })

  it('uses the browser cloud recogniser for wake only when allowed', () => {
    expect(selectEngines(chromeCloudOnly, bridgeNone, auto).wake).toBe('webspeech-cloud')
    const refused = selectEngines(chromeCloudOnly, bridgeNone, { ...auto, allowCloudWake: false })
    expect(refused.wake).toBe('push-to-talk')
    expect(refused.notes.join(' ')).toMatch(/Space/)
    expect(selectEngines(chromeCloudOnly, bridgeNone, { ...auto, wake: 'local' }).wake).toBe('push-to-talk')
  })

  it('never uses paid cloud STT as a wake engine', () => {
    // A browser with no recogniser at all, but cloud STT on the bridge.
    const selection = selectEngines(firefox, bridgeCloud, auto)
    expect(selection.wake).toBe('push-to-talk')
    expect(selection.stt).toBe('bridge-cloud')
  })

  it('respects explicit preferences, with the other engine as fallback', () => {
    expect(selectEngines(chromeLocal, bridgeCloud, { ...auto, stt: 'browser' }).stt).toBe('webspeech-local')
    expect(selectEngines(chromeCloudOnly, bridgeCloud, { ...auto, stt: 'browser' }).stt).toBe('webspeech-cloud')
    expect(selectEngines(chromeLocal, bridgeCloud, { ...auto, tts: 'browser' }).tts).toEqual(['browser'])
    expect(selectEngines(chromeLocal, bridgeCloud, { ...auto, wake: 'cloud' }).wake).toBe('webspeech-cloud')
    expect(selectEngines(chromeLocal, bridgeCloud, { ...auto, wake: 'push-to-talk' }).wake).toBe('push-to-talk')
    const wanted = selectEngines(chromeLocal, bridgeNone, { ...auto, stt: 'cloud', tts: 'cloud' })
    expect(wanted.stt).toBe('webspeech-local')
    expect(wanted.notes).toEqual([
      'Cloud transcription requested but not configured on the bridge.',
      'Cloud voice requested but not configured on the bridge.',
    ])
  })

  it('degrades to typing when there is no microphone or recogniser', () => {
    expect(selectEngines(noMic, bridgeCloud, auto)).toMatchObject({ wake: 'push-to-talk', stt: 'none' })
    const bare = selectEngines({ ...firefox, mediaRecorder: false, speechSynthesis: false }, null, auto)
    expect(bare).toMatchObject({ wake: 'push-to-talk', stt: 'none', tts: [] })
    expect(bare.notes).toContain('No voice output available; answers appear as text only.')
  })

  it('does not offer cloud STT without MediaRecorder', () => {
    expect(selectEngines({ ...chromeLocal, mediaRecorder: false }, bridgeCloud, auto).stt).toBe('webspeech-local')
  })
})

describe('describeEngines', () => {
  it('names the engines for the status panel', () => {
    expect(describeEngines(selectEngines(chromeLocal, bridgeCloud, auto))).toEqual({
      wake: 'on-device',
      stt: 'cloud (bridge)',
      tts: 'cloud voice → browser voice',
    })
  })
})
