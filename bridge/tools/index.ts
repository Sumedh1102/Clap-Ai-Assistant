/**
 * Builds the registry for this bridge: CLAP's own tools plus the Claude Code
 * built-ins CLAP chooses to allow. Anything not registered here is denied by
 * the permission gate.
 */

import type { BridgeConfig } from '../config'
import { ToolRegistry } from './registry'
import { getTime, systemInfo } from './system'
import { webFetch } from './web'

export function createToolRegistry(config: Pick<BridgeConfig, 'policy' | 'enableWebSearch'>): ToolRegistry {
  const registry = new ToolRegistry(config.policy).register(getTime).register(systemInfo).register(webFetch)

  if (config.enableWebSearch) {
    // Runs on Anthropic's side: the query leaves this machine, nothing is
    // fetched from here, so there is no SSRF surface.
    registry.registerBuiltin({
      name: 'WebSearch',
      label: 'Web search',
      category: 'web',
      risk: 'low',
      requiresConfirmation: false,
      summarize: (input) => {
        const query = (input as { query?: unknown } | null)?.query
        return typeof query === 'string' ? `Searching “${query}”` : 'Searching the web'
      },
    })
  }
  return registry
}

/** Built-in Claude Code tools that must never be offered, whatever else changes. */
export const ALWAYS_DISALLOWED_BUILTINS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Task',
  'Agent',
  'TaskOutput',
  'TaskStop',
  'Skill',
  'SlashCommand',
]
