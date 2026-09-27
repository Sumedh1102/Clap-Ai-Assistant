/**
 * The HUD end-to-end harness: the real bridge and the real Vite dev server,
 * with a scripted agent standing in for Claude so tests are fast, free and
 * deterministic. Everything between the browser and the SDK boundary — the
 * protocol, sessions, the permission gate, confirmations, interrupts — is the
 * production code.
 *
 *   tsx e2e/serve.ts        (Playwright starts it; see playwright.config.ts)
 *
 * The scripted agent:
 *   "…delete…"  asks to run a high-risk tool (a confirmation), then reports
 *   "…story…"   streams a long answer, one sentence at a time, until interrupted
 *   anything else  "Heard: <text>. That makes <n> this session."
 */

import { resolve } from 'node:path'
import { z } from 'zod'
import { CLAP_VERSION, PROTOCOL_VERSION } from '../shared/defaults'
import { AgentSession } from '../bridge/agent/runtime'
import { createBridge } from '../bridge/app'
import { parseConfig, voiceCapabilities } from '../bridge/config'
import { createLogger } from '../bridge/logger'
import { ConfirmationBroker, PermissionGate } from '../bridge/permissions'
import { SessionRegistry } from '../bridge/sessions'
import { CLAP_PROVENANCE, FakeSdk, frame, type FakeQuery } from '../bridge/testing/fake-sdk'
import { createToolRegistry } from '../bridge/tools'
import { defineTool, sdkToolName } from '../bridge/tools/registry'
import { E2E_BRIDGE_PORT, E2E_UI_PORT } from './ports'

const ROOT = resolve(import.meta.dirname, '..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Answer every message the session sends, like a (very predictable) model. */
async function drive(query: FakeQuery): Promise<void> {
  let asked = 0
  let tool = 0
  while (!query.closed) {
    const user = await query.nextUser(1_000)
    if (!user) continue
    asked++
    const text = String(user.message.content)
    const uuid = user.uuid
    const interrupts = query.interrupts
    const interrupted = () => query.interrupts !== interrupts

    await sleep(150)
    if (/delete/i.test(text)) {
      const id = `toolu_e2e_${++tool}`
      const decision = await query.preToolUse(sdkToolName('delete_files'), { count: 3 }, id, CLAP_PROVENANCE)
      const allowed = JSON.stringify(decision).includes('"allow"')
      if (allowed) await query.postToolUse(sdkToolName('delete_files'), id)
      query.send(frame.text(allowed ? 'Deleted them.' : 'Left them alone.', uuid), frame.result(uuid))
      continue
    }
    if (/story/i.test(text)) {
      for (let i = 1; i <= 40 && !interrupted(); i++) {
        query.send(frame.text(`Sentence ${i} of the story. `, i === 1 ? uuid : undefined))
        await sleep(250)
      }
      query.send(frame.result(uuid, interrupted() ? { subtype: 'error_during_execution' } : {}))
      continue
    }
    query.send(frame.text('Heard: ', uuid), frame.text(`${text}. `), frame.text(`That makes ${asked} this session.`), frame.result(uuid))
  }
}

async function main(): Promise<void> {
  process.env.CLAP_BRIDGE_PORT = String(E2E_BRIDGE_PORT)
  process.env.CLAP_UI_PORT = String(E2E_UI_PORT)
  const config = parseConfig({ ...process.env, CLAP_LOG_FORMAT: 'json', CLAP_CONFIRM_TIMEOUT_S: '30' })
  const logger = createLogger({ level: 'error', format: 'json' }, { component: 'e2e-bridge' })
  const registry = createToolRegistry(config).register(
    defineTool({
      name: 'delete_files',
      label: 'Delete files',
      description: 'Delete files (end-to-end test tool).',
      category: 'files',
      risk: 'high',
      inputSchema: { count: z.number() },
      summarize: ({ count }) => `Delete ${count} files in Downloads`,
      handler: async () => ({ text: 'deleted' }),
    }),
  )
  const broker = new ConfirmationBroker({ timeoutMs: config.confirmTimeoutMs })
  const sdk = new FakeSdk((query) => void drive(query))
  const sessions = new SessionRegistry({
    create: () =>
      new AgentSession({
        config,
        registry,
        gate: new PermissionGate(registry, config.policy),
        broker,
        logger,
        systemPrompt: 'e2e',
        queryFn: sdk.queryFn,
        settleCapMs: 1_000,
      }),
    graceMs: config.sessionGraceMs,
    logger,
  })
  const bridge = createBridge({
    config,
    logger,
    sessions,
    broker,
    voice: null,
    describe: () => ({
      protocol: PROTOCOL_VERSION,
      bridgeVersion: CLAP_VERSION,
      model: 'scripted-agent',
      capabilities: voiceCapabilities(config),
      tools: registry.list(),
      wakePhrase: config.wakePhrase,
      policy: config.policy,
    }),
  })
  await bridge.listen()

  const { createServer } = await import('vite')
  const vite = await createServer({ root: ROOT, configFile: resolve(ROOT, 'vite.config.ts'), logLevel: 'warn' })
  await vite.listen()
  process.stdout.write(`e2e harness ready: HUD http://127.0.0.1:${E2E_UI_PORT}, bridge :${E2E_BRIDGE_PORT}\n`)

  const stop = async () => {
    await Promise.allSettled([vite.close(), bridge.close()])
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

void main()
