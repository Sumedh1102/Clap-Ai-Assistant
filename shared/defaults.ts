/**
 * Defaults shared by the HUD, the bridge and the scripts.
 *
 * Anything a user can change lives in configuration (see .env.example); these
 * are the values used when it is not set, plus hard limits that both sides
 * must agree on.
 */

export const CLAP_NAME = 'CLAP'
export const CLAP_VERSION = '0.1.0'

/** Bumped whenever an event's shape changes incompatibly. */
export const PROTOCOL_VERSION = 1

export const DEFAULT_BRIDGE_HOST = '127.0.0.1'
export const DEFAULT_BRIDGE_PORT = 7719
export const DEFAULT_UI_PORT = 5173
export const WS_PATH = '/ws'

/**
 * Two ordinary English words. "clap" alone is far too common to be a wake
 * word, so the whole phrase is required (see src/voice/wake.ts).
 */
export const DEFAULT_WAKE_PHRASE = 'hey clap'

/** One WebSocket message. A spoken request is a few hundred bytes. */
export const MAX_WS_MESSAGE_BYTES = 64 * 1024
export const MAX_USER_TEXT_CHARS = 4000
/** One spoken sentence sent for synthesis. */
export const MAX_TTS_TEXT_CHARS = 1200
/** One captured speech segment sent for transcription. */
export const MAX_STT_AUDIO_BYTES = 10 * 1024 * 1024
