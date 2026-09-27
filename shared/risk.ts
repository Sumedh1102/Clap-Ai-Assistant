/**
 * Risk levels and permission policy vocabulary.
 *
 * LOW    information lookup, reading safe data, opening apps
 * MEDIUM editing files, browser interaction, sending messages, settings
 * HIGH   deleting, installing, destructive shell, financial, irreversible
 *
 * The bridge enforces these (bridge/permissions.ts). The HUD only displays
 * them. HIGH can never be set to plain "allow": it always needs an explicit
 * confirmation, or it is denied.
 */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const POLICY_ACTIONS = ['allow', 'confirm', 'deny'] as const
export type PolicyAction = (typeof POLICY_ACTIONS)[number]

export type RiskPolicy = {
  low: PolicyAction
  medium: PolicyAction
  high: Exclude<PolicyAction, 'allow'>
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  low: 'allow',
  medium: 'allow',
  high: 'confirm',
}

export const TOOL_CATEGORIES = [
  'system',
  'files',
  'web',
  'browser',
  'media',
  'developer',
  'memory',
  'mcp',
] as const
export type ToolCategory = (typeof TOOL_CATEGORIES)[number]

export const MEMORY_CATEGORIES = [
  'user_profile',
  'preferences',
  'projects',
  'routines',
  'system',
  'conversation_summary',
] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]
