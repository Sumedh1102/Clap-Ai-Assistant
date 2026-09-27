import { describe, expect, it } from 'vitest'
import { FenceFilter, MAX_UNSPOKEN, SentenceSplitter } from './sentences'

/** Stream `text` in small chunks, as the model would. */
function stream(text: string, chunk = 3): string[] {
  const splitter = new SentenceSplitter()
  const out: string[] = []
  for (let i = 0; i < text.length; i += chunk) out.push(...splitter.push(text.slice(i, i + chunk)))
  return [...out, ...splitter.flush()]
}

/** Run deltas through a fresh fence filter. */
function filter(deltas: string[]): string {
  const fences = new FenceFilter()
  return deltas.map((d) => fences.push(d)).join('') + fences.flush()
}

describe('SentenceSplitter', () => {
  it('cuts at sentence ends as the text streams', () => {
    const splitter = new SentenceSplitter()
    expect(splitter.push('It is noon. The wea')).toEqual(['It is noon.'])
    expect(splitter.push('ther is fine!  Anything else?')).toEqual(['The weather is fine!'])
    expect(splitter.flush()).toEqual(['Anything else?'])
    expect(splitter.flush()).toEqual([])
  })

  it('keeps abbreviations, initials, decimals and dotted words together', () => {
    expect(stream('Dr. Smith met J. R. R. Tolkien at 3 p.m. on Jan. 5. It cost 3.5 dollars, e.g. a lot. So do I. Done.')).toEqual([
      'Dr. Smith met J. R. R. Tolkien at 3 p.m. on Jan. 5.',
      'It cost 3.5 dollars, e.g. a lot.',
      'So do I.',
      'Done.',
    ])
    // Ordinary words that look like dotted abbreviations are still sentence ends.
    expect(stream('Tell us. Then go.')).toEqual(['Tell us.', 'Then go.'])
  })

  it('treats closing quotes, ellipses and line breaks as boundaries', () => {
    expect(stream('He said "stop." Then… nothing.\nNew line')).toEqual(['He said "stop."', 'Then…', 'nothing.', 'New line'])
  })

  it('never lets the voice fall far behind a long unpunctuated run', () => {
    const splitter = new SentenceSplitter()
    const long = `${'word, '.repeat(30)}${'more '.repeat(40)}`
    const out = splitter.push(long)
    expect(out.length).toBeGreaterThan(0)
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(MAX_UNSPOKEN)
  })

  it('forgets everything on reset', () => {
    const splitter = new SentenceSplitter()
    splitter.push('half a sent')
    splitter.reset()
    expect(splitter.flush()).toEqual([])
  })
})

describe('FenceFilter', () => {
  it('drops fenced blocks, language tag included', () => {
    expect(filter(['Run this:\n```bash\nrm -rf ~/tmp\n```\nThen relax.'])).toBe('Run this:\n\nThen relax.')
  })

  it('handles fences split across deltas', () => {
    expect(filter(['Run this:\n`', '``py', 'thon\nprint(1)\n`', '`', '`\nDone.'])).toBe('Run this:\n\nDone.')
  })

  it('treats an unclosed block as code to the end', () => {
    expect(filter(['Here:\n```\nsecret code', ' more code'])).toBe('Here:\n')
  })

  it('leaves single and double backticks alone', () => {
    expect(filter(['Use `ls` or ``a`` here.'])).toBe('Use `ls` or ``a`` here.')
    expect(filter(['ends with `', '`'])).toBe('ends with ``')
  })
})
