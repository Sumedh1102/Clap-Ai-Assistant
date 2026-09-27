# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CLAP is a voice-first personal assistant: a browser HUD (React + Three.js) talks over a WebSocket to a local Node bridge, which runs a Claude Agent SDK session and owns the tools, the permission model and all secrets. It is architecturally inspired by `adewaskar/jarvis` (MIT) but must not carry its branding, persona, prompts, wake phrase or visuals. Design docs: `docs/clap-architecture.md` (protocol tables, state machine, permission model), `docs/reference-analysis.md`, `docs/implementation-roadmap.md` (keep phase status in sync with reality).

## Commands

```bash
npm run bridge        # bridge on 127.0.0.1:7719 (tsx bridge/server.ts)
npm run dev           # HUD on http://localhost:5173 (Vite, strictPort)
npm run typecheck     # tsc -b over all three projects (no emit)
npm run build         # typecheck + vite build
npm run lint          # oxlint --deny-warnings (warnings fail)
npm test              # vitest run
npx vitest run src/voice/machine.test.ts     # one file
npx vitest run -t "barge-in"                 # tests matching a name
```

Not yet implemented (declared in package.json, files missing): `npm start` / `setup` / `doctor` / `voice:inspect` (`scripts/*.ts`), `.env.example`, README, and all tests. There is no `vitest.config.ts`; Vitest uses `vite.config.ts`.

Quick manual runs: `CLAP_MODEL=claude-sonnet-5 CLAP_EFFORT=low CLAP_LOG_FORMAT=pretty npm run bridge` is faster/cheaper than the default `claude-opus-5`. Any WebSocket client must send `Origin: http://localhost:5173` (no-Origin sockets are refused) and a `hello` message first. `CLAP_DEBUG=1` adds SDK stderr to bridge logs; `VITE_CLAP_DEBUG=1` logs every protocol frame in the browser console; `D` in the HUD opens live diagnostics.

TypeScript is 7.x (native `tsc`). Three projects extend `tsconfig.base.json`: `tsconfig.app.json` (src + shared, DOM), `tsconfig.bridge.json` (bridge + shared + scripts, Node), `tsconfig.node.json` (vite config). Imports are extensionless; the bridge runs through `tsx`, never compiled.

## Architecture

**`shared/protocol.ts` is the contract.** Every client→bridge message and bridge→client event is a zod schema; types are inferred from them and both sides validate inbound traffic (`parseClientMessage` / `parseBridgeEvent`). Changing an event means changing the schema here; bump `PROTOCOL_VERSION` in `shared/defaults.ts` for incompatible changes.

**Bridge request path:** `bridge/server.ts` (wiring) → `app.ts` (HTTP routes + WS upgrade, both behind `security/http-guard.ts` exact Host and Origin checks) → `connection.ts` (per-socket rate limit, validation, `hello` handshake) → `sessions.ts` (sessions outlive sockets for `CLAP_SESSION_GRACE_S`; the HUD resumes via `resumeSessionId` kept in sessionStorage) → `agent/runtime.ts`.

**`agent/runtime.ts` (AgentSession)** wraps one SDK `query()` in streaming-input mode. Invariants that were verified against the live SDK and are easy to break:
- Each user message is stamped with an SDK `uuid`; frames and results are attributed via `user_message_uuid`, falling back to the current turn.
- `interrupt()` returns immediately but the old turn keeps streaming until its `result`; the next message is held until then (capped by `settleCapMs`), otherwise it gets folded into the old turn.
- An interrupted turn ends as `turn_complete{interrupted:true}`, not an `error`.
- SDK options are deliberate: `tools` = registry built-ins only (currently `WebSearch`), `disallowedTools` = `ALWAYS_DISALLOWED_BUILTINS`, `strictMcpConfig: true`, `settingSources: []`, `permissionMode: 'default'`, `persistSession` off, subprocess env without CLAP secrets (`agentEnvironment` in `config.ts`). Never use `bypassPermissions`.

**Permissions are enforced in the bridge, in three layers:** the `PreToolUse` hook calls `PermissionGate.decide` (allow / confirm / deny; trust keyed on `mcp_server.source === 'sdk'`, not on the tool name) and awaits `ConfirmationBroker` for confirmations; `canUseTool` only allows tool-use ids the hook approved; `ToolRegistry.execute` re-validates input and re-checks policy. `tool_start` is emitted from the hook after approval, `tool_result`/`tool_error` from Post hooks. HIGH risk always confirms and `CLAP_POLICY_HIGH` cannot be `allow`.

**Adding a tool:** `defineTool({...})` in `bridge/tools/*.ts` with `risk`, `category`, zod `inputSchema`, a `summarize` (phrased as an action for confirmable tools, e.g. "Delete 3 files in Downloads"), then register it in `bridge/tools/index.ts`. The model sees it as `mcp__clap__<name>`; `tools/mcp.ts` exposes the registry as an in-process MCP server. Throw `ToolFailure` (or `FetchError`/`PathError`) for messages safe to show and speak; anything else becomes a generic sentence. Any outbound HTTP from a tool must go through `security/ssrf.ts` `guardedFetch`; any file access through `security/paths.ts`. HTML parsing in `tools/html.ts` must stay linear-time (hostile input).

**HUD: logic is not in React.** `src/voice/machine.ts` is a pure `transition(context, event) → {context, effects}`; `src/app/controller.ts` is the only place effects run (bridge sends, speech, cues, timers) and it publishes render state to the zustand store (`src/state/store.ts`). Components read the store and call controller actions. The controller is created once in `main.tsx`, outside React, so StrictMode double-mounts can't open duplicate bridge sessions (each spawns a Claude Code process). Within a turn, SPEAKING/EXECUTING/THINKING are derived from `audible`/`toolsRunning`; a turn ends only on `TURN_COMPLETE` plus `SPEECH_DRAINED`.

**Voice pipeline:** `src/voice/input.ts` owns the shared `Microphone` (`src/audio/mic.ts`, AudioWorklet meter in `public/worklets/level-meter.js`), the pure `VadDetector`, the self-restarting Web Speech recogniser, cloud STT via the bridge, wake matching (`wake.ts`), endpointing and echo filtering. The machine's state maps to a recogniser mode (`off`/`wake`/`command`/`guard`). Cloud STT segments are uploaded only if the mode is `command` when the segment ends, so idle room audio never leaves the machine and paid STT never listens for the wake word. Engine choice is the pure `selectEngines` in `capabilities.ts`, with `degrade` in `input.ts` for runtime fallback. Speech output is `VoiceProvider` adapters (`tts/browser.ts`, `tts/bridge.ts`) behind `FallbackVoiceProvider`, driven by the sentence-streaming `Speaker`.

**Confirmation safety (voice):** the mic is live while CLAP speaks the confirmation prompt. `parseConfirmation` accepts only a whole-utterance yes-phrase, and `confirmationPrompt` must never end in anything that is a yes-phrase (the recogniser may catch only the tail of CLAP's own voice). Keep both in `src/voice/intents.ts` consistent when editing.

**3D scene:** `src/hud/visual.ts` maps each assistant state to a target look (pure). In `src/hud/scene/`, `Driver` eases a shared mutable `live` object each frame and reads audio levels from the controller; other components read `live` in `useFrame`. Audio levels never go through React state.

## Configuration and security invariants

- Bridge config is parsed and validated only in `bridge/config.ts` (`parseConfig`), from the environment plus `.env.local`/`.env` (`bridge/env.ts`; real env vars win). Frontend options are non-secret `VITE_CLAP_*` in `src/app/config.ts`; wake phrase, model and capabilities come from the bridge's `session_ready`.
- `vite.config.ts` fails the build if any `VITE_*` variable name looks secret, generates the CSP into `index.html` (`%CLAP_CSP%`), injects the bridge URL as `__CLAP_BRIDGE_URL__`, and pins the UI port with `strictPort` because the bridge's allowed origins are derived from `CLAP_UI_PORT`.
- The bridge binds loopback unless `CLAP_ALLOW_NON_LOOPBACK=1`. Model-authored text is rendered as plain text and passed through `src/lib/text.ts` before display or speech.
- ElevenLabs endpoints in `bridge/voice/elevenlabs.ts` could not be verified from the development environment (egress blocked); model ids are configurable (`CLAP_TTS_MODEL`, `CLAP_STT_MODEL`).
