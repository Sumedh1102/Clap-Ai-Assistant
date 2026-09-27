# CLAP architecture

CLAP is a voice-first personal assistant: a browser HUD that listens and speaks,
a local bridge that owns the session, the tools and the permission model, and a
Claude agent runtime that reasons and calls those tools.

```
                ┌──────────────────────────────────────────────┐
                │ CLAP HUD  (browser · React · Three.js)       │
                │  voice state machine ─ controller ─ store    │
                │  mic · VAD · wake engine · STT/TTS providers │
                └───────────────────────┬──────────────────────┘
                     WebSocket /ws  (typed protocol, v1)
                     HTTP /health, /api/tts, /api/stt
                ┌───────────────────────▼──────────────────────┐
                │ CLAP BRIDGE  (Node · TypeScript · 127.0.0.1) │
                │  host+origin checks · sessions · rate limits │
                │  permission gate · confirmation broker       │
                │  voice proxy (cloud keys stay here) · logs   │
                └───────────────────────┬──────────────────────┘
                                        │ in-process
                ┌───────────────────────▼──────────────────────┐
                │ AGENT RUNTIME  (Claude Agent SDK, streaming) │
                │  personality · PreToolUse gate · turn queue  │
                └──────┬────────────────┬───────────────┬──────┘
                       ▼                ▼               ▼
                  CLAP tools       Web tools       External MCP
                (in-process MCP)  (SSRF-guarded)   (Phase 4, gated)
```

The rules that shape everything else:

1. **The bridge is the authority.** Tool permissions, confirmations, secrets and
   rate limits are enforced in the bridge. The HUD displays and relays; it never
   decides.
2. **Nothing secret reaches the browser.** Provider keys live in the bridge's
   environment. The browser has no `VITE_*` secrets.
3. **Voice never blocks the UI.** Audio analysis runs in Web Audio nodes;
   transcription and synthesis are asynchronous; the 3D scene reads live levels
   from refs in its frame loop instead of through React state.
4. **Every failure is survivable and visible.** A failed tool, provider or
   connection degrades one capability, is reported in plain words, and never
   takes the assistant down.

---

## 1. Repository layout

```
.
├── shared/                 # code imported by both the HUD and the bridge
│   ├── protocol.ts         # WebSocket event types + zod schemas (v1)
│   ├── risk.ts             # risk levels and policies
│   └── defaults.ts         # default ports, wake phrase, limits
├── bridge/                 # Node process (run with tsx)
│   ├── server.ts           # entry: config, HTTP + WS, sessions, shutdown
│   ├── config.ts           # environment parsing and validation
│   ├── logger.ts           # structured, redacted logging
│   ├── sessions.ts         # session registry, grace period, resume
│   ├── connection.ts       # one socket: validation, rate limit, routing
│   ├── permissions.ts      # permission gate + confirmation broker
│   ├── agent/
│   │   ├── runtime.ts      # Agent SDK session: turns, interrupts, events
│   │   ├── prompt.ts       # builds the system prompt
│   │   └── clap-personality.md
│   ├── tools/
│   │   ├── registry.ts     # tool metadata, validation, execution wrapper
│   │   ├── mcp.ts          # exposes the registry as an in-process MCP server
│   │   ├── system.ts       # time, system information
│   │   └── web.ts          # SSRF-guarded fetch + text extraction
│   ├── voice/
│   │   └── elevenlabs.ts   # TTS/STT proxy (keys stay server-side)
│   └── security/
│       ├── http-guard.ts   # Host and Origin validation, CORS
│       ├── ssrf.ts         # outbound URL/address vetting, guarded fetch
│       └── paths.ts        # filesystem containment
├── src/                    # HUD (Vite + React)
│   ├── app/                # App shell, controller, frontend config
│   ├── voice/              # state machine, wake, endpointing, echo, VAD,
│   │   ├── stt/            #   SpeechProvider adapters
│   │   └── tts/            #   VoiceProvider adapters, sentence speaker
│   ├── audio/              # shared mic stream, output context, cues
│   ├── hud/                # Three.js scene and DOM overlay
│   ├── lib/                # bridge client, text utilities, ids
│   └── state/              # zustand store (render state only)
├── scripts/                # setup, doctor, start, voice inspection
├── docs/
└── public/
```

**Where this deviates from the suggested tree, and why.**

- `clap-personality.md` lives in `bridge/agent/`, not `src/agent/`. Only the
  bridge reads it; anything under `src/` is a candidate for the browser bundle.
- Tools and memory live under `bridge/`. The browser never executes a tool, so
  `src/tools` and `src/memory` would be empty or misleading.
- `shared/` holds the protocol so both sides compile against one definition.
- Tests sit next to the code they test (`*.test.ts`) rather than in a separate
  tree.

---

## 2. Process model and startup

`npm start` runs `scripts/start.ts`:

1. Checks Node ≥ 20, the Agent SDK's bundled Claude Code binary, and Claude
   authentication (`claude auth status --json`, or `ANTHROPIC_API_KEY`).
2. Validates the environment (`bridge/config.ts` — the same parser the bridge
   uses, so the check cannot drift from reality).
3. Checks that the bridge and UI ports are free.
4. Starts the bridge, waits for `GET /health`.
5. Starts Vite on the configured UI port with `strictPort`, so the page origin is
   exactly the one the bridge was told to trust.
6. Opens the browser (unless `CLAP_OPEN_BROWSER=0`) and prints a status block.
7. Forwards Ctrl-C to both children and exits when either dies.

`npm run bridge` and `npm run dev` run the two halves separately.
`npm run doctor` runs the checks without starting anything.

---

## 3. WebSocket protocol (v1)

Defined once in `shared/protocol.ts` as zod schemas; TypeScript types are
inferred from them. The bridge validates every inbound message; the HUD
validates every inbound event. Unknown or malformed messages produce a typed
`error` event and are otherwise ignored; messages over 64 KiB close the socket.

### Client → bridge

| Event | Payload | Meaning |
|---|---|---|
| `hello` | `protocol`, `client`, `resumeSessionId?` | First message on every socket. Resumes a session when possible. |
| `user_message` | `turnId`, `text`, `source: voice\|text` | Start a turn. Supersedes any turn in flight. |
| `interrupt` | `turnId?`, `reason: barge_in\|user_cancel\|stand_down` | Stop the current turn now. |
| `wake_detected` | `engine`, `at` | Telemetry: the wake phrase fired. |
| `speech_start` / `speech_stop` | `at`, `durationMs?` | Telemetry: the user started/stopped talking. |
| `assistant_speech_start` / `assistant_speech_end` | `turnId`, `provider` / `interrupted` | Telemetry: playback began/ended in the HUD. |
| `confirmation_response` | `requestId`, `approved`, `via: voice\|click\|key` | Answer to a `confirmation_request`. |
| `ping` | `t` | Liveness and latency. |

`assistant_speech_start/end` travel from the HUD to the bridge because speech is
played in the browser (the bridge only proxies cloud synthesis). They give the
bridge accurate timing for logs. If synthesis is ever streamed from the bridge,
it will add `assistant_audio` events without changing these.

### Bridge → client

| Event | Payload | Meaning |
|---|---|---|
| `session_ready` | `sessionId`, `resumed`, `model`, `capabilities`, `tools[]`, `wakePhrase` | Handshake reply. |
| `state_change` | `turnId`, `activity: idle\|thinking\|executing\|responding` | Agent-side activity. |
| `assistant_text` | `turnId`, `delta` | Streamed answer text. |
| `turn_complete` | `turnId`, `text`, `interrupted`, `durationMs` | The turn is over. |
| `tool_start` | `turnId`, `toolUseId`, `name`, `label`, `risk`, `summary` | A permitted tool is starting. Never sent for denied calls. |
| `tool_result` | `turnId`, `toolUseId`, `name`, `durationMs`, `summary` | Tool finished. |
| `tool_error` | `turnId`, `toolUseId`, `name`, `durationMs`, `error`, `denied` | Tool failed or was refused. |
| `confirmation_request` | `requestId`, `turnId`, `name`, `label`, `risk`, `summary`, `expiresAt` | The bridge needs a yes/no. |
| `confirmation_resolved` | `requestId`, `approved`, `reason: user\|timeout\|cancelled` | Outcome of a confirmation. |
| `memory_update` | `op`, `category`, `key`, `summary` | Reserved for Phase 5. |
| `error` | `turnId?`, `code`, `message`, `recoverable` | Something failed; `message` is safe to speak. |
| `pong` | `t`, `serverTime` | Reply to `ping`. |

### Turn identity

The HUD mints a `turnId` for each `user_message`. The bridge tags every event
belonging to a turn with it, and the HUD drops events for turns it has
abandoned. Inside the bridge, turns are delivered to the agent one at a time: a
new message is held until the previous turn's `result` arrives (capped at
2.5 s after an interrupt), because the probe showed an interrupted turn keeps
streaming until that point and a message delivered mid-turn can be folded into
it. A turn still unsettled at the cap is abandoned: its late result, and frames
once one of them identifies the turn, are dropped rather than attributed to the
turn that replaced it.

---

## 4. The voice state machine

`src/voice/machine.ts` is a pure function
`transition(context, event) → { context, effects }`. It performs no I/O; the
controller executes the effects (send a message, stop speech, start a timer…).
This keeps the conversational logic deterministic and unit-testable, and keeps
it out of React components.

### States

| State | Meaning | HUD |
|---|---|---|
| `OFFLINE` | Bridge unreachable. | Grey, split core, reconnect sweep |
| `IDLE` | Connected; voice not activated, muted, or push-to-talk only. | Low-power breathing |
| `LISTENING_FOR_WAKE` | Waiting locally for the wake phrase. | Faint radar pulse |
| `WAKE_DETECTED` | Wake phrase heard (≈600 ms). | The two halves snap together, ripple burst |
| `LISTENING` | Capturing a command; follow-up window after answers. | Mint surface reacting to the mic |
| `THINKING` | Turn in flight, nothing audible, no tool running. | Violet orbital lattice |
| `EXECUTING` | A tool is running. | Amber segmented rings, tool readout |
| `SPEAKING` | Speech is audible. | Warm ripples driven by output level |
| `CONFIRMING` | The bridge is waiting for a yes/no. | Amber/red prompt card |
| `ERROR` | A failure is being shown; clears itself. | Red, jitter |

### Main flow

```
IDLE ──activate──▶ LISTENING_FOR_WAKE ──wake──▶ WAKE_DETECTED ──600ms──▶ LISTENING
                        ▲                                                   │ utterance
                        │ follow-up window expires                          ▼
                    LISTENING ◀──speech drained & turn complete── SPEAKING ◀─ THINKING ⇄ EXECUTING
```

- `SPEAKING` and `THINKING/EXECUTING` interleave within one turn: the model may
  speak a sentence, call a tool, then speak again. The machine tracks
  `toolsRunning`, `audible`, `streamDone` and `speechDrained` in its context and
  derives the state from them, so it cannot get stuck in `EXECUTING` while
  speech plays (a bug the reference hit).
- A turn ends only when the bridge has sent `turn_complete` **and** the speech
  queue has drained. The machine then enters `LISTENING` for a follow-up window
  (default 7 s) so a conversation does not need the wake phrase every time.

### Barge-in

In `THINKING`, `EXECUTING` or `SPEAKING`, a confirmed voice onset from the VAD
(threshold raised while speaking, and ignored during the first 350 ms of each
spoken sentence) produces effects `stopSpeech` (80 ms fade) and
`interruptTurn`, and moves to `LISTENING`. The next utterance becomes a new turn.
Pressing Space, typing, or saying an override word ("stop", "cancel", "wait")
does the same. Escape stands down to the resting state.

### Recogniser mode

Each state implies a mode for the voice input: `off` (OFFLINE, IDLE), `wake`
(LISTENING_FOR_WAKE, and ERROR when no turn is in flight), `command`
(WAKE_DETECTED, LISTENING, CONFIRMING), `guard` (THINKING, EXECUTING,
SPEAKING). The machine accepts the wake phrase exactly when the mode is
`wake`. In `wake` mode nothing leaves the machine
unless a local engine is unavailable and the user allowed the browser's cloud
recogniser. VAD segments captured in `wake` or `guard` mode are discarded, never
uploaded.

---

## 5. Voice providers and capability detection

### Interfaces

```ts
interface VoiceProvider {            // text → speech
  readonly id: string
  getCapabilities(): VoiceCapabilities   // { cloud, customVoice, streaming, local }
  speak(text: string, opts?): Promise<SpeakResult>  // resolves when playback ends
  stop(fadeMs?: number): void
  isSpeaking(): boolean
  level(): number                        // 0..1 output loudness for visuals
}

interface SpeechProvider {           // speech → text
  readonly id: string
  getCapabilities(): SpeechCapabilities  // { cloud, local, partials }
  start(handlers: { onPartial, onFinal, onError }): Promise<void>
  stop(): void        // finish and flush
  abort(): void       // discard
  isActive(): boolean
}

interface WakeWordEngine {
  readonly id: string                    // 'webspeech-local' | 'webspeech-cloud' | 'push-to-talk'
  start(onWake: (trailing: string) => void): Promise<void>
  stop(): void
}
```

Adapters in this phase:

| Kind | Adapter | Notes |
|---|---|---|
| Wake | `webspeech-local` | Chrome/Edge on-device recognition (`processLocally = true`). Audio stays on the machine. |
| Wake | `webspeech-cloud` | Browser recognition that sends audio to the browser vendor. Used only if allowed (`VITE_CLAP_WAKE_ALLOW_CLOUD`, default on) and labelled in the HUD. |
| Wake | `push-to-talk` | Always available: Space or click the core. |
| STT | `webspeech` | Browser recognition for the command (local when available). |
| STT | `bridge-cloud` | VAD segments POSTed to `/api/stt`; the bridge calls ElevenLabs Scribe with its own key. |
| TTS | `bridge-cloud` | `/api/tts` → ElevenLabs, using `CLAP_VOICE_ID` (the custom CLAP voice). |
| TTS | `browser` | `speechSynthesis`, with the wedge/keep-alive/watchdog workarounds. |

A `FallbackVoiceProvider` tries the preferred provider and falls through to the
next on error, latching off a provider that fails repeatedly. A
`SentenceSpeaker` sits on top: it receives streamed deltas, cuts sentences
(abbreviation- and decimal-aware), primes the next sentence's audio while the
current one plays, and can be cancelled instantly for barge-in.

### Capability detection

At initialisation the HUD collects: microphone permission, `SpeechRecognition`
presence, on-device recognition status (`SpeechRecognition.available(...)`,
raced against a 2.5 s timeout because it can hang), `speechSynthesis`,
`MediaRecorder`, and the bridge's `/health` capabilities. A pure function
`selectEngines(capabilities, preferences)` picks the wake engine, the STT
provider and the TTS chain. Every choice has a fallback, and the choice is shown
in the HUD's system panel.

### Wake phrase

`CLAP_WAKE_PHRASE` (default `hey clap`) is set on the bridge and delivered in
`session_ready` and `/health`, so there is one source of truth. The matcher
normalises text, requires every word of the phrase in order, accepts small edit
distances on longer words and a fixed alias table for greetings (hey/hi/hay), and
returns whatever follows the phrase so "Hey CLAP, what's on today" is one turn.
Because "clap" is an ordinary English word, the name alone does not wake CLAP.

---

## 6. Agent runtime

One Agent SDK `query()` per session in streaming-input mode:

| Option | Value | Why |
|---|---|---|
| `model` | `CLAP_MODEL` (default `claude-opus-5`) | Explicit, never inherited from user settings. |
| `effort` | `CLAP_EFFORT` (default `medium`) | Spoken answers are latency-sensitive. |
| `systemPrompt` | `clap-personality.md` + tool guidance | Static, so it caches. |
| `tools` | `['WebSearch']` (configurable) | No unscoped built-ins. |
| `disallowedTools` | Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch, … | Belt and braces. |
| `mcpServers` | `{ clap: <in-process server> }` | CLAP's registry. |
| `strictMcpConfig` | `true` | Ignore user/project MCP config. |
| `settingSources` | `[]` | User settings cannot loosen the policy. |
| `permissionMode` | `'default'` | Never `bypassPermissions`. |
| `hooks.PreToolUse` | the permission gate | Fires for every tool call. |
| `hooks.PostToolUse(Failure)` | tool events + logs | |
| `canUseTool` | fail-closed fallback | Allows only calls the gate already approved. |
| `includePartialMessages` | `true` | Speech starts on the first sentence. |
| `persistSession` | `false` by default | No transcripts written to disk unless opted in. |
| `env` | process env minus CLAP-owned secrets | The agent subprocess never sees the ElevenLabs key. |

Stream translation: `stream_event` text deltas → `assistant_text`; the gate's
allow decision → `tool_start`; `PostToolUse` → `tool_result`;
`PostToolUseFailure` or a denial → `tool_error`; `result` → `turn_complete`
(or `error` for real failures; an interrupted turn is reported as
`turn_complete{interrupted:true}`, not as an error). If the SDK stream dies the
session is marked broken, the HUD gets a recoverable `error`, and a new agent
session is created on the next message.

---

## 7. Tools and the permission model

### Tool metadata

Every tool is registered with:

```ts
{
  name: 'web_fetch',                 // model sees mcp__clap__web_fetch
  label: 'Read web page',            // HUD
  description: '…',                  // model-facing guidance
  category: 'web',                   // system|files|web|browser|media|developer|memory|mcp
  inputSchema: { url: z.string().url() },
  risk: 'low',                       // low | medium | high
  requiresConfirmation: false,
  summarize: (input) => `Reading ${host(input.url)}`,
  timeoutMs: 15000,
  handler: async (input, ctx) => ({ text: '…' }),
}
```

### Decision

For each call the gate computes one of `allow`, `confirm`, `deny`:

1. Not in the registry (and not an allowed built-in) → **deny**.
2. Policy for the tool's risk is `deny` → **deny**.
3. Risk is `high` → **confirm** (cannot be configured to `allow`).
4. `requiresConfirmation` → **confirm**.
5. Policy for the risk is `confirm` → **confirm**.
6. Otherwise → **allow**.

Default policy: `low=allow`, `medium=allow` (per-tool confirmation flags still
apply), `high=confirm`. Set with `CLAP_POLICY_MEDIUM` (`allow|confirm|deny`) and
`CLAP_POLICY_HIGH` (`confirm|deny`).

### Confirmation broker

A `confirm` decision creates a pending request with a random id, bound to the
session and turn, expiring after `CLAP_CONFIRM_TIMEOUT_S` (default 45 s). The
bridge sends `confirmation_request`; the HUD shows a card and speaks a short
prompt ("Delete three files in Downloads — confirm?"); the user answers by voice
("yes", "confirm", "do it" / "no", "cancel"), click, or key. Only a matching
`confirmation_response` from the **same session** approves it, once. Timeout,
interrupt, disconnect, or any mismatch resolves to **deny**. The decision is
awaited inside the `PreToolUse` hook, so the tool never starts until the bridge
has an answer.

Defence in depth: CLAP tool handlers re-validate input with their zod schema and
re-check the static policy before running; tool failures are returned as
`isError` results (never thrown into the SDK); every decision and execution is
logged.

### Phase-1 tools

| Tool | Risk | Notes |
|---|---|---|
| `get_time` | low | Local date, time and time zone. |
| `system_info` | low | OS, uptime, memory, load, CPU. |
| `web_fetch` | low | SSRF-guarded GET, 2 MB cap, HTML reduced to text. |
| `WebSearch` (built-in) | low | Server-side search via Claude Code. |

Later phases add files, browser, media, developer and memory tools and
external MCP servers; each lands with its risk metadata and tests.

---

## 8. Security

| Measure | Where |
|---|---|
| Bind `127.0.0.1` by default | `bridge/server.ts` |
| `Host` header must be an allowed loopback name (DNS-rebinding defence) | `security/http-guard.ts` |
| Exact `Origin` allowlist for WS and HTTP; no-Origin sockets refused unless `CLAP_ALLOW_NO_ORIGIN=1`; CORS reflects only allowlisted origins (never `*` or `null`) | `security/http-guard.ts` |
| WS path fixed to `/ws`; 64 KiB message cap; per-connection token bucket | `connection.ts` |
| zod validation of every inbound message and tool input | `shared/protocol.ts`, `tools/registry.ts` |
| SSRF: scheme allowlist, blocked private/loopback/link-local/CGNAT/metadata ranges (v4, v4-embedding v6 forms; other v6 only in global unicast 2000::/3), single DNS resolution per connection, manual redirect vetting, byte caps after decompression, timeouts | `security/ssrf.ts` |
| Path containment with realpath resolution; new paths need a real parent in a root, dangling symlinks refused | `security/paths.ts` |
| Default-deny tool gate in `PreToolUse`; unscoped built-ins disabled; `settingSources: []`; `strictMcpConfig` | `permissions.ts`, `agent/runtime.ts` |
| Brokered single-use confirmations for HIGH risk | `permissions.ts` |
| Secrets only in bridge env; stripped from the agent subprocess env; never logged | `config.ts`, `logger.ts` |
| Model text rendered as plain text (React escaping); control characters stripped | `src/lib/text.ts` |
| Strict CSP generated per mode (`script-src 'self'` in production) | `vite.config.ts` |
| Graceful shutdown closes sockets, sessions and child processes | `server.ts`, `scripts/start.ts` |

See `docs/security.md` for the threat model.

---

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Claude unreachable / not logged in | `error{code:'agent_unavailable'}` with a fix ("run `claude` and log in"); session recreated on next message. |
| Bridge restart | HUD enters `OFFLINE`, reconnects with backoff (0.5 s → 10 s, forever), resumes the session if it still exists, otherwise says the context was reset. |
| Microphone denied | Voice disabled with a clear message; text input remains; state `IDLE`. |
| STT failure | Falls back to the other provider, then to push-to-talk/text; one message, no crash. |
| TTS failure | Falls back to the browser voice, then to text-only. |
| Tool failure / invalid input | `isError` result with a plain sentence; the model reports it honestly. |
| Tool timeout | Aborted after `timeoutMs`; reported as an error. |
| MCP server failure | Reported in diagnostics; its tools are unavailable; the rest works. |
| Network failure in a tool | Typed error from the guarded fetch. |
| Malformed model output | Tool input validated by schema; spoken text passed through a speakable filter. |
| Malformed client message | `error{code:'bad_message'}`; socket stays open. |

---

## 10. Logging

`bridge/logger.ts` writes one JSON object per line (or a readable single-line
format when stdout is a TTY) with: `ts`, `level`, `component`, `event`,
`sessionId`, `turnId`, `tool`, `ok`, `durationMs`, and event-specific fields.
Keys that look like credentials (`key`, `token`, `secret`, `authorization`,
`cookie`, `password`) and strings that look like keys are redacted. Audio is
logged only as byte counts. `CLAP_DEBUG=1` enables debug-level logs, including
SDK stderr. The HUD has a diagnostics panel (`D`) instead of console noise.

---

## 11. Configuration

All configuration is environment-based; see `.env.example`. Bridge variables are
read by `bridge/config.ts` and validated at startup (bad values fail with a
message naming the variable). Frontend variables are `VITE_CLAP_*` and are never
secret. The wake phrase, capabilities and model are delivered to the HUD by the
bridge rather than duplicated in frontend config.
