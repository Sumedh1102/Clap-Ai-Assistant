/**
 * Render state for the HUD.
 *
 * This store holds what the interface shows — nothing more. Conversation logic
 * lives in the state machine and the controller; they write here, React reads.
 * Live audio levels are deliberately NOT in here: they change sixty times a
 * second and are read straight from the controller inside the render loop.
 */

import { create } from 'zustand'
import type { AgentActivity, Capabilities, ToolInfo } from '../../shared/protocol'
import type { RiskLevel } from '../../shared/risk'
import type { AssistantState, PendingConfirmation } from '../voice/machine'

export type ConnectionState = 'connecting' | 'online' | 'offline'

export type TranscriptEntry = {
  id: string
  role: 'user' | 'clap'
  text: string
  source?: 'voice' | 'text'
  interrupted?: boolean
  error?: string
  at: number
}

export type ToolActivity = {
  toolUseId: string
  name: string
  label: string
  summary: string
  risk: RiskLevel
  status: 'running' | 'done' | 'failed' | 'denied'
  detail?: string
  durationMs?: number
}

export type VoiceStatus = {
  enabled: boolean
  activating: boolean
  wake: string
  stt: string
  tts: string
  notes: string[]
}

export type SessionInfo = {
  id: string | null
  model: string
  wakePhrase: string
  tools: ToolInfo[]
  capabilities: Capabilities | null
  resumed: boolean
}

type HudState = {
  assistant: AssistantState
  connection: ConnectionState
  connectionDetail: string
  latencyMs: number | null
  session: SessionInfo
  voice: VoiceStatus
  activity: AgentActivity
  caption: string
  transcript: TranscriptEntry[]
  currentTurnId: string | null
  tools: ToolActivity[]
  confirmation: PendingConfirmation | null
  error: string | null
  notice: string | null
  panels: { diagnostics: boolean; history: boolean }
}

const MAX_TRANSCRIPT = 200

export const useHud = create<HudState>()(() => ({
  assistant: 'OFFLINE',
  connection: 'connecting',
  connectionDetail: '',
  latencyMs: null,
  session: { id: null, model: '', wakePhrase: '', tools: [], capabilities: null, resumed: false },
  voice: { enabled: false, activating: false, wake: 'off', stt: 'off', tts: 'off', notes: [] },
  activity: 'idle',
  caption: '',
  transcript: [],
  currentTurnId: null,
  tools: [],
  confirmation: null,
  error: null,
  notice: null,
  panels: { diagnostics: false, history: false },
}))

const set = useHud.setState
const get = useHud.getState

export const hud = {
  set,
  get,

  addUserTurn(turnId: string, text: string, source: 'voice' | 'text') {
    const entry: TranscriptEntry = { id: `u-${turnId}`, role: 'user', text, source, at: Date.now() }
    set((s) => ({ transcript: [...s.transcript, entry].slice(-MAX_TRANSCRIPT), currentTurnId: turnId, tools: [], caption: '' }))
  },

  appendClap(turnId: string, delta: string) {
    set((s) => {
      const id = `c-${turnId}`
      const last = s.transcript[s.transcript.length - 1]
      if (last?.id === id) {
        const updated = { ...last, text: last.text + delta }
        return { transcript: [...s.transcript.slice(0, -1), updated] }
      }
      return { transcript: [...s.transcript, { id, role: 'clap' as const, text: delta, at: Date.now() }].slice(-MAX_TRANSCRIPT) }
    })
  },

  finishClap(turnId: string, patch: Partial<Pick<TranscriptEntry, 'interrupted' | 'error'>>) {
    set((s) => {
      const id = `c-${turnId}`
      const index = s.transcript.findIndex((e) => e.id === id)
      if (index === -1) {
        if (!patch.error) return {}
        const entry: TranscriptEntry = { id, role: 'clap', text: '', at: Date.now(), ...patch }
        return { transcript: [...s.transcript, entry].slice(-MAX_TRANSCRIPT) }
      }
      const transcript = [...s.transcript]
      transcript[index] = { ...transcript[index]!, ...patch }
      return { transcript }
    })
  },

  toolStarted(tool: Omit<ToolActivity, 'status'>) {
    set((s) => ({ tools: [...s.tools.filter((t) => t.toolUseId !== tool.toolUseId), { ...tool, status: 'running' as const }].slice(-8) }))
  },

  toolFinished(toolUseId: string, patch: Pick<ToolActivity, 'status'> & Partial<ToolActivity>, fallback?: Omit<ToolActivity, 'status'>) {
    set((s) => {
      const exists = s.tools.some((t) => t.toolUseId === toolUseId)
      if (!exists && fallback) return { tools: [...s.tools, { ...fallback, ...patch }].slice(-8) }
      return { tools: s.tools.map((t) => (t.toolUseId === toolUseId ? { ...t, ...patch } : t)) }
    })
  },

  togglePanel(panel: keyof HudState['panels']) {
    set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } }))
  },
}
