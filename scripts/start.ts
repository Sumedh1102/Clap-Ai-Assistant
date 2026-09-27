/**
 * npm start — run CLAP: checks, then the bridge, then the HUD, then the browser.
 *
 *   1. Preflight (Node, Claude Code, authentication, configuration, ports).
 *   2. Start the bridge and wait for GET /health.
 *   3. Start Vite on CLAP_UI_PORT (strictPort), so the page origin is exactly
 *      the one the bridge trusts, and wait for it to accept connections.
 *   4. Open the browser unless CLAP_OPEN_BROWSER=0, and print a status block.
 *   5. Supervise: a bridge that exits with code 70 (it stops itself after an
 *      uncaught exception) is restarted, a few times at most; any other exit
 *      of either process stops both. Ctrl-C stops both.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { BridgeConfig } from '../bridge/config'
import { bridgeHealth, collectChecks, failed, formatChecks, loadEnv, ROOT, type Health } from './lib/checks'

/** The bridge exits with this after an uncaught exception, asking to be restarted. */
export const RESTART_CODE = 70
export const RESTART_LIMIT = { count: 3, windowMs: 60_000 }

/** May a bridge that exited with `code` at `now` be restarted, given earlier restarts? */
export function shouldRestart(code: number | null, restarts: number[], now: number): boolean {
  if (code !== RESTART_CODE) return false
  return restarts.filter((t) => now - t < RESTART_LIMIT.windowMs).length < RESTART_LIMIT.count
}

const tty = Boolean(process.stdout.isTTY)
const paint = (code: number, text: string) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text)

function pipeLines(child: ChildProcess, label: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => process.stdout.write(`${label} ${line}\n`))
  }
}

function startBridge(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'bridge/server.ts')], {
    cwd: ROOT,
    env: { ...process.env, CLAP_LOG_FORMAT: process.env.CLAP_LOG_FORMAT ?? (tty ? 'pretty' : 'json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLines(child, paint(36, 'bridge'))
  return child
}

function startHud(): ChildProcess {
  const require = createRequire(resolve(ROOT, 'package.json'))
  const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js')
  const child = spawn(process.execPath, [vite], {
    cwd: ROOT,
    env: { ...process.env, ...(tty ? { FORCE_COLOR: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLines(child, paint(35, 'hud   '))
  return child
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** Poll until `probe` succeeds, `child` exits, or the deadline passes. */
async function waitFor<T>(probe: () => Promise<T | null>, child: ChildProcess, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const result = await probe()
    if (result !== null) return result
    await sleep(250)
  }
  return null
}

const accepting = (port: number) =>
  new Promise<true | null>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('error', () => resolvePromise(null))
  })

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => process.stdout.write(`  Open ${url} in Chrome or Edge.\n`))
    child.unref()
  } catch {
    process.stdout.write(`  Open ${url} in Chrome or Edge.\n`)
  }
}

function statusBlock(config: BridgeConfig, health: Health, url: string): string {
  return [
    '',
    `  ${paint(1, 'CLAP is running')}`,
    `    HUD      ${url}`,
    `    Bridge   http://${config.host}:${config.port}  (model ${health.model ?? config.model})`,
    `    Wake     say "${health.wakePhrase ?? config.wakePhrase}", or press Space to talk`,
    '    Stop     Ctrl-C',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  loadEnv()
  const { checks, config } = await collectChecks('start')
  if (failed(checks) || !config) {
    process.stdout.write(`\nCLAP cannot start:\n\n${formatChecks(checks)}\n\n`)
    process.exit(1)
  }
  for (const check of checks.filter((c) => c.status === 'warn')) {
    process.stdout.write(`${formatChecks([check])}\n`)
  }

  let stopping = false
  let bridge = startBridge()
  let hud: ChildProcess | null = null
  const restarts: number[] = []

  const stop = (code: number) => {
    if (stopping) return
    stopping = true
    const children = [bridge, hud].filter((c): c is ChildProcess => c !== null && c.exitCode === null && c.signalCode === null)
    for (const child of children) child.kill('SIGTERM')
    const force = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL')
      process.exit(code)
    }, 5_000)
    force.unref()
    void Promise.all(children.map((c) => new Promise((r) => c.once('exit', r)))).then(() => process.exit(code))
    if (!children.length) process.exit(code)
  }

  const superviseBridge = (child: ChildProcess) => {
    child.once('exit', (code, signal) => {
      if (stopping) return
      if (shouldRestart(code, restarts, Date.now())) {
        restarts.push(Date.now())
        process.stdout.write(`${paint(33, 'start ')} the bridge stopped after an error; restarting it (the HUD reconnects)\n`)
        bridge = startBridge()
        superviseBridge(bridge)
        return
      }
      process.stdout.write(`${paint(33, 'start ')} the bridge exited (${signal ?? `code ${code}`}); stopping CLAP\n`)
      stop(code ?? 1)
    })
  }
  superviseBridge(bridge)

  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  const health = await waitFor(() => bridgeHealth(config, 1_000), bridge, 20_000)
  if (!health) {
    process.stdout.write(`${paint(31, 'start ')} the bridge did not become healthy; see its output above\n`)
    stop(1)
    return
  }

  hud = startHud()
  hud.once('exit', (code, signal) => {
    if (stopping) return
    process.stdout.write(`${paint(33, 'start ')} the HUD exited (${signal ?? `code ${code}`}); stopping CLAP\n`)
    stop(code ?? 1)
  })
  if (!(await waitFor(() => accepting(config.uiPort), hud, 30_000))) {
    process.stdout.write(`${paint(31, 'start ')} the HUD did not start; see its output above\n`)
    stop(1)
    return
  }

  const url = `http://localhost:${config.uiPort}`
  process.stdout.write(statusBlock(config, health, url))
  if (!['0', 'false', 'no', 'off'].includes((process.env.CLAP_OPEN_BROWSER ?? '').trim().toLowerCase())) openBrowser(url)
}

// Run only when executed, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, 'scripts/start.ts')) void main()
