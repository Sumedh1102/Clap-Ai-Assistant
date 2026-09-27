# CLAP's voice

CLAP speaks through a chain of voice providers and uses the first one that
works (`src/voice/tts/fallback.ts`):

1. **Cloud voice** — ElevenLabs, proxied by the bridge so the API key never
   reaches the browser. Used when `ELEVENLABS_API_KEY` is set.
2. **Browser voice** — the browser's `speechSynthesis`. Always available as the
   fallback; press **V** in the HUD to cycle through installed voices.

A sentence the cloud voice fails to speak is retried in the browser voice, and
the HUD shows a notice. After two failures in a row the cloud voice is skipped
for the rest of the session.

Until `CLAP_VOICE_ID` is set, the cloud voice is a stock ElevenLabs voice
(`DEFAULT_ELEVENLABS_VOICE` in `bridge/config.ts`).

## CLAP's voice: Dominic

The chosen voice is **Dominic** — British, brooding, intense — from the
ElevenLabs Voice Library. The sample supplied for it is the library's own
preview (`voice_preview_dominic - british brooding, intense.mp3`). Inspected:

| | |
|---|---|
| Format | MP3, 128 kbps, 44.1 kHz, mono |
| Length | 8.6 s, of which 7.1 s is speech |
| Level | peak −3.9 dBFS, no clipping |
| Background | −77.6 dBFS: studio-clean |

It is clean, but seven seconds is far too little to clone from, and it does
not need cloning: Dominic already exists as a voice. Using the library voice
itself gives the full-quality original, where a clone of its preview would be
a weaker copy, and one of someone else's voice at that. So CLAP uses Dominic
directly:

```bash
# 1. In .env.local, the key (it stays in the bridge):
ELEVENLABS_API_KEY=...

# 2. Find Dominic in your voices and the Voice Library:
npm run voice:find -- dominic

# 3. Add the right match to your account and set CLAP_VOICE_ID in .env.local:
npm run voice:find -- dominic --use 1

# 4. Restart
npm start
```

`npm run doctor` then asks ElevenLabs about the configured voice and should
report `cloud voice "Dominic …"`; a bad key, a voice missing from the account or
a blocked network is reported with the reason. Some library voices
are only available on certain ElevenLabs plans; if the add step is refused,
add Dominic from the Voice Library on the ElevenLabs site and run step 2 again
— it will then be listed under your voices.

The rest of CLAP follows the voice's character: the personality writes British
English in short, measured sentences (`bridge/agent/clap-personality.md`), and
if the cloud voice fails, the browser fallback prefers a British male voice so
CLAP still sounds like the same person.

## Making a custom voice instead

To give CLAP a voice of its own rather than a library voice:

### 1. Record a sample

- 1–2 minutes of natural speech in the voice CLAP should have. Instant voice
  cloning needs roughly that much clean audio; more does not help it much.
- A quiet room, one speaker, no music or effects, a steady distance from the
  microphone, and the input gain low enough that nothing clips.
- WAV at 44.1 kHz or higher if you can; any common format works for checking.
- Only clone a voice you have the right to use.

### 2. Inspect it

```bash
npm run voice:inspect -- path/to/sample.wav
npm run voice:inspect -- path/to/sample.wav --json   # machine-readable
```

The report gives format, duration (total and speech), sample rate, channels,
peak and RMS level, clipping, background noise and leading/trailing silence,
then a verdict — **GOOD**, **USABLE** or **POOR** for cloning — with the
reasons and suggested fixes. WAV is read directly; MP3, M4A, OGG, FLAC and WebM
need `ffmpeg` (and `ffprobe`) on the PATH. It recognises a Voice Library
preview by its file name and points to `voice:find` instead.

### 3. Preprocess, if the inspector asks for it

With ffmpeg:

```bash
# Mono 44.1 kHz 16-bit WAV
ffmpeg -i sample.m4a -ac 1 -ar 44100 -c:a pcm_s16le sample.wav

# Trim silence from both ends
ffmpeg -i sample.wav -af "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse" trimmed.wav

# Normalise the peak to −1 dBFS: if the inspector reports a peak of P dBFS,
# raise it by (−1 − P) dB — e.g. a −7.5 dBFS peak needs +6.5 dB
ffmpeg -i trimmed.wav -af "volume=6.5dB" clap-voice.wav
```

Run the inspector again on the result. Clipping and background noise cannot be
repaired this way; re-record instead.

### 4. Create the voice

In ElevenLabs, create an **Instant Voice Clone** from the prepared file and
copy its **voice ID**. (Professional voice cloning needs far more audio and is
not required.)

### 5. Use it

In `.env.local`:

```bash
ELEVENLABS_API_KEY=...          # stays in the bridge
CLAP_VOICE_ID=...               # the new voice
```

Restart CLAP (`npm start`). `npm run doctor` should report the voice by name,
and the HUD's diagnostics panel (**D**) shows the active voice provider.

## Tuning the voice

| Variable | Range | Effect |
|---|---|---|
| `CLAP_VOICE_STABILITY` | 0–1 | Lower is more expressive, higher more even |
| `CLAP_VOICE_SIMILARITY` | 0–1 | How closely to match the sample |
| `CLAP_VOICE_SPEED` | 0.7–1.2 | Speaking rate |
| `CLAP_TTS_MODEL` | model id | Synthesis model (default `eleven_flash_v2_5`, chosen for latency) |
| `CLAP_TTS_OUTPUT_FORMAT` | format id | Default `mp3_44100_128` |

Unset tuning variables leave the voice's own settings in place.

## Cloud transcription

The same key enables cloud speech-to-text (`CLAP_STT_MODEL`, default
`scribe_v1`). Audio is uploaded only while CLAP is listening for a command —
never while it waits for the wake phrase — and is logged as a byte count only.
Set `CLAP_STT_PROVIDER=none` to keep recognition in the browser.

## Caveat

The ElevenLabs endpoints in `bridge/voice/elevenlabs.ts` follow the reference
project's working usage, and those in `scripts/lib/voices.ts` (voice lookup)
follow ElevenLabs' public API. The development environment's network policy
blocks api.elevenlabs.io, so both are tested against a mocked upstream only;
model ids are configurable so an upstream rename is a configuration change.
