/**
 * What this browser and this bridge can do, and which voice engines to use.
 *
 * Detection runs once when voice is activated. Selection is a pure function of
 * the detected capabilities and the user's preferences, so every combination
 * is unit-tested and every choice has a fallback:
 *
 *   wake  on-device recognition → browser cloud recognition (if allowed) → push-to-talk
 *   stt   cloud via bridge (if configured) → browser recognition → none (type instead)
 *   tts   cloud via bridge (if configured) → browser voice
 *
 * Paid cloud STT is never used to listen for the wake phrase.
 */

import type { Capabilities } from '../../shared/protocol'
import { speechRecognitionCtor } from './stt/webspeech'

export type LocalRecognition = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown'

export type BrowserCapabilities = {
  secureContext: boolean
  microphone: boolean
  mediaRecorder: boolean
  webSpeech: boolean
  localRecognition: LocalRecognition
  speechSynthesis: boolean
  audioWorklet: boolean
  webgl: boolean
}

export type WakeEngine = 'webspeech-local' | 'webspeech-cloud' | 'push-to-talk'
export type SttEngine = 'webspeech-local' | 'webspeech-cloud' | 'bridge-cloud' | 'none'
export type TtsEngine = 'bridge-cloud' | 'browser'

export type EnginePreferences = {
  wake: 'auto' | 'local' | 'cloud' | 'push-to-talk'
  /** May the browser's cloud recogniser listen for the wake phrase? */
  allowCloudWake: boolean
  stt: 'auto' | 'browser' | 'cloud'
  tts: 'auto' | 'browser' | 'cloud'
}

export type EngineSelection = {
  wake: WakeEngine
  stt: SttEngine
  tts: TtsEngine[]
  /** Human-readable reasons, shown in diagnostics. */
  notes: string[]
}

export function selectEngines(
  browser: BrowserCapabilities,
  bridge: Capabilities | null,
  prefs: EnginePreferences,
): EngineSelection {
  const notes: string[] = []
  const local = browser.webSpeech && browser.localRecognition === 'available'

  // --- wake -----------------------------------------------------------------
  let wake: WakeEngine = 'push-to-talk'
  if (!browser.microphone) {
    notes.push('No microphone: voice input is off. Type to CLAP instead.')
  } else if (prefs.wake === 'push-to-talk') {
    notes.push('Wake phrase disabled by preference; press Space to talk.')
  } else if (local && prefs.wake !== 'cloud') {
    wake = 'webspeech-local'
  } else if (browser.webSpeech && prefs.wake !== 'local' && prefs.allowCloudWake) {
    wake = 'webspeech-cloud'
    notes.push("On-device recognition isn't available here; the wake phrase uses the browser's cloud recogniser.")
  } else {
    notes.push('No local wake-phrase engine in this browser; press Space to talk.')
  }

  // --- speech to text -----------------------------------------------------------
  let stt: SttEngine = 'none'
  if (browser.microphone) {
    const cloud: SttEngine | null = bridge?.stt.cloud && browser.mediaRecorder ? 'bridge-cloud' : null
    const inBrowser: SttEngine | null = browser.webSpeech ? (local ? 'webspeech-local' : 'webspeech-cloud') : null
    // Preferred engine first; the other is the fallback.
    const order: Array<SttEngine | null> = prefs.stt === 'browser' ? [inBrowser, cloud] : [cloud, inBrowser]
    stt = order.find((engine): engine is SttEngine => engine !== null) ?? 'none'
    if (prefs.stt === 'cloud' && !cloud) notes.push('Cloud transcription requested but not configured on the bridge.')
    if (stt === 'none') notes.push('No speech recognition available; type to CLAP instead.')
  }

  // --- text to speech -------------------------------------------------------------
  const tts: TtsEngine[] = []
  const cloudVoice = Boolean(bridge?.tts.cloud)
  if (prefs.tts !== 'browser' && cloudVoice) tts.push('bridge-cloud')
  if (browser.speechSynthesis) tts.push('browser')
  if (prefs.tts === 'cloud' && !cloudVoice) notes.push('Cloud voice requested but not configured on the bridge.')
  if (!tts.length) notes.push('No voice output available; answers appear as text only.')

  return { wake, stt, tts, notes }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])
}

/**
 * Ask whether on-device recognition exists for `lang`, installing the language
 * pack when the browser offers it. `available()` has been seen to never
 * settle, so every call is raced against a timeout.
 */
export async function detectLocalRecognition(lang: string, install: boolean): Promise<LocalRecognition> {
  const Ctor = speechRecognitionCtor()
  if (!Ctor?.available) return 'unavailable'
  const options = { langs: [lang], processLocally: true }
  const status = (await withTimeout(Ctor.available(options).catch(() => 'unknown'), 2_500, 'unknown')) as LocalRecognition
  if ((status === 'downloadable' || status === 'downloading') && install && Ctor.install) {
    const installed = await withTimeout(Ctor.install(options).catch(() => false), 20_000, false)
    return installed ? 'available' : status
  }
  return status
}

export async function detectBrowserCapabilities(lang: string, installLocal = true): Promise<BrowserCapabilities> {
  const webSpeech = speechRecognitionCtor() !== null
  let webgl = false
  try {
    webgl = Boolean(document.createElement('canvas').getContext('webgl2'))
  } catch {
    webgl = false
  }
  return {
    secureContext: window.isSecureContext,
    microphone: Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    webSpeech,
    localRecognition: webSpeech ? await detectLocalRecognition(lang, installLocal) : 'unavailable',
    speechSynthesis: typeof speechSynthesis !== 'undefined',
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    webgl,
  }
}

export function describeEngines(selection: EngineSelection): { wake: string; stt: string; tts: string } {
  const wake = { 'webspeech-local': 'on-device', 'webspeech-cloud': 'browser cloud', 'push-to-talk': 'push-to-talk' }[selection.wake]
  const stt = { 'webspeech-local': 'on-device', 'webspeech-cloud': 'browser cloud', 'bridge-cloud': 'cloud (bridge)', none: 'off' }[selection.stt]
  const tts = selection.tts.map((t) => (t === 'bridge-cloud' ? 'cloud voice' : 'browser voice')).join(' → ') || 'off'
  return { wake, stt, tts }
}
