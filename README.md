# CLAP

A voice-first personal assistant. Say "hey clap", ask something, and CLAP
answers out loud while a 3D core on screen shows what it is doing — listening,
thinking, using a tool, speaking. Talk over it and it stops to listen.

```
browser HUD (React + Three.js)  ──WebSocket──  local bridge (Node)  ──  Claude (Agent SDK)
  wake word, VAD, speech in/out                  permissions, tools,
  the state machine and the scene                secrets, sessions, logs
```

The browser only listens, speaks and draws. Everything that matters — which
tools may run, confirmations, API keys — lives in the bridge on your machine,
bound to `127.0.0.1`.

## Status

Phases 1 and 2 of the [roadmap](docs/implementation-roadmap.md) are done: a
streamed Claude conversation by text or voice, with barge-in, a wake phrase,
push-to-talk and a confirmation flow. The tools so far only read: the clock,
system status, reading a web page, and web search. Files, the browser,
applications, memory and a custom voice are later phases.

## Requirements

- **Node.js 20.11+**
- **Chrome or Edge** for the full voice experience. On-device wake detection
  needs their on-device speech recognition; other browsers fall back to the
  browser's cloud recogniser or push-to-talk.
- **A Claude account.** CLAP runs Claude Code through the Claude Agent SDK
  (installed with `npm install`). Log in once, or set `ANTHROPIC_API_KEY`.
- Optional: an **ElevenLabs** API key for cloud voice and transcription.

## Quick start

```bash
npm install
npm run setup     # creates .env.local, checks everything, says what to fix
npm start         # starts the bridge and the HUD, opens the browser
```

In the HUD, click **Activate voice** (the browser asks for the microphone),
then say **"hey clap, what time is it?"**. Or press **Space** and talk, or just
type.

| Key | Action |
|---|---|
| Space | Talk now (push-to-talk); also interrupts CLAP |
| Esc | Cancel: stop talking and stand down |
| Y / N | Approve / decline a confirmation |
| M | Microphone on/off |
| / | Type a message |
| H | Conversation history |
| D | Diagnostics (engines, levels, state) |
| V | Next browser voice |

Saying "stop" quiets CLAP and keeps listening; "never mind" stands it down.

## Configuration

Settings live in `.env.local`; [`.env.example`](.env.example) lists every one
with its default, and none is required. The ones people change most:

| Variable | Default | |
|---|---|---|
| `CLAP_MODEL` | `claude-opus-5` | Claude model |
| `CLAP_EFFORT` | `medium` | `low` … `max` |
| `CLAP_WAKE_PHRASE` | `hey clap` | Two to five words |
| `CLAP_POLICY_MEDIUM` | `allow` | `allow`, `confirm` or `deny` medium-risk actions |
| `CLAP_POLICY_HIGH` | `confirm` | `confirm` or `deny`; never `allow` |
| `ELEVENLABS_API_KEY` | — | Cloud voice and transcription |
| `CLAP_VOICE_ID` | — | CLAP's voice, Dominic — set by `npm run voice:find` ([docs/voice.md](docs/voice.md)) |

Bad values stop the bridge with a message naming the variable;
`npm run doctor` lists them all.

## How it keeps you safe

- **The bridge decides, the page only asks.** Every tool call passes a
  permission gate in the bridge before it runs, and is checked again when it
  executes. Tools are labelled low, medium or high risk; high risk always needs
  your confirmation, and the policy cannot be set to allow it silently.
- **Confirmations are brokered.** Each has a random id, belongs to one
  session, can be answered once, and counts as "no" on timeout, interrupt or
  disconnect. By voice only a whole-utterance "yes" approves, and CLAP's own
  question is worded so an echo of it cannot approve itself.
- **Only the HUD can connect.** The bridge listens on loopback and accepts only
  its own page's `Origin` and loopback `Host` headers, so other websites and DNS
  rebinding cannot reach it.
- **No shell, no file writes, no arbitrary fetches.** Claude Code's built-in
  Bash, Write, Edit and WebFetch are disabled. CLAP's web reader refuses private
  and local addresses, re-checks every redirect, and caps size and time.
- **Secrets stay on the bridge.** No key is ever sent to the browser (the build
  refuses secret-looking `VITE_*` variables), the ElevenLabs key is withheld
  from the Claude Code subprocess, and logs are redacted.

## Voice

CLAP's voice is **Dominic** from the ElevenLabs Voice Library: British, low,
intense. With an ElevenLabs key in `.env.local`:

```bash
npm run voice:find -- dominic --use 1   # adds Dominic and sets CLAP_VOICE_ID
```

Without a key CLAP uses the browser's own voice and speech recognition,
preferring a British male voice. [docs/voice.md](docs/voice.md) has the
details, voice tuning, and how to make a custom voice instead
(`npm run voice:inspect -- sample.wav` judges a recording).

## Development

```bash
npm run bridge      # bridge only, on 127.0.0.1:7719
npm run dev         # HUD only, on http://localhost:5173
npm run doctor      # check everything, change nothing
npm run typecheck
npm run lint
npm test            # unit and integration tests (Vitest)
npm run test:e2e    # the HUD in Chromium against the bridge, with a scripted agent
npm run build       # typecheck + production build
```

A quicker, cheaper model for manual testing:
`CLAP_MODEL=claude-sonnet-5 CLAP_EFFORT=low npm start`. `CLAP_DEBUG=1` adds
Claude Code's own output to the bridge logs; `VITE_CLAP_DEBUG=1` logs every
protocol frame in the browser console.

Code map: `shared/` is the WebSocket protocol both sides validate against;
`bridge/` is the Node process (agent runtime, tools, permissions, security);
`src/` is the HUD (voice state machine, controller, scene). Design documents:

- [Architecture](docs/clap-architecture.md) — protocol, state machine, permission model
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Reference analysis](docs/reference-analysis.md)
- [CLAUDE.md](CLAUDE.md) — orientation for AI coding assistants

## Troubleshooting

Start with `npm run doctor`: it checks Node, Claude Code, your login, the
configuration and both ports, and says how to fix each problem.

- **"Port … already in use"** — another bridge or HUD is running; stop it or
  change `CLAP_BRIDGE_PORT` / `CLAP_UI_PORT`.
- **"Claude Code isn't logged in"** — run the login command the doctor prints,
  or set `ANTHROPIC_API_KEY`.
- **No wake word** — the browser has no usable recogniser; press Space to talk.
  The diagnostics panel (D) shows which engines were chosen and why.
- **Microphone blocked** — allow it in the browser's site settings. Typing
  always works.

## Credits

CLAP's architecture was informed by
[adewaskar/jarvis](https://github.com/adewaskar/jarvis) (MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
