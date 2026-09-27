# CLAP threat model

CLAP turns speech into actions on your computer, driven by a model that reads
untrusted text (web pages, search results). This document says what CLAP
protects, from whom, how, and what is still open. The measures are listed
with their source files in `docs/clap-architecture.md` §8; each one has tests.

## What is protected

- **The machine**: files, applications and settings, as tools for them arrive
  (Phase 4 and later).
- **Credentials**: the Claude login or `ANTHROPIC_API_KEY`, and the ElevenLabs
  key.
- **Privacy**: room audio, conversations, and what is on the local network.
- **Spend**: model and voice API usage.

## Trust boundaries

```
 other web pages ─┐
                  ▼
 browser: HUD page ──(1)── bridge on 127.0.0.1 ──(2)── Claude Code (Agent SDK)
      │                        │                          │
     (4) speech services      (3) tools ──▶ the web, and later files and apps
```

1. **Page ↔ bridge.** Only the HUD may drive the bridge.
2. **Bridge ↔ model.** Model output is untrusted. The bridge decides what runs.
3. **Tools ↔ world.** Every outbound request and file path is vetted.
4. **Browser ↔ speech services.** Audio leaves the machine only when needed.

## Threats and mitigations

**A web page in another tab tries to drive CLAP.** Browsers let any page open a
WebSocket to `127.0.0.1`, so the bridge accepts only the HUD's exact `Origin`
on the socket and on state-changing HTTP calls. CORS headers reflect only
allowlisted origins, never `*` or `null` (a sandboxed frame's origin), so no
other page can read a response either. The HUD's CSP allows scripts only from
its own origin.

**DNS rebinding.** A hostile name re-pointed at `127.0.0.1` is same-origin to
itself and sends no `Origin` on simple requests. Its `Host` header still names
it, and the bridge accepts only loopback names on its own port.

**Prompt injection** (a page the model reads tells it to do something).
- The permission gate runs in the bridge, in the `PreToolUse` hook, keyed on
  the SDK's provenance for each call, not on tool names the model controls.
  `canUseTool` allows only calls that hook approved, and the tool registry
  re-checks policy and input when the tool runs.
- High-risk tools always need confirmation. Confirmations are issued by the
  bridge, belong to one session, can be answered once, and count as "no" on
  timeout, interrupt or disconnect. The text you confirm is the tool's own
  description of the call's arguments (`summarize`), not the model's prose.
- By voice, only a whole-utterance "yes" approves, and the spoken question ends
  in words that cannot approve it if the microphone hears CLAP's own voice.
- Claude Code's own shell, file-writing, fetch and sub-agent tools are
  disabled; project and user settings are not loaded; only CLAP's in-process
  tool server is connected.
- The web reader refuses private, loopback, link-local, CGNAT and metadata
  addresses. IPv6 is allowed only in global unicast, after judging the forms
  that embed an IPv4 address. Names are resolved once, inside the socket, so a
  DNS rebind between check and connect is impossible. Every redirect hop is
  vetted, and size and time are capped. Its description tells the model that
  page text is information, never instructions.
- File tools (Phase 4) resolve symlinks before judging a path. A path about to
  be created must have a real parent inside an allowed root, and a dangling
  symlink is refused.

**Hostile content aimed at the process.** HTML extraction and speech-text
cleanup are linear-time, with tests on pathological input; response bodies are
capped after decompression (a gzip bomb is refused); inbound WebSocket messages
are size-capped, rate-limited and schema-validated.

**Someone on the network.** The bridge binds loopback. Binding elsewhere needs
`CLAP_ALLOW_NON_LOOPBACK=1`, and the configuration check says why that is
dangerous.

**Secret leakage.** Keys live only in the bridge's environment. The build fails
if a `VITE_*` variable looks secret, the ElevenLabs key is removed from the
Claude Code subprocess environment, and logs mask credential-shaped fields and
values and record audio only as byte counts.

**Listening too much.** Wake detection prefers on-device recognition. The
browser's cloud recogniser is used for the wake phrase only if allowed, and
cloud transcription uploads audio only while CLAP is waiting for a command —
never while it waits for the wake phrase.

## Known gaps

- **Local processes can forge `Origin`.** The Origin check stops browsers, not
  a program running as you. Phase 8 adds a per-launch bridge token. Until then,
  anything that can run code as your user can drive CLAP — though it could
  also do the same things directly.
- **The Claude Code subprocess inherits your environment** apart from CLAP's
  own secrets, including `ANTHROPIC_API_KEY`, which it needs.
- **Browser cloud recognition** sends audio to the browser vendor when it is
  the engine in use (the diagnostics panel shows which engine that is).
- **Turn attribution after a stuck interrupt.** If an interrupted turn outlives
  the settle cap, its late frames are dropped once one of them identifies the
  turn. Unstamped frames arriving before that cannot be told apart from the
  next turn's.
- **The ElevenLabs endpoints** have been tested against a mock only (see
  `docs/voice.md`).
