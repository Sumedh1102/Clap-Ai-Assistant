/**
 * Exposes the tool registry to the agent as an in-process MCP server.
 *
 * The SDK reports calls to these tools with provenance `{ name: 'clap',
 * source: 'sdk' }`, which is what the permission gate keys its trust on. The
 * handlers route through `registry.execute`, so validation, the static policy
 * check, timeouts and error wrapping apply even if a call somehow reached a
 * handler without passing the gate.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { CLAP_VERSION } from '../../shared/defaults'
import { CLAP_MCP_SERVER, type ToolContext, type ToolRegistry } from './registry'

export function createClapMcpServer(registry: ToolRegistry, context: () => ToolContext) {
  return createSdkMcpServer({
    name: CLAP_MCP_SERVER,
    version: CLAP_VERSION,
    tools: registry.clapTools().map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.inputSchema,
        async (args) => {
          const result = await registry.execute(definition.name, args, context())
          return result.ok
            ? { content: [{ type: 'text' as const, text: result.output.text }] }
            : { content: [{ type: 'text' as const, text: result.error }], isError: true }
        },
        {
          annotations: {
            title: definition.label,
            readOnlyHint: definition.risk === 'low',
            destructiveHint: definition.risk === 'high',
            openWorldHint: definition.category === 'web',
          },
        },
      ),
    ),
  })
}
