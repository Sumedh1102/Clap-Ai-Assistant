# Reference analysis: `adewaskar/jarvis`

This is a study of <https://github.com/adewaskar/jarvis> (MIT, © 2026 Aditya
Dewaskar), used strictly as an architectural reference for CLAP. It records
what the project does, what CLAP takes from it, what CLAP changes, and what
CLAP leaves behind. Commit studied: the default branch as of 2026-09-27.

The claims below come from reading the source and from live probes of the
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.3.283`) and Chromium 141
run while writing this document. They are not taken from the README alone.

---

## 1. What the reference project does

A voice assistant split into two processes:

| Process | Files | Role |
|---|---|---|
| **Face** (browser) | `src/` — React 19, Vite, Three.js via React Three Fiber, zustand | Wake word, voice activity detection, speech to text, text to speech, the HUD |
| **Brain** (Node) | `bridge/server.mjs` + in-process MCP servers (`panels.mjs`, `ui.mjs`, `chrome.mjs`, `vision.mjs`) | Runs the Claude Agent SDK (Claude Code as a library), gates tools, proxies speech and media |

They talk over one WebSocket on `ws://localhost:8787` plus a few HTTP endpoints
(`/health`, `/tts`, `/stt`, `/file`, `/img`, `/media`, `/page`).

**Startup.** `npm start` (`scripts/start.mjs`) spawns the bridge and Vite
together, labels their logs, and kills both if either exits. `npm run setup`
(`scripts/setup.mjs`) is an advisory preflight: Node version, `claude` on PATH,
MCP servers in `~/.claude.json`, and whether an ElevenLabs key exists.

**Agent.** One `query()` per WebSocket connection, fed by an async generator of
user messages (streaming-input mode), so the whole conversation lives in that
agent session. Key options: a custom `systemPrompt` (not the `claude_code`
preset), `settingSources: []`, explicit `model`/`effort`, `maxTurns: 24`,
`includePartialMessages: true`, and a `canUseTool` callback. Every MCP server
in `~/.claude.json` is passed in explicitly, plus four in-process servers built
with `createSdkMcpServer`.

**Turn protocol.** The browser sends `{type:'ask', text, id}`; the bridge tags
every frame with the `ask` id so the client can ignore the tail of an abandoned
answer. Frames: `ready`, `text` (delta), `tool`, `done`, `error`, `panel`,
`blade`, `ui`, `capture` (request/reply for camera frames).

**Voice pipeline** (`src/lib/voice.ts`, `vad.ts`, `tts.ts`, `capabilities.ts`):
- An energy VAD with an adaptive noise floor, hysteresis and a "guard" mode that
  raises the threshold while the assistant speaks, so its own playback does not
  trigger barge-in.
- Two STT tiers picked once at boot from `GET /health`: ElevenLabs Scribe via
  the bridge (VAD segments uploaded as audio blobs), or the browser's
  `SpeechRecognition` with a heartbeat that restarts it when Chrome silently
  stops it.
- The wake word is detected **in the transcript**: a regex over "jarvis" and
  its common mis-hearings.
- An utterance "assembler" merges transcript segments so a mid-sentence pause
  does not end the turn (trailing function words or commas extend the hold).
- A text-level echo filter drops transcripts that match what the assistant is
  currently saying, with override words ("stop", "wait") that always cut through.
- TTS is sentence-streamed: text is cut at sentence boundaries while it streams
  and spoken one sentence at a time through an explicit queue (not a promise
  chain, so it can be cancelled). Engines: ElevenLabs via bridge `/tts`,
  browser `speechSynthesis`, or Kokoro (in-browser ONNX). Robustness work
  around `speechSynthesis`: `resume()` before every utterance, a keep-alive
  pause/resume, and a start watchdog.

**Tools.** Beyond configured MCP servers the model gets HUD panels, "blades"
(large reading surfaces), UI theming tools, the user's own Chrome via the
Claude-for-Chrome native-messaging socket, and camera frames.

---

## 2. Architectural ideas CLAP adopts

1. **Browser face + local Node bridge + Agent SDK brain.** The browser cannot
   spawn stdio MCP servers or hold secrets; a local bridge can, and the Agent
   SDK reuses the user's Claude Code login (no API key in the browser).
2. **One agent session per connection, fed by an async generator**
   (streaming-input mode), so conversational context is kept by the SDK.
3. **`settingSources: []`** so `~/.claude/settings.json` allow-rules or a
   global `bypassPermissions` cannot override the bridge's policy, and a
   coding-agent `CLAUDE.md` does not leak into a voice persona.
4. **Turn ids on every frame**, and **serialising turns after an interrupt**:
   the next message is delivered only after the interrupted turn's `result`
   (with a cap). Verified in a probe: `interrupt()` resolves in ~2 ms, but
   deltas keep arriving until a `result` with subtype `error_during_execution`.
5. **Origin allowlist on the WebSocket handshake** (a WebSocket is not covered
   by the same-origin policy), and refusing clients with no `Origin` by default.
6. **The SSRF gate design** in `bridge/net.mjs`: vet scheme and host, block
   private/loopback/link-local/CGNAT/metadata ranges including IPv4-mapped IPv6,
   resolve DNS once in a custom `lookup` so a rebind cannot swap the address,
   and re-vet every redirect hop by hand. CLAP re-implements this in TypeScript.
7. **Local energy VAD for barge-in** (instant and cannot silently die), the
   guard threshold while speaking, a short self-guard window at the start of
   each spoken sentence, and a text-level echo filter as the last backstop.
8. **Utterance endpointing on words, not just silence** (hold longer when the
   transcript ends in "and", "the", a comma, …).
9. **Sentence-streamed TTS through a cancellable array queue**, priming one
   sentence ahead, plus the `speechSynthesis` survival kit.
10. **Capability detection from a bridge health endpoint**, so premium
    STT/TTS switch on automatically when a key exists and fall back silently
    when it does not.
11. **Keeping provider keys on the bridge**: the browser POSTs text to `/tts`
    and audio to `/stt`, and never sees the key.
12. **Structured failure messages written to be spoken** ("The turn ran too
    long and was stopped"), never raw stack traces.

---

## 3. What CLAP redesigns

| Area | Reference | CLAP |
|---|---|---|
| **Permission model** | A boolean `decideTool()` using verb regexes over tool names plus one global `JARVIS_ALLOW_WRITES` switch. No confirmation (it argues voice is a poor confirmation interface). | Every tool is registered with metadata: `name`, `description`, `inputSchema`, `risk` (LOW/MEDIUM/HIGH), `requiresConfirmation`. The bridge enforces a per-risk policy; HIGH always needs an explicit confirmation that is **brokered by the bridge** (single-use id, bound to the session, expires, default-deny on timeout). The UI only relays yes/no. |
| **Where the gate sits** | `canUseTool`, which the README itself notes is not called for tool calls the CLI's own classifier already allowed. | A **`PreToolUse` hook**, which the probe confirmed fires for every tool call and carries trusted `mcp_server.source` provenance (`sdk` for in-process servers). `canUseTool` remains as a fail-closed fallback, and each CLAP tool handler re-checks policy and re-validates input. |
| **Built-in tools** | The full Claude Code toolset (Bash, Write, Edit, …), gated by name. | `tools: []` plus an explicit allowlist (`WebSearch` by default); Bash/Write/Edit/WebFetch are also listed in `disallowedTools`. CLAP ships its own scoped tools (e.g. an SSRF-guarded `web_fetch`) instead of the unscoped built-ins. `strictMcpConfig: true` so only servers CLAP passes are loaded. |
| **Wake word** | Detected in STT transcripts. With an ElevenLabs key, **every VAD segment in the room is uploaded to Scribe while dormant** — continuous paid cloud requests just to hear a name. | A `WakeWordEngine` abstraction that prefers **local** detection: Chrome's on-device `SpeechRecognition` (`processLocally`, present in Chromium 141) first; browser cloud recognition only as a clearly-labelled fallback that can be disabled; push-to-talk always available. Paid STT is used only for the command after the wake phrase. The phrase is configurable (`CLAP_WAKE_PHRASE`) and matched by a tested, fuzzy phrase matcher rather than a hard-coded regex of mis-hearings. |
| **Conversation orchestration** | A ~700-line `App.tsx` holding the phase logic, timers and turn counters inside a React component. | A **pure, unit-tested voice state machine** (`src/voice/machine.ts`) and a non-React controller that runs effects. React only renders state. |
| **Protocol** | Loosely-typed frames (`type Frame = {type?: string, delta?: string, …}`), JSON parsed ad hoc on each side. | A shared, versioned protocol module (`shared/protocol.ts`) with zod schemas validated on both ends; malformed or oversized messages are rejected with a typed `error` event. |
| **Tool announcements** | Tools announced from stream events, with a "held tools" map because the verdict was not known yet. | `tool_start` is emitted from the `PreToolUse` hook **after** the decision, and `tool_result`/`tool_error` from `PostToolUse`/`PostToolUseFailure`, so the HUD never shows work that did not happen. |
| **Bridge exposure** | `server.listen(PORT)` binds all interfaces; dev origins accepted by port range (5173–5199, 4173–4199). | Binds **127.0.0.1** by default; exact origin allowlist; **`Host` header validation** to defeat DNS rebinding; per-connection rate limit and message size cap. |
| **Session lifetime** | The socket is the session; a dropped socket loses all context. | Sessions get an id; after a disconnect the agent session is kept for a grace period and a reconnecting page can resume it. |
| **Logging** | `console.log` strings. | Structured JSON logs (timestamp, session id, turn id, component, event, ok, duration, tool) with secret redaction and no raw audio. |
| **Personality** | Embedded in `server.mjs`, duplicated in `config.ts`. | One file, `bridge/agent/clap-personality.md`, loaded by the agent runtime. |
| **TTS/STT providers** | Engine choice spread through `tts.ts`/`voice.ts` with ElevenLabs specifics inline. | `VoiceProvider` and `SpeechProvider` interfaces with adapters (browser, bridge-proxied cloud) and a fallback chain; the UI never mentions a provider by name except in diagnostics. |

---

## 4. What CLAP deliberately does not copy

- **Branding, persona and identity**: the JARVIS name, "Hey Jarvis", the Iron
  Man arc-reactor visuals, the boot sequence, the "sir" butler register, the
  prompts, the bundled boot music and sound design.
- **The browser-direct backend** (`VITE_BACKEND=direct`) and every `VITE_*`
  secret (`VITE_ANTHROPIC_API_KEY`, `VITE_ELEVENLABS_API_KEY`, MCP tokens).
  Vite inlines these into the JavaScript bundle; CLAP never ships a secret to
  the browser.
- **Reading secrets out of `~/.claude.json`** (the reference borrows the
  ElevenLabs key from the elevenlabs MCP server config). CLAP reads its own
  environment only.
- **Driving the user's signed-in Chrome through the Claude-for-Chrome native
  host socket** (`bridge/chrome.mjs`). It is a private interface, and handing a
  voice agent the user's live sessions is too much authority for an early
  phase. CLAP's browser tools will be added in Phase 4 behind the permission
  model.
- **The page proxy that frames arbitrary sites** (`/page`) and the model-authored
  HTML panel system. CLAP renders model output as plain text until a panel
  system with a strict allowlist is designed.
- **Camera access, hand tracking, clap-to-start and Kokoro** — out of scope for
  the first phases.
- **Verb-regex allow decisions as the primary policy.** Name heuristics are kept
  only to *classify* unknown third-party MCP tools conservatively, never to
  authorise a built-in.

---

## 5. Security considerations

What the reference gets right and CLAP keeps: origin checks on the WebSocket
and HTTP, SSRF-guarded outbound fetches, symlink-resolved path containment for
file reads, content-type allowlists on proxies (no SVG from the bridge origin),
a strict CSP, `settingSources: []`, and body-size caps on `/tts` and `/stt`.

Gaps CLAP closes:

1. **All-interface bind.** The reference listens on every interface; anyone on
   the LAN can reach `/health`, `/tts` and `/stt`. CLAP binds loopback.
2. **DNS rebinding.** A page on `http://attacker.example:8787` that rebinds to
   127.0.0.1 is same-origin to itself, and a same-origin `GET` carries no
   `Origin` header. CLAP rejects any request whose `Host` is not an allowed
   loopback name.
3. **Permission bypass by classifier.** `canUseTool` is not consulted for calls
   the CLI auto-approves (the reference's own comment). CLAP gates in
   `PreToolUse`, disables unscoped built-ins, and re-checks in handlers.
4. **Secrets in the bundle** via `VITE_*` (above).
5. **Unbounded tool authority once writes are on.** One flag unlocked shell,
   file writes and device actions together. CLAP scopes by risk level and by
   per-tool rules (for example, file tools are confined to configured roots).
6. **Secrets in the agent subprocess environment.** CLAP strips its own provider
   keys from the environment passed to the Claude Code subprocess.

---

## 6. Voice architecture — lessons carried over

- Keep one microphone stream (`getUserMedia` with echo cancellation, noise
  suppression, auto gain) and share it; opening it twice makes Chrome drop the
  first.
- The energy VAD is the barge-in trigger; transcripts are too slow for that.
- `SpeechRecognition` dies silently under always-on use; a heartbeat restart is
  required. `speechSynthesis` wedges after `cancel()`; always pair it with
  `resume()`, keep long utterances alive, and watchdog the start event.
- Share one output `AudioContext` (Chrome caps concurrent contexts).
- `HTMLAudioElement.pause()` does not fire `ended`; treat `pause` as finished or
  the queue hangs.
- Probing on-device recognition: `SpeechRecognition.available()` exists in
  Chromium 141 but **never settled** in a headless probe, so CLAP races it
  against a timeout.

## 7. Tool architecture — lessons carried over

- In-process MCP servers (`createSdkMcpServer` + `tool()` with zod shapes) are
  the right way to give the agent host-side capabilities.
- Tool results should be short, plain sentences that are safe to speak.
- Handlers must never throw into the SDK; return `isError` results instead.
- A deny message is likely to be spoken, so it must be a plain sentence.

## 8. Recommended improvements (applied in CLAP's design)

1. Gate in `PreToolUse`, keyed on `mcp_server.source`, not tool-name prefixes.
2. Brokered, single-use, expiring confirmations for HIGH-risk tools.
3. Shared typed protocol with runtime validation.
4. A pure voice state machine with tests; React renders, it does not orchestrate.
5. Local-first wake detection; never send idle room audio to a paid service.
6. Loopback bind, `Host` validation, rate limiting, size caps.
7. Structured, redacted logs with durations and tool names.
8. Session resume across page reloads and short disconnects.
9. A `doctor` command that checks authentication (`claude auth status --json`)
   rather than only the presence of the CLI.

---

### License note

The reference is MIT-licensed. CLAP does not copy its files; where a technique
is re-implemented closely (the SSRF address table, the `speechSynthesis`
workarounds, the endpointing heuristics), the relevant CLAP source files credit
the reference and `THIRD_PARTY_NOTICES.md` carries the MIT notice.
