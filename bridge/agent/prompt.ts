/**
 * Builds CLAP's system prompt from the personality file and the tools that are
 * actually registered.
 *
 * The prompt is static for the life of the bridge — no clock, no per-session
 * data — so it caches across turns. The capabilities section is generated from
 * the registry so CLAP can say honestly what it can and cannot do yet.
 */

import { readFileSync } from 'node:fs'
import type { ToolInfo } from '../../shared/protocol'

const PERSONALITY_URL = new URL('./clap-personality.md', import.meta.url)

export function loadPersonality(): string {
  return readFileSync(PERSONALITY_URL, 'utf8').trim()
}

export function buildSystemPrompt(tools: ToolInfo[], personality = loadPersonality()): string {
  const available = tools.map((t) => `- ${t.label}`).join('\n')
  return `${personality}

## This session

Tools available right now:
${available || '- none'}

Not connected yet: controlling applications, files, the browser, media, and
long-term memory. If asked for one of these, say it is not connected yet
rather than attempting it another way.

Use the clock tool for the current date or time; never assume it.`
}
