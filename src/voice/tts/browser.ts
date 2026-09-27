/**
 * The browser's own voice (speechSynthesis): instant, on-device, free — and
 * fragile. The workarounds below are the lessons adewaskar/jarvis recorded
 * (src/lib/tts.ts, MIT), re-implemented:
 *
 *   - Chrome's engine can wedge after cancel(): every speak() is preceded by
 *     resume(), and a watchdog retries once if `start` never fires.
 *   - Chrome cuts long utterances off after ~15 s unless nudged, so a
 *     pause/resume keep-alive runs while speaking.
 *   - Errors are reported, not swallowed; "interrupted"/"canceled" are ours.
 *
 * speechSynthesis exposes no audio, so the visualiser gets a synthetic
 * speech-like envelope instead of a measured level.
 */

import { VoiceError, type SpeakOptions, type VoiceCapabilities, type VoiceProvider } from './types'

const PREFERENCE_KEY = 'clap.voice'

/**
 * CLAP's cloud voice is a low, British male voice ("Dominic", docs/voice.md).
 * When it is unavailable the browser voice stands in, so among voices of the
 * user's language, prefer ones that sound like the same person.
 */
const BRITISH_MALE = /\b(daniel|arthur|ryan|thomas|george|oliver|alfie|elliot|uk english male)\b/

/** Rank installed voices: natural-sounding, in CLAP's character, not novelty voices. */
export function scoreVoice(voice: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>, preferredLang: string): number {
  const name = voice.name.toLowerCase()
  const lang = voice.lang.toLowerCase().replace('_', '-')
  let score = 0
  if (lang === preferredLang.toLowerCase()) score += 40
  else if (lang.slice(0, 2) === preferredLang.slice(0, 2).toLowerCase()) score += 25
  else return -1000
  if (/natural|neural|premium|enhanced/.test(name)) score += 35
  if (/online/.test(name)) score += 10
  if (/google (us|uk) english|samantha|daniel|aria|jenny|guy|ava|serena|oliver|moira|tessa/.test(name)) score += 20
  if (lang === 'en-gb') score += 25
  if (BRITISH_MALE.test(name)) score += 20
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news|albert|fred|junior|ralph|kathy|hysterical/.test(name)) {
    score -= 500
  }
  if (voice.localService) score += 3
  return score
}

export class BrowserVoiceProvider implements VoiceProvider {
  readonly id = 'browser'
  private speaking = false
  private startedAt = 0
  private voice: SpeechSynthesisVoice | null = null
  private readonly lang: string

  constructor(lang = navigator.language || 'en-US') {
    this.lang = lang
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', () => {
        this.voice = null
      })
    }
  }

  static supported(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
  }

  getCapabilities(): VoiceCapabilities {
    return { id: this.id, cloud: false, customVoice: false, analysable: false }
  }

  candidates(): SpeechSynthesisVoice[] {
    return speechSynthesis
      .getVoices()
      .map((v) => ({ v, s: scoreVoice(v, this.lang) }))
      .filter((x) => x.s > 0)
      .toSorted((a, b) => b.s - a.s)
      .map((x) => x.v)
  }

  currentVoiceName(): string {
    return this.pickVoice()?.name ?? 'default'
  }

  /** Step to the next ranked voice and remember the choice. */
  cycleVoice(): string {
    const list = this.candidates()
    if (!list.length) return 'default'
    const index = list.findIndex((v) => v.name === this.pickVoice()?.name)
    const next = list[(index + 1) % list.length]!
    this.voice = next
    try {
      localStorage.setItem(PREFERENCE_KEY, next.name)
    } catch {
      /* storage unavailable: the choice lasts for this page */
    }
    return next.name
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voice) return this.voice
    const all = speechSynthesis.getVoices()
    if (!all.length) return null
    let saved: string | null = null
    try {
      saved = localStorage.getItem(PREFERENCE_KEY)
    } catch {
      saved = null
    }
    this.voice = (saved && all.find((v) => v.name === saved)) || this.candidates()[0] || null
    return this.voice
  }

  speak(text: string, { signal, onStart }: SpeakOptions): Promise<void> {
    if (!BrowserVoiceProvider.supported()) return Promise.reject(new VoiceError(this.id, 'speech synthesis unsupported'))
    if (signal.aborted) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      const voice = this.pickVoice()
      if (voice) utterance.voice = voice
      utterance.lang = voice?.lang ?? this.lang
      // Calm and even: a touch above default rate, neutral pitch.
      utterance.rate = 1.03
      utterance.pitch = 1

      let settled = false
      let started = false
      let retried = false
      let keepAlive: ReturnType<typeof setInterval> | undefined
      let watchdog: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        settled = true
        this.speaking = false
        if (keepAlive) clearInterval(keepAlive)
        if (watchdog) clearTimeout(watchdog)
        signal.removeEventListener('abort', onAbort)
      }
      const done = () => {
        if (settled) return
        cleanup()
        resolve()
      }
      const fail = (reason: string) => {
        if (settled) return
        cleanup()
        reject(new VoiceError(this.id, reason))
      }
      const onAbort = () => {
        speechSynthesis.cancel()
        speechSynthesis.resume()
        done()
      }

      utterance.onstart = () => {
        started = true
        this.speaking = true
        this.startedAt = performance.now()
        onStart?.()
        keepAlive = setInterval(() => {
          speechSynthesis.pause()
          speechSynthesis.resume()
        }, 10_000)
      }
      utterance.onend = done
      utterance.onerror = (event) => {
        const code = (event as SpeechSynthesisErrorEvent).error
        if (code === 'interrupted' || code === 'canceled') done()
        else fail(`speech synthesis error: ${code}`)
      }

      const arm = () => {
        watchdog = setTimeout(() => {
          if (settled || started) return
          if (retried) return fail('speech synthesis did not start')
          retried = true
          speechSynthesis.cancel()
          speechSynthesis.resume()
          speechSynthesis.speak(utterance)
          arm()
        }, 1_500)
      }

      signal.addEventListener('abort', onAbort, { once: true })
      speechSynthesis.resume()
      speechSynthesis.speak(utterance)
      arm()
    })
  }

  stop(): void {
    if (!BrowserVoiceProvider.supported()) return
    speechSynthesis.cancel()
    speechSynthesis.resume()
    this.speaking = false
  }

  isSpeaking(): boolean {
    return this.speaking
  }

  level(): number {
    if (!this.speaking) return 0
    const t = (performance.now() - this.startedAt) / 1000
    return 0.35 + Math.abs(Math.sin(t * 7.3)) * 0.3 + Math.abs(Math.sin(t * 17.9)) * 0.2
  }
}
