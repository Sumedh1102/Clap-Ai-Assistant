/**
 * Deciding when the user has finished a thought.
 *
 * Silence is a fact about the room, not the sentence: people pause to find a
 * word, mid-list, before the important part. So transcript segments are
 * collected here and a turn is sent only when the words look finished AND the
 * room has gone quiet. A complete sentence with nobody talking goes out at
 * once — the common case pays nothing; the wait only happens when there is a
 * reason for it.
 *
 * The idea (word-aware holds on top of an energy gate) comes from the
 * utterance assembler in adewaskar/jarvis (src/lib/voice.ts, MIT); this is a
 * separate implementation with its own rules.
 */

/** Ending on one of these means the sentence isn't over. Closed-class words only. */
const CONTINUES = new Set(
  (
    'and or but so because since if when while that which who whose whom to of in on at by for with from about ' +
    'into onto over under between through the a an my your his her its our their this these those is are was ' +
    'were be been being do does did have has had can could would should will shall might must like than then ' +
    'as very really just some any all both either neither what where how why plus also um uh er'
  ).split(' '),
)

/** One- and two-word utterances that are complete on their own. */
const COMPLETE_SHORT =
  /^(yes|no|yeah|nope|okay|ok|sure|thanks|thank you|stop|wait|cancel|continue|go on|pause|resume|next|previous|louder|quieter|again|repeat that|never mind|what|why|really|hello|hi|good morning|good night|goodbye|bye|help)$/i

export const ENDPOINT_TIMINGS = {
  /** A finished-looking sentence still waits this long for one more clause. */
  settleMs: 250,
  /** A plainly unfinished sentence waits this long for the rest. */
  continueMs: 1_600,
  /** Nothing is held longer than this in total. */
  maxHoldMs: 6_000,
}

/** How long to wait for more, given what has been said. 0 = send it now. */
export function holdTime(text: string): number {
  const trimmed = text.trim()
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (!words.length) return ENDPOINT_TIMINGS.continueMs
  if (/[.!?]["')\]]?$/.test(trimmed)) return 0
  if (/[,;:–—-]$/.test(trimmed)) return ENDPOINT_TIMINGS.continueMs
  const last = words[words.length - 1]!.toLowerCase().replace(/[^a-z']/g, '')
  if (CONTINUES.has(last)) return ENDPOINT_TIMINGS.continueMs
  if (words.length <= 2 && !COMPLETE_SHORT.test(trimmed.replace(/[^a-z' ]/gi, '').trim())) return ENDPOINT_TIMINGS.continueMs
  return ENDPOINT_TIMINGS.settleMs
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export class UtteranceAssembler {
  private held = ''
  private firstAt = 0
  private timer: unknown = null
  private readonly emit: (text: string) => void
  private readonly partial: (text: string) => void
  private readonly timers: Timers

  constructor(handlers: { emit: (text: string) => void; partial?: (text: string) => void }, timers: Timers = realTimers) {
    this.emit = handlers.emit
    this.partial = handlers.partial ?? (() => {})
    this.timers = timers
  }

  /** Add a transcript segment. `stillSpeaking`: the user is audibly continuing. */
  feed(text: string, stillSpeaking = false): void {
    const piece = text.trim()
    if (!piece) return
    this.held = `${this.held} ${piece}`.replace(/\s+/g, ' ').trim()
    if (!this.firstAt) this.firstAt = this.timers.now()
    this.partial(this.held)
    this.clearTimer()

    const elapsed = this.timers.now() - this.firstAt
    const remaining = Math.max(0, ENDPOINT_TIMINGS.maxHoldMs - elapsed)
    const wait = stillSpeaking ? remaining : Math.min(holdTime(this.held), remaining)
    if (wait === 0) this.flush()
    else this.timer = this.timers.set(() => this.flush(), wait)
  }

  /** Send whatever is held now. */
  flush(): void {
    this.clearTimer()
    const text = this.held.trim()
    this.held = ''
    this.firstAt = 0
    if (text) this.emit(text)
  }

  /** Discard whatever is held (standing down, or the mode changed). */
  cancel(): void {
    this.clearTimer()
    this.held = ''
    this.firstAt = 0
  }

  current(): string {
    return this.held
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
