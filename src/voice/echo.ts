/**
 * Recognising CLAP's own voice coming back through the microphone.
 *
 * The microphone stays open while CLAP speaks (that is what makes barge-in
 * possible), so the recogniser hears every word CLAP says. Echo cancellation
 * removes most of it acoustically; this is the text-level backstop.
 *
 * Compared as bags of distinctive words rather than by string distance: a
 * recogniser mangles playback too much for substrings to survive, but the
 * words do. Common words are ignored, because "what about the second one?" is
 * a real follow-up whose every word probably appeared in the answer.
 */

import { OVERRIDE_WORDS } from './intents'

const COMMON = new Set(
  (
    'a an the and or but so of to in on at by for with from is are was were be it its this that these those i ' +
    'you he she we they me him her them my your our their what which who how why when where do does did can ' +
    'could would should will shall not no yes if then than as about into over out up down one two three first ' +
    'second third now here there just very really got get have has had say said tell okay ok well right want'
  ).split(' '),
)

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * @param heard   what the recogniser produced
 * @param spoken  what CLAP is saying now, plus a short tail of what it just said
 */
export function isLikelyEcho(heard: string, spoken: string): boolean {
  if (!spoken.trim()) return false
  const all = words(heard)
  if (!all.length) return true
  // A short "stop" / "no, wait" must cut through even if CLAP just said
  // "stop" or "no". Only short utterances get this pass: a full echoed
  // sentence ("there's no file by that name") is still judged as echo.
  if (all.length <= 3 && OVERRIDE_WORDS.test(heard)) return false
  const mine = new Set(words(spoken))
  const distinctive = all.filter((w) => !COMMON.has(w))

  // Nothing distinctive: demand a total match. Dropping a real question costs
  // far more than letting one stray echo through.
  if (distinctive.length < 2) return all.length >= 2 && all.every((w) => mine.has(w))

  const hits = distinctive.filter((w) => mine.has(w)).length
  return hits / distinctive.length >= 0.6
}

/**
 * What the microphone may currently be hearing from the speakers: the
 * sentence playing now, plus the previous one for a short while (recognition
 * lags playback by a few hundred milliseconds).
 */
export class EchoWindow {
  private current = ''
  private previous = ''
  private previousUntil = 0
  private readonly tailMs: number
  private readonly now: () => number

  constructor(tailMs = 1_800, now: () => number = Date.now) {
    this.tailMs = tailMs
    this.now = now
  }

  speaking(text: string): void {
    if (this.current) this.retire()
    this.current = text
  }

  stopped(): void {
    this.retire()
  }

  text(): string {
    const tail = this.now() < this.previousUntil ? this.previous : ''
    return `${this.current} ${tail}`.trim()
  }

  private retire(): void {
    if (!this.current) return
    this.previous = this.current
    this.previousUntil = this.now() + this.tailMs
    this.current = ''
  }
}
