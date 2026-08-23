import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { app as electronApp } from 'electron'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_TOOLS, executeAgentTool, isToolMediaResult } from './registry'

/**
 * MCP server — publishes the agent-tool registry over the Streamable HTTP
 * transport. Stateless mode: one Server+Transport pair per request (no
 * session bookkeeping; right-sized for a local, single-user app) with plain
 * JSON responses (enableJsonResponse) so any client or curl can talk to it.
 */

function buildServer(): Server {
  const server = new Server(
    { name: 'raccord', version: electronApp.getVersion() },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await executeAgentTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>
      )
      // Media results become real image content blocks — the client's model
      // sees the picture, not a JSON blob of base64.
      if (isToolMediaResult(result)) {
        return {
          content: [
            ...result.images.map((image) => ({
              type: 'image' as const,
              data: image.base64,
              mimeType: image.mediaType
            })),
            { type: 'text' as const, text: result.text }
          ]
        }
      }
      return {
        content: [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }
        ]
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true
      }
    }
  })

  return server
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
