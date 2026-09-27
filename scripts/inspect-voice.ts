/**
 * npm run voice:inspect -- <file> [--json]
 *
 * Reports a voice sample's format, duration, sample rate, channels, level,
 * clipping and silence, and judges whether it is suitable for cloning the CLAP
 * voice. WAV is read directly; MP3, M4A, OGG, FLAC and WebM are decoded with
 * ffmpeg when it is installed. See docs/voice.md for the whole workflow.
 */

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { analyse, AudioFormatError, judge, parseWav, sniffFormat, type AudioStats, type DecodedAudio } from './lib/audio'

/** Decode anything ffmpeg understands to 32-bit float mono WAV, keeping the rate. */
function decodeWithFfmpeg(path: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-ac', '1', '-c:a', 'pcm_f32le', '-f', 'wav', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

const seconds = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`)
const db = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)} dBFS` : 'silent')

function report(file: string, format: string, audio: DecodedAudio, channels: number, stats: AudioStats): string {
  const verdict = judge({ ...audio, channels }, stats)
  const lines = [
    '',
    `Voice sample: ${basename(file)}`,
    '',
    `  Format        ${format.toUpperCase()}, ${audio.encoding === 'float' ? `${audio.bitsPerSample}-bit float` : `${audio.bitsPerSample}-bit PCM`}`,
    `  Duration      ${seconds(stats.durationS)} (speech ${seconds(stats.speechS)})`,
    `  Sample rate   ${audio.sampleRate} Hz`,
    `  Channels      ${channels}`,
    `  Peak          ${db(stats.peakDb)}`,
    `  Loudness      ${db(stats.rmsDb)} RMS`,
    `  Clipping      ${(stats.clippedRatio * 100).toFixed(3)}% of samples`,
    `  Background    ${db(stats.noiseFloorDb)} (speech ${stats.snrDb.toFixed(0)} dB above it)`,
    `  Silence       ${seconds(stats.leadingSilenceS)} at the start, ${seconds(stats.trailingSilenceS)} at the end`,
    '',
    `  Verdict: ${verdict.rating.toUpperCase()} for voice cloning`,
    ...verdict.problems.map((p) => `    - ${p}`),
    ...(verdict.advice.length ? ['', '  Suggestions:', ...verdict.advice.map((a) => `    - ${a}`)] : []),
    '',
  ]
  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    process.stderr.write('Usage: npm run voice:inspect -- <audio file> [--json]\n')
    process.exitCode = 2
    return
  }

  let buffer: Buffer
  try {
    if (!statSync(file).isFile()) throw new Error('not a file')
    buffer = readFileSync(file)
  } catch {
    process.stderr.write(`Cannot read ${file}.\n`)
    process.exitCode = 1
    return
  }

  const format = sniffFormat(buffer.subarray(0, 16))
  let wav: Buffer | null = format === 'wav' ? buffer : null
  let channels = 0
  if (!wav) {
    wav = await decodeWithFfmpeg(file)
    if (!wav) {
      process.stderr.write(
        `${basename(file)} looks like ${format === 'unknown' ? 'an unrecognised format' : format.toUpperCase()}, which this tool reads only through ffmpeg.\n` +
          'Install ffmpeg, or convert it first:  ffmpeg -i input -ac 1 -ar 44100 sample.wav\n',
      )
      process.exitCode = 1
      return
    }
  }

  let audio: DecodedAudio
  try {
    audio = parseWav(wav)
    // ffmpeg's output is already mixed to mono; ask the original for its channel count.
    channels = format === 'wav' ? audio.channels : await probeChannels(file)
  } catch (error) {
    process.stderr.write(`${basename(file)}: ${error instanceof AudioFormatError ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }

  const stats = analyse(audio)
  if (json) {
    const verdict = judge({ ...audio, channels }, stats)
    const { samples: _samples, ...info } = audio
    process.stdout.write(`${JSON.stringify({ file, format, ...info, channels, ...stats, verdict }, null, 2)}\n`)
  } else {
    process.stdout.write(report(file, format, audio, channels, stats))
  }
}

function probeChannels(path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', path],
      { windowsHide: true },
      (error, stdout) => resolve(error ? 1 : Number(String(stdout).trim()) || 1),
    )
  })
}

void main()
