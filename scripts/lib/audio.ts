/**
 * Audio inspection for `npm run voice:inspect`: parse a WAV file, measure it,
 * and judge whether it is a good sample for cloning CLAP's voice.
 *
 * WAV (PCM 8/16/24/32-bit or 32/64-bit float, plain or WAVE_FORMAT_EXTENSIBLE)
 * is decoded here with no dependencies. Other formats are recognised by their
 * magic bytes; the CLI decodes them with ffmpeg when it is installed.
 */

export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'flac' | 'mp4' | 'webm' | 'unknown'

export function sniffFormat(head: Uint8Array): AudioFormat {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav'
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(4, 8) === 'ftyp') return 'mp4'
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm'
  return 'unknown'
}

export type DecodedAudio = {
  sampleRate: number
  /** Channels in the file (the analysis uses their mix). */
  channels: number
  bitsPerSample: number
  encoding: 'pcm' | 'float'
  /** Mono mix, -1..1. */
  samples: Float32Array
}

export class AudioFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioFormatError'
  }
}

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

export function parseWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioFormatError('not a RIFF/WAVE file')
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let data: Buffer | null = null
  for (let pos = 12; pos + 8 <= buffer.length; ) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    const body = buffer.subarray(pos + 8, Math.min(buffer.length, pos + 8 + size))
    if (id === 'fmt ' && body.length >= 16) {
      let format = body.readUInt16LE(0)
      if (format === FORMAT_EXTENSIBLE && body.length >= 26) format = body.readUInt16LE(24)
      fmt = { format, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) }
    } else if (id === 'data') {
      data = body
    }
    pos += 8 + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt) throw new AudioFormatError('missing fmt chunk')
  if (!data) throw new AudioFormatError('missing data chunk')
  const { format, channels, sampleRate, bits } = fmt
  if (!channels || !sampleRate) throw new AudioFormatError('invalid channel count or sample rate')

  let read: (offset: number) => number
  if (format === FORMAT_PCM && bits === 8) read = (o) => (data.readUInt8(o) - 128) / 128
  else if (format === FORMAT_PCM && bits === 16) read = (o) => data.readInt16LE(o) / 32768
  else if (format === FORMAT_PCM && bits === 24) read = (o) => data.readIntLE(o, 3) / 8388608
  else if (format === FORMAT_PCM && bits === 32) read = (o) => data.readInt32LE(o) / 2147483648
  else if (format === FORMAT_FLOAT && bits === 32) read = (o) => data.readFloatLE(o)
  else if (format === FORMAT_FLOAT && bits === 64) read = (o) => data.readDoubleLE(o)
  else throw new AudioFormatError(`unsupported WAV encoding (format ${format}, ${bits}-bit)`)

  const frameBytes = (bits / 8) * channels
  const frames = Math.floor(data.length / frameBytes)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += read(i * frameBytes + (c * bits) / 8)
    samples[i] = sum / channels
  }
  return { sampleRate, channels, bitsPerSample: bits, encoding: format === FORMAT_FLOAT ? 'float' : 'pcm', samples }
}

export type AudioStats = {
  durationS: number
  peakDb: number
  rmsDb: number
  /** Share of samples at or beyond full scale. */
  clippedRatio: number
  /** Level of the quietest stretches: the background noise. */
  noiseFloorDb: number
  /** Loud stretches over the noise floor, in dB. */
  snrDb: number
  /** Time above the silence threshold. */
  speechS: number
  leadingSilenceS: number
  trailingSilenceS: number
}

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
const WINDOW_S = 0.05
export const SILENCE_DB = -45

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!
}

/**
 * Level at which a sample counts as clipped. Integer PCM tops out one step
 * below 1.0 on the positive side (127/128 in 8-bit), so the rail depends on
 * the bit depth; a small margin catches clips that were rescaled slightly.
 */
export function clipLevel(audio: Partial<Pick<DecodedAudio, 'bitsPerSample' | 'encoding'>>): number {
  if (audio.encoding !== 'pcm' || !audio.bitsPerSample) return 0.999
  return Math.min(0.999, 1 - 1.5 / 2 ** (audio.bitsPerSample - 1))
}

export function analyse(audio: Pick<DecodedAudio, 'samples' | 'sampleRate'> & Partial<Pick<DecodedAudio, 'bitsPerSample' | 'encoding'>>): AudioStats {
  const { samples, sampleRate } = audio
  const durationS = samples.length / sampleRate
  const rail = clipLevel(audio)
  let peak = 0
  let sumSquares = 0
  let clipped = 0
  for (const s of samples) {
    const a = Math.abs(s)
    if (a > peak) peak = a
    if (a >= rail) clipped++
    sumSquares += s * s
  }

  // Loudness per 50 ms window drives silence and noise measurements.
  const size = Math.max(1, Math.round(sampleRate * WINDOW_S))
  const windows: number[] = []
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size)
    let sum = 0
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!
    windows.push(toDb(Math.sqrt(sum / (end - start))))
  }
  const loud = windows.map((db) => db > SILENCE_DB)
  const first = loud.indexOf(true)
  const last = loud.lastIndexOf(true)
  const sorted = windows.filter(Number.isFinite).toSorted((a, b) => a - b)
  const noiseFloorDb = sorted.length ? percentile(sorted, 0.1) : -Infinity

  return {
    durationS,
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sumSquares / Math.max(1, samples.length))),
    clippedRatio: samples.length ? clipped / samples.length : 0,
    noiseFloorDb,
    snrDb: sorted.length ? percentile(sorted, 0.9) - noiseFloorDb : 0,
    speechS: loud.filter(Boolean).length * WINDOW_S,
    leadingSilenceS: first === -1 ? durationS : first * WINDOW_S,
    trailingSilenceS: last === -1 ? durationS : Math.max(0, durationS - (last + 1) * WINDOW_S),
  }
}

export type Verdict = { rating: 'good' | 'usable' | 'poor'; problems: string[]; advice: string[] }

/**
 * Suitability for voice cloning. The thresholds follow the roadmap's guidance:
 * ElevenLabs Instant Voice Cloning wants roughly 1–2 minutes of clean speech.
 */
export function judge(audio: Pick<DecodedAudio, 'sampleRate' | 'channels' | 'bitsPerSample'>, stats: AudioStats): Verdict {
  const problems: string[] = []
  const advice: string[] = []
  let rating: Verdict['rating'] = 'good'
  const worse = (to: Verdict['rating']) => {
    if (to === 'poor' || rating === 'good') rating = to
  }

  if (stats.speechS < 30) {
    worse('poor')
    problems.push(`Only ${stats.speechS.toFixed(0)} s of speech; cloning needs roughly 1–2 minutes.`)
  } else if (stats.speechS < 60) {
    worse('usable')
    problems.push(`${stats.speechS.toFixed(0)} s of speech; 1–2 minutes gives a closer likeness.`)
  }
  if (stats.clippedRatio > 0.001) {
    worse('poor')
    problems.push(`${(stats.clippedRatio * 100).toFixed(2)}% of samples are clipped (distorted).`)
    advice.push('Re-record with the input gain lower; clipping cannot be repaired.')
  }
  if (stats.snrDb < 20) {
    worse('poor')
    problems.push(`Speech is only ${stats.snrDb.toFixed(0)} dB above the background.`)
    advice.push('Record in a quieter room, closer to the microphone.')
  } else if (stats.noiseFloorDb > -55) {
    worse('usable')
    problems.push(`Audible background noise (${stats.noiseFloorDb.toFixed(0)} dBFS between words).`)
  }
  if (audio.sampleRate < 22_050) {
    worse('poor')
    problems.push(`Sample rate ${audio.sampleRate} Hz is too low for a natural voice.`)
  } else if (audio.sampleRate < 44_100) {
    worse('usable')
    problems.push(`Sample rate ${audio.sampleRate} Hz; 44.1 kHz or more is better.`)
  }
  if (audio.bitsPerSample < 16) {
    worse('usable')
    problems.push(`${audio.bitsPerSample}-bit audio is noisy; use 16-bit or more.`)
  }
  if (stats.peakDb < -12) advice.push(`Peaks reach only ${stats.peakDb.toFixed(1)} dBFS; normalise to about −1 dBFS.`)
  if (stats.leadingSilenceS > 1 || stats.trailingSilenceS > 1) advice.push('Trim the silence at the start and end.')
  if (audio.channels > 1) advice.push('Stereo is fine; the clone uses one channel, so mono 44.1 kHz WAV is the ideal upload.')
  return { rating, problems, advice }
}

/**
 * ElevenLabs names Voice Library previews "voice_preview_<name> - <traits>.mp3"
 * (spaces often become underscores). Returns the voice's name, or null.
 */
export function libraryPreviewName(filename: string): string | null {
  const match = /voice_preview_([a-z0-9]+(?:[ _][a-z0-9]+)*?)(?:[ _]+-|\.[a-z0-9]+$)/i.exec(filename)
  return match ? match[1]!.replace(/_/g, ' ').trim() : null
}
