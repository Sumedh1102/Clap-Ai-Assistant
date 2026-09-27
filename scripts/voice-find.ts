/**
 * npm run voice:find -- <name> [--use <n>]
 *
 * Find an ElevenLabs voice by name, in your account and in the public Voice
 * Library, with the key in .env.local. `--use <n>` adds match n to your account
 * if it is a library voice and writes CLAP_VOICE_ID to .env.local.
 *
 *   npm run voice:find -- dominic
 *   npm run voice:find -- dominic --use 1
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VoiceUpstreamError } from '../bridge/voice/elevenlabs'
import { loadEnv, ROOT } from './lib/checks'
import { addLibraryVoice, findVoices, setEnvValue, type FoundVoice } from './lib/voices'

function explain(error: unknown): string {
  if (error instanceof VoiceUpstreamError) {
    if (error.status === 401) return 'ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY.'
    // A 403 can be ElevenLabs (plan, permissions) or a proxy blocking the host: say which.
    return `Request refused (${error.status}): ${error.detail || 'no reason given'}`
  }
  const cause = error instanceof Error ? error.message : String(error)
  return `Could not reach api.elevenlabs.io (${cause}).`
}

const line = (v: FoundVoice, i: number) =>
  `  ${i + 1}. ${v.name}${v.source === 'library' ? '  [Voice Library]' : '  [your voices]'}\n` +
  `     ${v.description || 'no description'}\n     id ${v.voiceId}`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const useAt = args.indexOf('--use')
  const pick = useAt === -1 ? null : Number(args[useAt + 1])
  const query = args.filter((a, i) => !a.startsWith('--') && (useAt === -1 || i !== useAt + 1)).join(' ').trim()
  if (!query || (useAt !== -1 && !Number.isInteger(pick))) {
    process.stderr.write('Usage: npm run voice:find -- <name> [--use <number>]\n')
    process.exitCode = 2
    return
  }

  loadEnv()
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim()
  if (!apiKey) {
    process.stderr.write('Set ELEVENLABS_API_KEY in .env.local first (an API key from your ElevenLabs account).\n')
    process.exitCode = 1
    return
  }

  let voices: FoundVoice[]
  try {
    voices = await findVoices(query, apiKey)
  } catch (error) {
    process.stderr.write(`${explain(error)}\n`)
    process.exitCode = 1
    return
  }
  if (!voices.length) {
    process.stdout.write(`No voice named like "${query}" in your account or the Voice Library.\n`)
    process.exitCode = 1
    return
  }

  if (pick === null) {
    process.stdout.write(`\nVoices matching "${query}":\n\n${voices.map(line).join('\n\n')}\n\n`)
    process.stdout.write(`Use one:  npm run voice:find -- ${query} --use <number>\n\n`)
    return
  }

  const voice = voices[pick - 1]
  if (!voice) {
    process.stderr.write(`There is no match number ${pick}; there are ${voices.length}.\n`)
    process.exitCode = 2
    return
  }
  let voiceId: string
  try {
    voiceId = await addLibraryVoice(voice, apiKey)
  } catch (error) {
    process.stderr.write(`${explain(error)}\n`)
    process.exitCode = 1
    return
  }
  const envPath = resolve(ROOT, '.env.local')
  const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  writeFileSync(envPath, setEnvValue(before, 'CLAP_VOICE_ID', voiceId))
  process.stdout.write(
    `\n${voice.source === 'library' ? `Added "${voice.name}" to your ElevenLabs voices. ` : ''}` +
      `CLAP_VOICE_ID=${voiceId} is set in .env.local.\nRestart CLAP (npm start) to hear it.\n\n`,
  )
}

void main()
