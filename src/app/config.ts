/**
 * Frontend configuration.
 *
 * Nothing here is secret, and nothing here may ever be: everything in a Vite
 * bundle is readable by anyone who opens the page. Provider keys live on the
 * bridge. The wake phrase, model and voice capabilities also come from the
 * bridge (`session_ready`), so there is one source of truth.
 */

import { DEFAULT_WAKE_PHRASE } from '../../shared/defaults'
import type { EnginePreferences } from '../voice/capabilities'

declare const __CLAP_BRIDGE_URL__: string

function choice<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function flag(raw: unknown, fallback: boolean): boolean {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

const env = import.meta.env

/** http://127.0.0.1:7719 — injected by vite.config.ts from CLAP_BRIDGE_PORT. */
export const BRIDGE_HTTP_URL: string = __CLAP_BRIDGE_URL__.replace(/\/+$/, '')
export const BRIDGE_WS_URL = `${BRIDGE_HTTP_URL.replace(/^http/, 'ws')}/ws`

export const LANGUAGE: string = (typeof env.VITE_CLAP_LANG === 'string' && env.VITE_CLAP_LANG.trim()) || navigator.language || 'en-US'

export const DEBUG = flag(env.VITE_CLAP_DEBUG, false)

/** Until the bridge says otherwise. */
export const FALLBACK_WAKE_PHRASE = DEFAULT_WAKE_PHRASE

export const ENGINE_PREFERENCES: EnginePreferences = {
  wake: choice(env.VITE_CLAP_WAKE_ENGINE, ['auto', 'local', 'cloud', 'push-to-talk'] as const, 'auto'),
  allowCloudWake: flag(env.VITE_CLAP_WAKE_ALLOW_CLOUD, true),
  stt: choice(env.VITE_CLAP_STT, ['auto', 'browser', 'cloud'] as const, 'auto'),
  tts: choice(env.VITE_CLAP_TTS, ['auto', 'browser', 'cloud'] as const, 'auto'),
}
