/**
 * Reduce an HTML document to readable text for the model.
 *
 * Not a browser: no scripts run, no styles apply, nothing is fetched. It drops
 * the parts of a page that are never content (scripts, styles, navigation
 * chrome, forms), keeps block structure as line breaks, decodes entities, and
 * returns the title separately.
 *
 * The input is hostile by assumption — a model chose the URL — so every pass
 * here is linear in the input. Patterns like `<[^>]*>` or `[\s\S]*?</script>`
 * go quadratic on a page full of unclosed tags, which would let one web page
 * pin the bridge's CPU. Tag patterns therefore stop at the next `<`, and block
 * removal uses index scans instead of backtracking.
 */

/**
 * Elements removed with their contents. `head` is deliberately absent: pages
 * often omit `</head>` (browsers close it implicitly), and dropping to a closer
 * that never comes would erase the whole document. Its scripts and styles are
 * removed individually, and the title is extracted separately.
 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'title', 'svg', 'canvas', 'iframe',
  'object', 'embed', 'nav', 'footer', 'form', 'select', 'button',
])

const BLOCK_BREAK = /<\/?(?:p|div|section|article|main|header|aside|blockquote|pre|table|tr|ul|ol|dl|h[1-6]|figure|figcaption|details|summary|hr)\b[^<>]*>/gi
const LINE_BREAK = /<(?:br|\/li|\/dt|\/dd|\/td|\/th)\b[^<>]*>/gi
const LIST_ITEM = /<li\b[^<>]*>/gi
const TAG = /<[^<>]*>/g
const OPEN_TAG = /<([a-z][a-z0-9]*)\b/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', times: '×', euro: '€', pound: '£', yen: '¥',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Remove `<!-- … -->` comments with index scans. */
function dropComments(html: string): string {
  let out = ''
  let pos = 0
  for (;;) {
    const start = html.indexOf('<!--', pos)
    if (start === -1) return out + html.slice(pos)
    out += `${html.slice(pos, start)} `
    const end = html.indexOf('-->', start + 4)
    if (end === -1) return out // an unclosed comment swallows the rest, as in a browser
    pos = end + 3
  }
}

/** Remove whole elements whose contents are never prose (scripts, styles, …). */
function dropBlocks(html: string): string {
  let out = ''
  let pos = 0
  OPEN_TAG.lastIndex = 0
  for (let match = OPEN_TAG.exec(html); match; match = OPEN_TAG.exec(html)) {
    const tag = match[1]!.toLowerCase()
    if (!DROP_TAGS.has(tag)) continue
    out += `${html.slice(pos, match.index)} `
    const closer = new RegExp(`</${tag}\\s*>`, 'gi')
    closer.lastIndex = OPEN_TAG.lastIndex
    const close = closer.exec(html)
    if (!close) return out // unclosed: the rest of the document is that element
    pos = close.index + close[0].length
    OPEN_TAG.lastIndex = pos
  }
  return out + html.slice(pos)
}

export function extractTitle(html: string): string {
  const open = /<title\b[^<>]*>/i.exec(html)
  if (!open) return ''
  const start = open.index + open[0].length
  const end = html.toLowerCase().indexOf('</title', start)
  const raw = html.slice(start, end === -1 ? Math.min(html.length, start + 300) : end)
  return collapse(decodeEntities(raw.replace(TAG, ''))).slice(0, 300)
}

function collapse(text: string): string {
  return text.replace(/[ \t\f\v ]+/g, ' ').trim()
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = extractTitle(html)
  const body = dropBlocks(dropComments(html))
    .replace(BLOCK_BREAK, '\n\n')
    .replace(LINE_BREAK, '\n')
    .replace(LIST_ITEM, '\n• ')
    .replace(TAG, ' ')
  const text = decodeEntities(body)
    // Control characters other than newline and tab never belong in the result.
    // oxlint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .split('\n')
    .map(collapse)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

/** Cut at a paragraph or sentence boundary near `max`, and say so. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const window = text.slice(0, max)
  const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
  const kept = cut > max * 0.6 ? window.slice(0, cut + 1) : window
  return `${kept.trimEnd()}\n\n[… ${text.length - kept.length} more characters not shown]`
}
