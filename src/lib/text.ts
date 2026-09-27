/**
 * Text coming from the model is untrusted: it may have been shaped by a web
 * page CLAP just read. Two treatments:
 *
 *   sanitizeForDisplay — for the transcript. Rendered by React as text (never
 *     as HTML), with control characters and bidirectional-override characters
 *     removed so a response cannot visually disguise itself.
 *   toSpeakable — for speech. Strips markdown and URLs that a synthesiser would
 *     otherwise read aloud character by character.
 */

// oxlint-disable-next-line no-control-regex -- stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
/** Bidi overrides/isolates and zero-width characters used for spoofing. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

export function sanitizeForDisplay(text: string, maxLength = 20_000): string {
  const clean = text.replace(CONTROL, '').replace(INVISIBLE, '')
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean
}

const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}/gu

export function toSpeakable(text: string): string {
  return (
    sanitizeForDisplay(text)
      // Fenced code is never read aloud.
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      // [label](url) → label
      .replace(/\[([^\]]{1,200})\]\((?:[^)\s]{1,2000})\)/g, '$1')
      // Bare URLs, keeping the sentence's own final punctuation.
      .replace(/\bhttps?:\/\/[^\s)]+?(?=[.,;:!?)]*(?:\s|$))/gi, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^*_`~]{1,500}?)\1/g, '$2')
      .replace(/[*_`#]+/g, '')
      .replace(EMOJI, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
