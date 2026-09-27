/**
 * CLAP bridge — entry point.
 *
 *   npm run bridge
 *
 * Loads configuration, builds the tool registry and permission model, and
 * serves the HUD on loopback. Shuts down cleanly on Ctrl-C / SIGTERM.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAP_VERSION, PROTOCOL_VERSION } from '../shared/defaults'
import { buildSystemPrompt } from './agent/prompt'
import { AgentSession } from './agent/runtime'
import { createBridge } from './app'
import { agentEnvironment, ConfigError, parseConfig, secretValues, voiceCapabilities, type BridgeConfig } from './config'
import { loadEnvFiles } from './env'
import { createLogger } from './logger'
import { ConfirmationBroker, PermissionGate } from './permissions'
import { SessionRegistry } from './sessions'
import { createToolRegistry } from './tools'
import { ElevenLabs } from './voice/elevenlabs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function banner(config: BridgeConfig, port: number, logger: ReturnType<typeof createLogger>): void {
  const caps = voiceCapabilities(config)
  logger.info('bridge.listening', { url: `http://${config.host}:${port}`, ws: `ws://${config.host}:${port}/ws` })
  logger.info('bridge.config', {
    model: config.model,
    effort: config.effort,
    wakePhrase: config.wakePhrase,
    policy: `low=${config.policy.low} medium=${config.policy.medium} high=${config.policy.high}`,
    cloudTts: caps.tts.cloud ? (caps.tts.customVoice ? 'elevenlabs (custom voice)' : 'elevenlabs') : 'off — browser voice',
    cloudStt: caps.stt.cloud ? 'elevenlabs' : 'off — browser recognition',
    origins: config.allowedOrigins.join(' '),
  })
}

async function main(): Promise<void> {
  loadEnvFiles([resolve(ROOT, '.env.local'), resolve(ROOT, '.env')])

  let config: BridgeConfig
  try {
    config = parseConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nCLAP bridge cannot start — configuration problems:\n  - ${error.problems.join('\n  - ')}\n\nSee .env.example.\n\n`)
      process.exit(1)
    }
    throw error
  }

  const logger = createLogger(
    { level: config.debug ? 'debug' : 'info', format: config.logFormat, secrets: secretValues(config), stacks: config.debug },
    { component: 'bridge' },
  )

  process.on('unhandledRejection', (error) => logger.error('process.unhandled_rejection', { error }))
  process.on('uncaughtException', (error) => {
    // State may be corrupt after an uncaught exception; exit and let the
    // supervisor (npm start) restart a clean bridge. The HUD reconnects.
    logger.error('process.uncaught_exception', { error })
    process.exit(70)
  })

  const registry = createToolRegistry(config)
  const gate = new PermissionGate(registry, config.policy)
  const broker = new ConfirmationBroker({ timeoutMs: config.confirmTimeoutMs })
  const systemPrompt = buildSystemPrompt(registry.list())
  const agentEnv = agentEnvironment(process.env)
  const voice = config.voice.elevenLabsApiKey ? new ElevenLabs(config.voice) : null
  const capabilities = voiceCapabilities(config)

  const sessions = new SessionRegistry({
    create: () => new AgentSession({ config, registry, gate, broker, logger, systemPrompt, agentEnv }),
    graceMs: config.sessionGraceMs,
    logger,
  })

  const bridge = createBridge({
    config,
    logger,
    sessions,
    broker,
    voice: capabilities.tts.cloud || capabilities.stt.cloud ? voice : null,
    describe: () => ({
      protocol: PROTOCOL_VERSION,
      bridgeVersion: CLAP_VERSION,
      model: config.model,
      capabilities,
      tools: registry.list(),
      wakePhrase: config.wakePhrase,
      policy: config.policy,
    }),
  })

  try {
    const { port } = await bridge.listen()
    banner(config, port, logger)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    logger.error('bridge.listen_failed', { error, port: config.port })
    process.stderr.write(
      code === 'EADDRINUSE'
        ? `\nPort ${config.port} is already in use. Stop the other process or set CLAP_BRIDGE_PORT.\n\n`
        : `\nThe bridge could not listen on ${config.host}:${config.port} (${code ?? 'unknown error'}).\n\n`,
    )
    process.exit(1)
  }

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.info('bridge.stopping', { signal })
    const force = setTimeout(() => process.exit(0), 3_000)
    force.unref()
    void bridge.close().then(() => {
      logger.info('bridge.stopped')
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main()
