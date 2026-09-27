import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentEnvironment, ConfigError, normalizeOrigin, parseConfig, secretValues, voiceCapabilities } from './config'
import { parseEnv } from './env'

const problems = (env: NodeJS.ProcessEnv): string[] => {
  try {
    parseConfig(env)
    return []
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).problems
  }
}

describe('parseConfig', () => {
  it('has safe defaults', () => {
    const config = parseConfig({ CLAP_LOG_FORMAT: 'json' })
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 7719,
      uiPort: 5173,
      allowNoOrigin: false,
      wakePhrase: 'hey clap',
      policy: { low: 'allow', medium: 'allow', high: 'confirm' },
      confirmTimeoutMs: 45_000,
      sessionGraceMs: 120_000,
      logFormat: 'json',
    })
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173'])
    expect(config.allowedHosts).toEqual(['127.0.0.1:7719', 'localhost:7719', '[::1]:7719'])
    expect(config.voice.elevenLabsApiKey).toBeNull()
  })

  it('derives the allowed origins and hosts from the ports', () => {
    const config = parseConfig({ CLAP_BRIDGE_PORT: '9000', CLAP_UI_PORT: '9001', CLAP_ALLOWED_ORIGINS: 'http://LocalHost:3000/ , ' })
    expect(config.allowedOrigins).toEqual(['http://localhost:9001', 'http://127.0.0.1:9001', 'http://localhost:3000'])
    expect(config.allowedHosts).toContain('localhost:9000')
  })

  it('refuses a non-loopback bind unless explicitly allowed', () => {
    expect(problems({ CLAP_BRIDGE_HOST: '0.0.0.0' })[0]).toMatch(/not a loopback address/)
    const config = parseConfig({ CLAP_BRIDGE_HOST: '192.168.1.5', CLAP_ALLOW_NON_LOOPBACK: '1' })
    expect(config.allowedHosts).toContain('192.168.1.5:7719')
    expect(parseConfig({ CLAP_BRIDGE_HOST: 'fd00::5', CLAP_ALLOW_NON_LOOPBACK: 'yes' }).allowedHosts).toContain('[fd00::5]:7719')
  })

  it('never allows HIGH risk without confirmation', () => {
    expect(problems({ CLAP_POLICY_HIGH: 'allow' })).toEqual([
      'CLAP_POLICY_HIGH cannot be "allow": high-risk actions always need confirmation. Use confirm or deny.',
    ])
    expect(problems({ CLAP_POLICY_HIGH: 'ALLOW' })[0]).toMatch(/must be one of: confirm, deny/)
    expect(parseConfig({ CLAP_POLICY_HIGH: 'deny', CLAP_POLICY_MEDIUM: 'confirm' }).policy).toEqual({
      low: 'allow',
      medium: 'confirm',
      high: 'deny',
    })
  })

  it('validates the wake phrase', () => {
    expect(parseConfig({ CLAP_WAKE_PHRASE: '  Hello   There ' }).wakePhrase).toBe('hello there')
    expect(problems({ CLAP_WAKE_PHRASE: 'clap' })[0]).toMatch(/single word/)
    expect(problems({ CLAP_WAKE_PHRASE: 'hey clap 2' })[0]).toMatch(/letters/)
    expect(problems({ CLAP_WAKE_PHRASE: 'one two three four five six' })[0]).toMatch(/1–5 words/)
  })

  it('reports every problem at once, each naming its variable', () => {
    const found = problems({
      CLAP_BRIDGE_PORT: '80',
      CLAP_UI_PORT: 'abc',
      CLAP_ALLOWED_ORIGINS: 'localhost:5173',
      CLAP_EFFORT: 'extreme',
      CLAP_DEBUG: 'maybe',
      CLAP_VOICE_SPEED: '3',
      CLAP_MODEL: 'claude opus',
    })
    expect(found).toHaveLength(7)
    for (const name of ['CLAP_BRIDGE_PORT', 'CLAP_UI_PORT', 'CLAP_ALLOWED_ORIGINS', 'CLAP_EFFORT', 'CLAP_DEBUG', 'CLAP_VOICE_SPEED', 'CLAP_MODEL']) {
      expect(found.some((p) => p.includes(name))).toBe(true)
    }
  })

  it('refuses equal ports and an ElevenLabs provider without a key', () => {
    expect(problems({ CLAP_BRIDGE_PORT: '6000', CLAP_UI_PORT: '6000' })).toEqual(['CLAP_BRIDGE_PORT and CLAP_UI_PORT must differ.'])
    expect(problems({ CLAP_TTS_PROVIDER: 'elevenlabs' })[0]).toMatch(/ELEVENLABS_API_KEY is not set/)
    expect(problems({ ELEVENLABS_API_KEY: 'sk_test_key', CLAP_VOICE_ID: 'bad id!' })[0]).toMatch(/CLAP_VOICE_ID/)
  })
})

describe('voice capabilities and secrets', () => {
  it('turns cloud voice on only with a key, per direction', () => {
    const none = parseConfig({})
    expect(voiceCapabilities(none)).toEqual({
      stt: { cloud: false, provider: null },
      tts: { cloud: false, provider: null, customVoice: false },
    })
    const keyed = parseConfig({ ELEVENLABS_API_KEY: 'sk_0123456789abcdef', CLAP_STT_PROVIDER: 'none', CLAP_VOICE_ID: 'Abc123Def456' })
    expect(voiceCapabilities(keyed)).toEqual({
      stt: { cloud: false, provider: null },
      tts: { cloud: true, provider: 'elevenlabs', customVoice: true },
    })
    expect(secretValues(keyed)).toEqual(['sk_0123456789abcdef'])
  })

  it('keeps CLAP secrets out of the agent subprocess environment', () => {
    const env = agentEnvironment({ ELEVENLABS_API_KEY: 'sk_secret', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'needed' })
    expect(env.ELEVENLABS_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ANTHROPIC_API_KEY).toBe('needed')
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^clap\//)
  })
})

describe('normalizeOrigin', () => {
  it('accepts bare http(s) origins only', () => {
    expect(normalizeOrigin('http://LocalHost:5173/')).toBe('http://localhost:5173')
    expect(normalizeOrigin('https://example.com')).toBe('https://example.com')
    expect(normalizeOrigin('http://localhost:5173/app')).toBeNull()
    expect(normalizeOrigin('http://u:p@localhost:5173')).toBeNull()
    expect(normalizeOrigin('ws://localhost:5173')).toBeNull()
    expect(normalizeOrigin('localhost:5173')).toBeNull()
  })
})

describe('parseEnv', () => {
  it('reads KEY=VALUE lines with quotes, comments and export prefixes', () => {
    const parsed = parseEnv(
      [
        '# comment',
        '',
        'A=plain',
        'export B = spaced  ',
        'C="double \\"quoted\\"\\nline"',
        "D='single # not a comment'",
        'E=value # trailing comment',
        'F=',
        'not a line',
        '1BAD=x',
      ].join('\r\n'),
    )
    expect(parsed).toEqual({
      A: 'plain',
      B: 'spaced',
      C: 'double "quoted"\nline',
      D: 'single # not a comment',
      E: 'value',
      F: '',
    })
  })
})

describe('.env.example', () => {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

  it('documents every variable the bridge reads', () => {
    const source = readFileSync(new URL('./config.ts', import.meta.url), 'utf8')
    const read = new Set([...source.matchAll(/'((?:CLAP|ELEVENLABS)_[A-Z_]+)'/g)].map((m) => m[1]!))
    for (const name of read) expect(example, name).toContain(`# ${name}=`)
  })

  it('shows defaults that parse to the defaults', () => {
    const shown = Object.fromEntries(
      [...example.matchAll(/^# ((?:CLAP|ELEVENLABS)_[A-Z_]+)=(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]),
    )
    expect(Object.keys(shown).length).toBeGreaterThan(15)
    const withDefaults = parseConfig({ ...shown, CLAP_LOG_FORMAT: 'json' })
    expect(withDefaults).toEqual(parseConfig({ CLAP_LOG_FORMAT: 'json' }))
  })
})
