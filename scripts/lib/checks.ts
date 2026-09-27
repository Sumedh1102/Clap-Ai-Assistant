/**
 * Preflight checks shared by `npm run doctor`, `npm run setup` and `npm start`.
 *
 * Configuration is judged by the bridge's own parser (bridge/config.ts), so a
 * check here can never disagree with what the bridge will actually do.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, parseConfig, voiceCapabilities, type BridgeConfig } from '../../bridge/config'
import { loadEnvFiles } from '../../bridge/env'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export type CheckStatus = 'ok' | 'warn' | 'fail'
export type Check = { name: string; status: CheckStatus; detail: string; fix?: string }

export const MIN_NODE = [20, 11] as const

/** Load `.env.local` then `.env` into process.env, exactly as the bridge does. */
export function loadEnv(): string[] {
  return loadEnvFiles([resolve(ROOT, '.env.local'), resolve(ROOT, '.env')])
}

export function checkNode(version: string = process.versions.node): Check {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  return ok
    ? { name: 'Node.js', status: 'ok', detail: `v${version}` }
    : { name: 'Node.js', status: 'fail', detail: `v${version} is too old`, fix: `Install Node.js ${MIN_NODE.join('.')} or newer.` }
}

/**
 * Where the Agent SDK's bundled Claude Code binary lives, found the way the
 * SDK itself looks for it (a per-platform optional package).
 */
export function findClaudeBinary(platform: string = process.platform, arch: string = process.arch): string | null {
  const require = createRequire(resolve(ROOT, 'package.json'))
  const base = '@anthropic-ai/claude-agent-sdk'
  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const packages = platform === 'linux' ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`]
  for (const name of packages) {
    try {
      const path = resolve(dirname(require.resolve(`${name}/package.json`)), exe)
      if (existsSync(path)) return path
    } catch {
      /* not installed for this platform */
    }
  }
  return null
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function checkClaudeBinary(): Promise<Check & { path: string | null }> {
  const name = 'Claude Code (bundled with the Agent SDK)'
  const path = findClaudeBinary()
  if (!path) {
    return {
      name,
      status: 'fail',
      path,
      detail: `no binary for ${process.platform}-${process.arch}`,
      fix: 'Run npm install. If it still fails, this platform may not be supported by @anthropic-ai/claude-agent-sdk.',
    }
  }
  const version = await run(path, ['--version'])
  if (!version.ok) {
    return { name, status: 'fail', path, detail: `found at ${path} but it does not start`, fix: 'Reinstall with npm ci.' }
  }
  return { name, status: 'ok', path, detail: version.stdout.trim() || path }
}

/** Parse `claude auth status --json`. */
export function parseAuthStatus(stdout: string): { loggedIn: boolean; method: string | null } {
  try {
    const data = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown }
    return { loggedIn: data.loggedIn === true, method: typeof data.authMethod === 'string' ? data.authMethod : null }
  } catch {
    return { loggedIn: false, method: null }
  }
}

export async function checkAuth(binary: string | null, env: NodeJS.ProcessEnv = process.env): Promise<Check> {
  const name = 'Claude authentication'
  if (env.ANTHROPIC_API_KEY?.trim()) return { name, status: 'ok', detail: 'ANTHROPIC_API_KEY is set' }
  if (!binary) return { name, status: 'fail', detail: 'cannot check without Claude Code' }
  const status = await run(binary, ['auth', 'status', '--json'])
  const parsed = parseAuthStatus(status.stdout)
  if (parsed.loggedIn) return { name, status: 'ok', detail: `logged in (${parsed.method ?? 'unknown method'})` }
  return {
    name,
    status: 'fail',
    detail: 'not logged in',
    fix: `Run "${binary}" auth login, or set ANTHROPIC_API_KEY in .env.local.`,
  }
}

export function checkConfig(env: NodeJS.ProcessEnv = process.env): { check: Check; config: BridgeConfig | null } {
  try {
    const config = parseConfig(env)
    return {
      check: { name: 'Configuration', status: 'ok', detail: `model ${config.model}, wake phrase "${config.wakePhrase}"` },
      config,
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return {
      check: {
        name: 'Configuration',
        status: 'fail',
        detail: error.problems.join('\n'),
        fix: 'Fix the variables above in .env.local (see .env.example).',
      },
      config: null,
    }
  }
}

/** True when nothing is listening on host:port. */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.once('error', () => resolvePromise(false))
    probe.listen(port, host, () => probe.close(() => resolvePromise(true)))
  })
}

export async function checkPort(label: string, host: string, port: number, variable: string): Promise<Check> {
  const name = `${label} port ${port}`
  if (await portFree(host, port)) return { name, status: 'ok', detail: 'free' }
  return { name, status: 'fail', detail: 'already in use', fix: `Stop whatever is using it, or set ${variable}.` }
}

export type Health = { ok: boolean; version?: string; model?: string; wakePhrase?: string; sessions?: number }

/** GET /health from a running bridge, or null. */
export async function bridgeHealth(config: Pick<BridgeConfig, 'host' | 'port'>, timeoutMs = 2_000): Promise<Health | null> {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  try {
    const res = await fetch(`http://${host}:${config.port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as Health
  } catch {
    return null
  }
}

export function checkVoice(config: BridgeConfig): Check {
  const caps = voiceCapabilities(config)
  const name = 'Voice'
  if (caps.tts.cloud || caps.stt.cloud) {
    const parts = [
      caps.tts.cloud ? (caps.tts.customVoice ? 'cloud voice (custom)' : 'cloud voice (stock ElevenLabs voice)') : 'browser voice',
      caps.stt.cloud ? 'cloud transcription' : 'browser transcription',
    ]
    return { name, status: 'ok', detail: parts.join(', ') }
  }
  return {
    name,
    status: 'warn',
    detail: 'browser voice and recognition only',
    fix: 'Optional: set ELEVENLABS_API_KEY (and CLAP_VOICE_ID for the custom CLAP voice) in .env.local.',
  }
}

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' }

export function formatChecks(checks: Check[]): string {
  return checks
    .map((check) => {
      const [first = '', ...rest] = check.detail.split('\n')
      const lines = [`  ${MARK[check.status]} ${check.name}: ${first}`, ...rest.map((line) => `      ${line}`)]
      if (check.fix && check.status !== 'ok') lines.push(`      → ${check.fix}`)
      return lines.join('\n')
    })
    .join('\n')
}

export const failed = (checks: Check[]) => checks.some((c) => c.status === 'fail')

/**
 * Everything `doctor` and `start` check. `doctor` is content to find a bridge
 * already running; `start` needs both ports free.
 */
export async function collectChecks(mode: 'doctor' | 'start'): Promise<{
  checks: Check[]
  config: BridgeConfig | null
  health: Health | null
}> {
  const checks: Check[] = [checkNode()]
  const binary = await checkClaudeBinary()
  checks.push(binary, await checkAuth(binary.path))
  const { check, config } = checkConfig()
  checks.push(check)
  if (!config) return { checks, config, health: null }

  const health = await bridgeHealth(config)
  if (health && mode === 'doctor') {
    checks.push({ name: `Bridge port ${config.port}`, status: 'ok', detail: `a CLAP bridge is running (${health.version ?? '?'}, ${health.sessions ?? 0} sessions)` })
  } else if (health) {
    checks.push({
      name: `Bridge port ${config.port}`,
      status: 'fail',
      detail: 'a CLAP bridge is already running',
      fix: 'Stop it first, or run the HUD alone with npm run dev.',
    })
  } else {
    checks.push(await checkPort('Bridge', config.host, config.port, 'CLAP_BRIDGE_PORT'))
  }

  const ui = await checkPort('HUD', '127.0.0.1', config.uiPort, 'CLAP_UI_PORT')
  if (ui.status === 'fail' && mode === 'doctor') {
    checks.push({ ...ui, status: 'warn', detail: 'in use (fine if the CLAP HUD is already running)' })
  } else {
    checks.push(ui)
  }
  checks.push(checkVoice(config))
  return { checks, config, health }
}
