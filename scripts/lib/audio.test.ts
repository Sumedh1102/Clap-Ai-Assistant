import { describe, expect, it } from 'vitest'
import { analyse, AudioFormatError, clipLevel, judge, libraryPreviewName, parseWav, sniffFormat } from './audio'

/** One RIFF chunk, padded to an even length. */
function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'ascii')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

/** 16 bytes starting with `text` at `at`. */
function bytes(text: string, at = 0): Uint8Array {
  const b = new Uint8Array(16)
  b.set([...text].map((c) => c.charCodeAt(0)), at)
  return b
}

/** Build a PCM or float WAV from per-channel sample arrays. */
function wav(channels: number[][], sampleRate: number, bits: 8 | 16 | 24 | 32, float = false, extensible = false): Buffer {
  const frames = channels[0]!.length
  const width = bits / 8
  const data = Buffer.alloc(frames * channels.length * width)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const x = Math.max(-1, Math.min(1, channels[c]![i]!))
      const at = (i * channels.length + c) * width
      if (float) data.writeFloatLE(x, at)
      else if (bits === 8) data.writeUInt8(Math.round(x * 127 + 128), at)
      else if (bits === 16) data.writeInt16LE(Math.round(x * 32767), at)
      else if (bits === 24) data.writeIntLE(Math.round(x * 8388607), at, 3)
      else data.writeInt32LE(Math.round(x * 2147483647), at)
    }
  }
  const fmt = Buffer.alloc(extensible ? 40 : 16)
  fmt.writeUInt16LE(extensible ? 0xfffe : float ? 3 : 1, 0)
  fmt.writeUInt16LE(channels.length, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels.length * width, 8)
  fmt.writeUInt16LE(channels.length * width, 12)
  fmt.writeUInt16LE(bits, 14)
  if (extensible) {
    fmt.writeUInt16LE(22, 16)
    fmt.writeUInt16LE(float ? 3 : 1, 24)
  }
  // An odd-sized chunk before fmt checks word alignment.
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('LIST', Buffer.from('odd')), chunk('fmt ', fmt), chunk('data', data)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/** Speech-like signal: a tone in bursts, with quiet noise between and around. */
function voice(seconds: number, sampleRate: number, options: { level?: number; noise?: number; lead?: number } = {}): number[] {
  const { level = 0.5, noise = 0.0005, lead = 0.5 } = options
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const out: number[] = []
  for (let i = 0; i < seconds * sampleRate; i++) {
    const t = i / sampleRate
    const speaking = t >= lead && t < seconds - lead && Math.floor(t * 2) % 4 !== 3
    out.push((speaking ? level * Math.sin(2 * Math.PI * 180 * t) : 0) + noise * random())
  }
  return out
}

describe('sniffFormat', () => {
  it('recognises common audio containers by magic bytes', () => {
    const riff = bytes('RIFF')
    riff.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8)
    expect(sniffFormat(riff)).toBe('wav')
    expect(sniffFormat(bytes('ID3'))).toBe('mp3')
    expect(sniffFormat(new Uint8Array([0xff, 0xfb, 0x90]))).toBe('mp3')
    expect(sniffFormat(bytes('OggS'))).toBe('ogg')
    expect(sniffFormat(bytes('fLaC'))).toBe('flac')
    expect(sniffFormat(bytes('ftyp', 4))).toBe('mp4')
    expect(sniffFormat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm')
    expect(sniffFormat(bytes('hello'))).toBe('unknown')
  })
})

describe('parseWav', () => {
  it.each([
    [8, false, false],
    [16, false, false],
    [24, false, false],
    [32, false, false],
    [32, true, false],
    [16, false, true],
    [32, true, true],
  ] as const)('decodes %i-bit (float %s, extensible %s) and mixes to mono', (bits, float, extensible) => {
    const left = [0, 0.5, -0.5, 0.25]
    const right = [0, 0.5, 0.5, -0.25]
    const audio = parseWav(wav([left, right], 44_100, bits, float, extensible))
    expect(audio).toMatchObject({ sampleRate: 44_100, channels: 2, bitsPerSample: bits, encoding: float ? 'float' : 'pcm' })
    const tolerance = bits === 8 ? 0.02 : 0.001
    expect(Array.from(audio.samples).map((x) => Math.abs(x - 0) < 1 && x)).toHaveLength(4)
    ;[0, 0.5, 0, 0].forEach((expected, i) => expect(Math.abs(audio.samples[i]! - expected)).toBeLessThan(tolerance))
  })

  it('refuses files it cannot read', () => {
    expect(() => parseWav(Buffer.from('not audio at all'))).toThrow(AudioFormatError)
    const noData = wav([[0]], 8_000, 16).subarray(0, 12 + 12 + 8 + 16)
    expect(() => parseWav(noData)).toThrow(/data chunk/)
  })
})

describe('analyse and judge', () => {
  it('passes a clean 90-second sample', () => {
    const audio = parseWav(wav([voice(90, 22_050 * 2)], 44_100, 16))
    const stats = analyse(audio)
    expect(stats.durationS).toBeCloseTo(90, 1)
    expect(stats.speechS).toBeGreaterThan(60)
    expect(stats.peakDb).toBeCloseTo(-6, 0)
    expect(stats.clippedRatio).toBe(0)
    expect(stats.snrDb).toBeGreaterThan(40)
    expect(stats.leadingSilenceS).toBeCloseTo(0.5, 1)
    expect(judge(audio, stats)).toEqual({ rating: 'good', problems: [], advice: [] })
  })

  it('fails a short, clipped, noisy, low-rate sample and says why', () => {
    const rate = 16_000
    const samples = voice(20, rate, { level: 1.4, noise: 0.2, lead: 3 })
    const audio = parseWav(wav([samples], rate, 8))
    const verdict = judge(audio, analyse(audio))
    expect(verdict.rating).toBe('poor')
    expect(verdict.problems.join(' ')).toMatch(/Only \d+ s of speech/)
    expect(verdict.problems.join(' ')).toMatch(/clipped/)
    expect(verdict.problems.join(' ')).toMatch(/16000 Hz is too low/)
    expect(verdict.problems.join(' ')).toMatch(/8-bit/)
    expect(verdict.advice.join(' ')).toMatch(/Re-record/)
  })

  it('suggests trimming long silence at either end', () => {
    const audio = parseWav(wav([voice(95, 44_100, { lead: 3 })], 44_100, 16))
    const stats = analyse(audio)
    expect(stats.leadingSilenceS).toBeCloseTo(3, 1)
    expect(stats.trailingSilenceS).toBeGreaterThanOrEqual(3)
    expect(judge(audio, stats).advice).toContain('Trim the silence at the start and end.')
  })

  it('suggests normalising quiet recordings and notes stereo', () => {
    const quiet = voice(90, 48_000, { level: 0.1 })
    const audio = parseWav(wav([quiet, quiet], 48_000, 16))
    const verdict = judge(audio, analyse(audio))
    expect(verdict.rating).toBe('good')
    expect(verdict.advice.join(' ')).toMatch(/normalise to about −1 dBFS/)
    expect(verdict.advice.join(' ')).toMatch(/Stereo is fine/)
  })

  it('judges clipping against full scale for the bit depth', () => {
    expect(clipLevel({ encoding: 'pcm', bitsPerSample: 8 })).toBeLessThan(127 / 128)
    expect(clipLevel({ encoding: 'pcm', bitsPerSample: 16 })).toBeLessThan(32767 / 32768)
    expect(clipLevel({ encoding: 'pcm', bitsPerSample: 16 })).toBe(0.999)
    expect(clipLevel({ encoding: 'float', bitsPerSample: 32 })).toBe(0.999)
  })

  it('handles total silence', () => {
    const stats = analyse({ samples: new Float32Array(44_100), sampleRate: 44_100 })
    expect(stats.peakDb).toBe(-Infinity)
    expect(stats.speechS).toBe(0)
    expect(stats.leadingSilenceS).toBe(1)
  })
})

describe('libraryPreviewName', () => {
  it('recognises ElevenLabs Voice Library preview filenames', () => {
    expect(libraryPreviewName('voice_preview_dominic - british brooding, intense.mp3')).toBe('dominic')
    expect(libraryPreviewName('c4fe57f1-voice_preview_dominic_-_british_brooding__intense.mp3')).toBe('dominic')
    expect(libraryPreviewName('voice_preview_jean luc - french, warm.mp3')).toBe('jean luc')
    expect(libraryPreviewName('voice_preview_aria.mp3')).toBe('aria')
    expect(libraryPreviewName('my-voice.wav')).toBeNull()
  })
})
