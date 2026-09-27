/**
 * Wake-phrase matching over transcripts.
 *
 * The phrase is configurable (CLAP_WAKE_PHRASE, delivered by the bridge), so
 * nothing here is specific to "hey clap". Every word of the phrase must appear,
 * in order and adjacent, with tolerance for how recognisers mangle words:
 *
 *   - greetings are interchangeable (hey / hi / hay / a …);
 *   - a light phonetic normalisation (k→c, doubled letters, a trailing s) lets
 *     "klap", "clapp" and "claps" through without admitting "chap" or "slap";
 *   - longer custom words also allow one edit;
 *   - the phrase may arrive fused into one token ("heyclap").
 *
 * The match returns whatever followed the phrase, so a command spoken in the
 * same breath is not lost.
 */

export type WakeMatch = { matched: true; trailing: string; index: number } | { matched: false }

/**
 * Interchangeable greetings. "a" is deliberately absent even though
 * recognisers sometimes hear "hey" that way: "give them a clap" must not wake
 * CLAP.
 */
const GREETINGS = new Set(['hey', 'hi', 'hay', 'hei', 'heh', 'ey', 'eh', 'hej', 'hai'])

type Token = { word: string; start: number; end: number }

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const pattern = /[a-z0-9]+(?:'[a-z]+)?/gi
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    tokens.push({ word: m[0].toLowerCase().replace(/'/g, ''), start: m.index, end: m.index + m[0].length })
  }
  return tokens
}

/** A rough phonetic key: close enough for recogniser variants, strict enough to keep words apart. */
export function phonetic(word: string): string {
  let w = word.toLowerCase().replace(/ck/g, 'c').replace(/k/g, 'c').replace(/ph/g, 'f')
  w = w.replace(/(.)\1+/g, '$1')
  if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1)
  return w
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = temp
    }
  }
  return row[b.length]!
}

function wordMatches(heard: string, expected: string): boolean {
  if (heard === expected) return true
  if (GREETINGS.has(expected) && GREETINGS.has(heard)) return true
  const h = phonetic(heard)
  const e = phonetic(expected)
  if (h === e) return true
  if (e.length >= 6 && editDistance(h, e) <= 1) return true
  if (e.length >= 9 && editDistance(h, e) <= 2) return true
  return false
}

export function createWakeMatcher(phrase: string): (text: string) => WakeMatch {
  const words = tokenize(phrase).map((t) => t.word)
  if (!words.length) throw new Error('empty wake phrase')
  const fused = phonetic(words.join(''))

  return (text: string): WakeMatch => {
    const tokens = tokenize(text)
    for (let i = 0; i < tokens.length; i++) {
      // Fused form: "heyclap".
      if (phonetic(tokens[i]!.word) === fused) {
        return { matched: true, index: tokens[i]!.start, trailing: tail(text, tokens[i]!.end) }
      }
      if (i + words.length > tokens.length) continue
      let ok = true
      for (let j = 0; j < words.length; j++) {
        if (!wordMatches(tokens[i + j]!.word, words[j]!)) {
          ok = false
          break
        }
      }
      if (ok) return { matched: true, index: tokens[i]!.start, trailing: tail(text, tokens[i + words.length - 1]!.end) }
    }
    return { matched: false }
  }
}

function tail(text: string, from: number): string {
  return text
    .slice(from)
    .replace(/^[\s,.:;!?'"-]+/, '')
    .trim()
}

/**
 * If an utterance opens with the wake phrase ("hey clap, what's on today"),
 * return it without; otherwise return it unchanged. Used in command mode,
 * where people keep addressing CLAP by name.
 */
export function stripLeadingWake(text: string, match: (text: string) => WakeMatch): string {
  const result = match(text)
  if (!result.matched) return text
  const before = text.slice(0, result.index).trim()
  // Only a phrase at the start (after filler) is an address; mid-sentence it is content.
  return /^(?:(?:ok|okay|um|uh|so|and)\b[\s,]*)*$/i.test(before) ? result.trailing : text
}
