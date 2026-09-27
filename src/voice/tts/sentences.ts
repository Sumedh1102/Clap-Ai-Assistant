/**
 * Cut streamed text into sentences so speech can start on the first one while
 * the rest is still being written.
 *
 * Boundaries are . ! ? … (optionally followed by closing quotes/brackets) and
 * then whitespace, or a line break. Not boundaries: abbreviations ("Dr.",
 * "e.g."), single-letter initials ("J. R. R."), and decimals ("3.5", which has
 * no space after the point). Long unpunctuated runs are cut at a comma or
 * space so the voice never falls far behind the text.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx', 'inc', 'ltd', 'vol', 'fig',
  'dept', 'est', 'mt', 'ft', 'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

/** Ordinary words unless written with internal dots: "a.m.", "U.S.", "e.g.". */
const DOTTED_ONLY = new Set(['am', 'pm', 'us', 'uk', 'eg', 'ie'])

const BOUNDARY = /([.!?…]+)(["'”’)\]]*)(\s+)|(\n+)/g

export const MAX_UNSPOKEN = 240

function isFalseBoundary(before: string, punct: string): boolean {
  if (punct !== '.') return false
  const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? ''
  const bare = word.replace(/\./g, '').toLowerCase()
  // An initial ("J."), but not the pronoun ("…so do I.").
  if (bare.length === 1 && /[A-Z]/.test(word[0] ?? '') && word !== 'I') return true
  if (DOTTED_ONLY.has(bare)) return word.includes('.')
  return ABBREVIATIONS.has(bare)
}

/**
 * Drops fenced code blocks from streamed text. It must run before sentence
 * splitting: the splitter cuts at line breaks, so a block would otherwise reach
 * the voice one line of code at a time, never as a whole block to remove. A
 * fence split across deltas ("…`" + "``bash") is held back until it is whole.
 */
export class FenceFilter {
  private inside = false
  private held = ''

  push(delta: string): string {
    let text = this.held + delta
    this.held = ''
    const partial = /`{1,2}$/.exec(text)
    if (partial) {
      this.held = partial[0]
      text = text.slice(0, -partial[0].length)
    }
    let out = ''
    let pos = 0
    for (let at = text.indexOf('```'); at !== -1; at = text.indexOf('```', pos)) {
      if (!this.inside) out += text.slice(pos, at)
      this.inside = !this.inside
      pos = at + 3
    }
    return this.inside ? out : out + text.slice(pos)
  }

  /** The end of the stream: an unclosed block is still code. */
  flush(): string {
    const rest = this.inside ? '' : this.held
    this.reset()
    return rest
  }

  reset(): void {
    this.inside = false
    this.held = ''
  }
}

export class SentenceSplitter {
  private buffer = ''

  /** Add streamed text; returns any sentences now complete. */
  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    let start = 0
    BOUNDARY.lastIndex = 0
    for (let m = BOUNDARY.exec(this.buffer); m; m = BOUNDARY.exec(this.buffer)) {
      const end = m.index + m[0].length
      if (m[1] && isFalseBoundary(this.buffer.slice(start, m.index), m[1])) continue
      const sentence = this.buffer.slice(start, end).trim()
      if (sentence) out.push(sentence)
      start = end
    }
    this.buffer = this.buffer.slice(start)

    if (this.buffer.length > MAX_UNSPOKEN) {
      const window = this.buffer.slice(0, MAX_UNSPOKEN)
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' — '))
      const at = cut > 60 ? cut + 1 : window.lastIndexOf(' ')
      if (at > 40) {
        out.push(this.buffer.slice(0, at).trim())
        this.buffer = this.buffer.slice(at)
      }
    }
    return out
  }

  /** Whatever is left once the stream ends. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }

  reset(): void {
    this.buffer = ''
  }
}
