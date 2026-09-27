# CLAP implementation roadmap

Each phase ends with the same gate: `npm run build`, `npm run lint`,
`npm test`, and a manual check of the phase's critical flow. A phase is not done
while any of those fail.

Status legend: ✅ done · 🟡 partly done · ⬜ not started

---

## Phase 1 — Foundation ✅

Goal: open CLAP, see the HUD, connect to the bridge, and get a streamed
Claude answer to a typed message.

- ✅ Reference analysis, architecture, roadmap (`docs/`)
- ✅ Project scaffold: Vite + React + TypeScript HUD, TypeScript bridge run with
  `tsx`, shared protocol package, Vitest, oxlint
- ✅ Typed WebSocket protocol with zod validation on both ends
- ✅ Bridge: loopback bind, Host/Origin validation, `/health`, rate limit, size
  cap, structured redacted logging, graceful shutdown
- ✅ Agent runtime on the Claude Agent SDK: streaming input, turn queue,
  interrupt serialisation, stream → protocol translation, broken-session
  recovery
- ✅ Permission gate in `PreToolUse` + confirmation broker (policy tested even
  though Phase-1 tools are all low risk)
- ✅ Tool registry with Phase-1 tools: `get_time`, `system_info`, SSRF-guarded
  `web_fetch`, built-in `WebSearch`
- ✅ CLAP personality file
- ✅ `setup`, `doctor`, `start` scripts; `.env.example`; README
- ✅ Tests: every security primitive and pure module, the agent runtime
  against a scripted SDK, and the bridge over real HTTP and WebSocket
- ✅ End-to-end: the HUD in Chromium against the real bridge with a scripted
  agent — typed turns, confirmations, interrupts, resume, layout, no-WebGL
  fallback (`npm run test:e2e`)

**Verify:** `npm run doctor` passes; `npm start`; type a question; the answer
streams into the transcript; the HUD moves THINKING → SPEAKING/IDLE.

## Phase 2 — Voice ✅

Goal: speak to CLAP and hear it answer, with barge-in.

- ✅ Pure voice state machine with tests (all states in
  `docs/clap-architecture.md` §4)
- ✅ Shared microphone stream; energy VAD with adaptive floor, hysteresis and a
  guard threshold while speaking
- ✅ Wake engines: on-device Web Speech (preferred), browser cloud recognition
  (labelled, can be disabled), push-to-talk
- ✅ Configurable wake phrase matcher (`CLAP_WAKE_PHRASE`)
- ✅ `SpeechProvider`: Web Speech and bridge-proxied cloud STT
- ✅ `VoiceProvider`: browser `speechSynthesis` and bridge-proxied cloud TTS,
  with a fallback chain and a sentence-streaming speaker
- ✅ Barge-in (VAD onset, override words, Space), echo filter, word-aware
  endpointing, follow-up window
- ✅ Audio-reactive HUD states
- ✅ Voice logic unit-tested (state machine, confirmation intents, wake
  matching, VAD, endpointing, echo filter, engine selection, speaker)

**Verify:** "Hey CLAP, what time is it?" → spoken answer; talk over the answer →
it stops within ~150 ms and takes the new question; deny the microphone → text
mode still works.

## Phase 3 — Custom CLAP voice 🟡

Goal: CLAP speaks in its own voice.

- ✅ `npm run voice:inspect -- <file>` reports format, duration, sample rate,
  channels, level, clipping and silence, and judges suitability for cloning
- ✅ ElevenLabs adapter behind `VoiceProvider` (`CLAP_VOICE_ID`)
- ✅ Inspect the supplied voice sample: the ElevenLabs Voice Library preview
  of "Dominic" (British, brooding, intense) — 8.6 s, studio-clean, far too
  short to clone. Dominic is used as a library voice instead (`docs/voice.md`)
- ✅ `npm run voice:find -- <name> [--use n]` finds a voice in the account or
  the Voice Library, adds it, and sets `CLAP_VOICE_ID` in `.env.local`
- ✅ Character follows the voice: British English in the personality; the
  browser fallback prefers a British male voice
- ⬜ Set `CLAP_VOICE_ID` to Dominic with the user's ElevenLabs key
  (`npm run voice:find -- dominic --use 1`), listen, tune
  stability/similarity/speed
- ⬜ Optional: a custom cloned voice (1–2 minutes of clean speech; the
  record/inspect/preprocess steps are in `docs/voice.md`)
- ⬜ Evaluate a local TTS adapter for offline use

## Phase 4 — Tools, MCP, browser 🟡

- ✅ Registry, metadata, risk levels, confirmation flow (Phase 1)
- ⬜ External MCP servers from a CLAP config file (not `~/.claude.json`), each
  tool classified conservatively (read verbs → low; destructive verbs → high;
  everything else → medium with confirmation) with per-tool overrides
- ⬜ Files: read, search, create, move (roots from `CLAP_FILE_ROOTS`; delete is
  HIGH)
- ⬜ Web: open a page in the default browser (low), extract information
- ⬜ Browser automation (navigate/inspect low; click/type medium; submit/pay high)
- ⬜ Confirmation UX polish: spoken summary, visual diff for file edits

## Phase 5 — Memory ⬜

- SQLite store behind a `MemoryStore` interface (categories: `user_profile`,
  `preferences`, `projects`, `routines`, `system`, `conversation_summary`)
- Tools: `remember`, `recall`, `forget`, `update_memory` with risk metadata
- A sensitive-data filter that refuses to store credentials, financial or
  health data unless explicitly asked
- Relevant memories injected per turn as a system message, not by editing the
  cached system prompt
- `memory_update` events to the HUD; a memory viewer

## Phase 6 — System and application control ⬜

- Launch/close applications (per-OS adapters), volume, brightness, media keys,
  screenshots, sleep (HIGH), with an allowlist of applications

## Phase 7 — HUD polish ⬜

- Richer audio-reactive shaders, tool-specific visuals, transitions,
  reduced-motion mode, performance budget checks (60 fps on integrated GPUs)

## Phase 8 — Hardening and packaging ⬜

- Security review, fuzzing the protocol validator, dependency audit
- Optional per-launch bridge token in addition to the Origin/Host checks
- Local keyword spotting (e.g. an openWakeWord or Porcupine model for "hey
  clap") so wake detection is local in every browser
- Desktop packaging (Electron/Tauri) with a tray icon and global hotkey

---

## Known limitations after Phase 2

- On-device wake detection depends on Chrome/Edge support for
  `SpeechRecognition` with `processLocally`. Elsewhere CLAP uses the browser's
  cloud recogniser (if allowed) or push-to-talk.
- The ElevenLabs adapter was written against the endpoints the reference
  project uses; this development environment could not reach elevenlabs.io, so
  it is covered by unit tests with a mocked upstream only.
- The development environment's network policy blocks api.elevenlabs.io, so
  `voice:find` is also tested against a mocked upstream only.
- Conversation context lives in the agent session; it survives page reloads and
  short disconnects, but not a bridge restart (by design until Phase 5 memory).
