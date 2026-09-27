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

Until a custom voice exists, the cloud voice is a stock ElevenLabs voice
(`DEFAULT_ELEVENLABS_VOICE` in `bridge/config.ts`). **No voice sample has been
supplied yet**, so the custom CLAP voice has not been created. The steps below
are how to create it.

## 1. Record a sample

- 1–2 minutes of natural speech in the voice CLAP should have. Instant voice
  cloning needs roughly that much clean audio; more does not help it much.
- A quiet room, one speaker, no music or effects, a steady distance from the
  microphone, and the input gain low enough that nothing clips.
- WAV at 44.1 kHz or higher if you can; any common format works for checking.
- Only clone a voice you have the right to use.

## 2. Inspect it

```bash
npm run voice:inspect -- path/to/sample.wav
npm run voice:inspect -- path/to/sample.wav --json   # machine-readable
```

The report gives format, duration (total and speech), sample rate, channels,
peak and RMS level, clipping, background noise and leading/trailing silence,
then a verdict — **GOOD**, **USABLE** or **POOR** for cloning — with the
reasons and suggested fixes. WAV is read directly; MP3, M4A, OGG, FLAC and WebM
need `ffmpeg` on the PATH (not verified in the development environment, which
had no ffmpeg).

## 3. Preprocess, if the inspector asks for it

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

## 4. Create the voice

In ElevenLabs, create an **Instant Voice Clone** from the prepared file and
copy its **voice ID**. (Professional voice cloning needs far more audio and is
not required.)

## 5. Use it

In `.env.local`:

```bash
ELEVENLABS_API_KEY=...          # stays in the bridge
CLAP_VOICE_ID=...               # the new voice
```

Restart CLAP (`npm start`). `npm run doctor` should report
"cloud voice (custom)", and the HUD's diagnostics panel (**D**) shows the
active voice provider.

## 6. Tune it

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
project's working usage. The development environment could not reach
elevenlabs.io, so the adapter is tested against a mocked upstream only; model
ids are configurable so an upstream rename is a configuration change.
