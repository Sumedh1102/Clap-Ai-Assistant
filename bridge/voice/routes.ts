/**
 * POST /api/tts and POST /api/stt — the browser's only way to reach a cloud
 * voice. Both are behind the Host/Origin guard in app.ts, size-capped, and
 * time-limited; neither ever returns the upstream's raw error to the page.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { MAX_STT_AUDIO_BYTES, MAX_TTS_TEXT_CHARS } from '../../shared/defaults'
import { HttpError, readBody, SECURITY_HEADERS, sendJson } from '../http'
import type { Logger } from '../logger'
import type { ElevenLabs } from './elevenlabs'

const TtsRequest = z.object({ text: z.string().trim().min(1).max(MAX_TTS_TEXT_CHARS) })

/** A few hundred milliseconds of compressed audio; anything smaller is a click. */
const MIN_AUDIO_BYTES = 1_200
const AUDIO_TYPE = /^audio\/[a-z0-9.+-]+(;.*)?$/i

function abortOnClose(req: IncomingMessage, res: ServerResponse, timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  // The client going away (a barge-in cancels the fetch) should stop the upstream call too.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })
  req.on('aborted', () => controller.abort())
  return AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
}

export async function handleTts(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { voice: ElevenLabs | null; logger: Logger; cors: Record<string, string> },
): Promise<void> {
  const { voice, logger, cors } = deps
  if (!voice) return sendJson(res, 503, { error: 'Cloud voice is not configured.' }, cors)

  let text: string
  try {
    const parsed = TtsRequest.safeParse(JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}'))
    if (!parsed.success) return sendJson(res, 400, { error: 'Expected {"text": "..."} with 1 to 1200 characters.' }, cors)
    text = parsed.data.text
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400
    return sendJson(res, status, { error: 'Invalid request body.' }, cors)
  }

  const timing = logger.time('voice.tts', { chars: text.length })
  const signal = abortOnClose(req, res, 20_000)
  let bytes = 0
  try {
    const upstream = await voice.synthesize(text, signal)
    res.writeHead(200, { ...SECURITY_HEADERS, ...cors, 'content-type': upstream.contentType })
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    }
    res.end()
    timing.end(true, { bytes })
  } catch (error) {
    timing.end(false, { error, bytes, cancelled: signal.aborted })
    if (!res.headersSent) sendJson(res, 502, { error: 'Speech synthesis failed.' }, cors)
    else res.destroy()
  }
}

export async function handleStt(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { voice: ElevenLabs | null; logger: Logger; cors: Record<string, string> },
): Promise<void> {
  const { voice, logger, cors } = deps
  if (!voice) return sendJson(res, 503, { error: 'Cloud transcription is not configured.' }, cors)

  const mime = String(req.headers['content-type'] ?? '')
  if (!AUDIO_TYPE.test(mime)) return sendJson(res, 415, { error: 'Expected an audio/* body.' }, cors)

  let audio: Buffer
  try {
    audio = await readBody(req, MAX_STT_AUDIO_BYTES)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400
    return sendJson(res, status, { error: 'Audio too large.' }, cors)
  }
  if (audio.length < MIN_AUDIO_BYTES) return sendJson(res, 200, { text: '' }, cors)

  // Audio is logged only as a byte count — never stored, never echoed.
  const timing = logger.time('voice.stt', { bytes: audio.length, mime: mime.split(';')[0] })
  try {
    const text = await voice.transcribe(audio, mime.split(';')[0]!, abortOnClose(req, res, 30_000))
    timing.end(true, { chars: text.length })
    sendJson(res, 200, { text }, cors)
  } catch (error) {
    timing.end(false, { error })
    sendJson(res, 502, { error: 'Transcription failed.' }, cors)
  }
}
