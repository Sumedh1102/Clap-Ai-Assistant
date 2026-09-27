/**
 * A minimal `.env` loader.
 *
 * Reads KEY=VALUE lines from a file into process.env without overriding
 * anything already set, so a real environment variable always beats the file.
 * Handles comments, blank lines, `export ` prefixes and single or double
 * quotes. Deliberately tiny: no interpolation, no multi-line values.
 */

import { existsSync, readFileSync } from 'node:fs'

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const match = LINE.exec(raw)
    if (!match) continue
    const key = match[1]!
    let value = (match[2] ?? '').trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      // Unquoted: an inline comment starts at the first " #".
      const hash = value.search(/\s#/)
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    out[key] = value
  }
  return out
}

/** Load each file in order; earlier files and the real environment win. */
export function loadEnvFiles(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    const values = parseEnv(readFileSync(path, 'utf8'))
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value
    }
    loaded.push(path)
  }
  return loaded
}
