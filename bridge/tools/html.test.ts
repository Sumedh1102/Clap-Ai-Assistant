import { describe, expect, it } from 'vitest'
import { decodeEntities, extractTitle, htmlToText, truncateText } from './html'
import { decodeBody } from './web'

describe('htmlToText', () => {
  it('keeps prose and structure, drops chrome and code', () => {
    const html = `<!doctype html><html><head><title>A &amp; B</title>
      <script>var x = "<p>not text</p>"</script><style>p{color:red}</style></head>
      <body><nav><a href="/">Home</a></nav>
      <h1>Heading</h1><p>First &lt;para&gt;&nbsp;here.</p><!-- hidden -->
      <ul><li>one</li><li>two</li></ul>
      <p>Line<br>break</p><form><input value="x"><button>Go</button></form>
      <footer>© footer</footer></body></html>`
    const { title, text } = htmlToText(html)
    expect(title).toBe('A & B')
    expect(text).toBe('Heading\n\nFirst <para> here.\n\n• one\n• two\n\nLine\nbreak')
  })

  it('does not lose the document when </head> is missing', () => {
    expect(htmlToText('<head><title>T</title><p>Body text</p>').text).toBe('Body text')
  })

  it('treats an unclosed dropped element as the rest of the document', () => {
    expect(htmlToText('<p>kept</p><script>var a = 1; <p>gone').text).toBe('kept')
    expect(htmlToText('<p>kept</p><!-- never closed <p>gone').text).toBe('kept')
  })

  it('strips control characters', () => {
    expect(htmlToText('<p>a\u0007b\u001bc</p>').text).toBe('a b c')
  })

  it('stays linear on hostile input', () => {
    const hostile = [
      '<p'.repeat(200_000),
      '<script>'.repeat(50_000),
      '<!--'.repeat(100_000),
      `<title>${'<'.repeat(200_000)}`,
      '<a '.repeat(100_000) + '>',
      '&#x'.repeat(100_000),
    ]
    for (const input of hostile) {
      const started = performance.now()
      htmlToText(input)
      // Quadratic behaviour on ~600 KB would take many seconds.
      expect(performance.now() - started).toBeLessThan(1_500)
    }
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities and drops invalid code points', () => {
    expect(decodeEntities('&lt;&GT;&quot;&#65;&#x42;&#X43;&mdash;&unknown;')).toBe('<>"ABC—&unknown;')
    expect(decodeEntities('&#0;&#xD800;&#x110000;')).toBe('')
    expect(decodeEntities('&#128512;')).toBe('😀')
  })
})

describe('extractTitle', () => {
  it('bounds an unclosed title', () => {
    expect(extractTitle(`<title>${'x'.repeat(1000)}`)).toHaveLength(300)
    expect(extractTitle('<p>no title</p>')).toBe('')
  })
})

describe('truncateText', () => {
  it('cuts at a boundary near the limit and says how much was left', () => {
    const text = `${'a'.repeat(80)}. ${'b'.repeat(50)}`
    expect(truncateText(text, 200)).toBe(text)
    expect(truncateText(text, 100)).toBe(`${'a'.repeat(80)}.\n\n[… ${text.length - 81} more characters not shown]`)
    // No boundary near the limit: a hard cut.
    expect(truncateText('c'.repeat(300), 100).startsWith(`${'c'.repeat(100)}\n\n[… 200`)).toBe(true)
  })
})

describe('decodeBody', () => {
  it('uses the declared charset, then a meta charset, then UTF-8', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]) // "café" in ISO-8859-1
    expect(decodeBody(latin1, 'iso-8859-1')).toBe('café')
    const withMeta = Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1])
    expect(decodeBody(withMeta, null).endsWith('café')).toBe(true)
    expect(decodeBody(Buffer.from('café'), 'not-a-charset')).toBe('café')
  })
})
