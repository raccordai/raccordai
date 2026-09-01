/**
 * Shared vocabulary of the agent tool registry: the AgentTool contract, the
 * scope/risk taxonomy, and the tiny JSON-schema builders every domain module
 * declares its inputs with. The domain modules (one per capability area) each
 * export their slice of the registry; ../registry.ts concatenates them.
 */

/**
 * Which binding id the tool consumes: 'video' tools take a videoId, 'project'
 * tools a projectId (both are injected by the chat adapter in a video-bound
 * session), 'global' tools take neither or address rows by their own explicit
 * ids (nodeId, assetId, generationId — globally unique).
 */
export type ToolScope = 'global' | 'project' | 'video'

/**
 * Blast radius of the tool. 'read' = no state change (no UI refresh);
 * 'write' = reversible-ish mutation; 'destructive' = permanent data loss —
 * the CHAT surface always requires user approval (`confirm: true` after an
 * action card); 'spending' = calls kie.ai and costs credits, gated the same
 * way while the `assistantRunApproval` setting is 'ask' (the default).
 * MCP clients remain the human's own agent and execute directly either way.
 */
export type ToolRisk = 'read' | 'write' | 'destructive' | 'spending'

/**
 * Optional per-call context a host surface can provide. The chat loop passes
 * onGenerationStarted so every generation a batch claims joins its watched set
 * (settle wake-up); the MCP server passes nothing. This is what keeps
 * run_batch/finalize_video single-sourced here instead of re-implemented in
 * chat.ts for the sake of one callback.
 */
export interface ToolExecuteContext {
  onGenerationStarted?: (nodeId: string, generationId: string) => void
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  scope: ToolScope
  risk: ToolRisk
  execute(args: Record<string, unknown>, ctx?: ToolExecuteContext): Promise<unknown> | unknown
}

/**
 * Rich tool result: a text summary plus inline images, so agents can SEE what
 * they generate. The MCP server maps it to image content blocks and the chat
 * loop to Anthropic vision blocks (the OpenAI-Responses translator degrades
 * each image to an "[image]" note — that path has no image tool results).
 */
export interface ToolMediaResult {
  kind: 'tool-media'
  text: string
  images: { mediaType: string; base64: string }[]
}

export function isToolMediaResult(value: unknown): value is ToolMediaResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'tool-media' &&
    Array.isArray((value as { images?: unknown }).images)
  )
}

export const str = (description?: string): Record<string, unknown> => ({
  type: 'string',
  ...(description ? { description } : {})
})

export const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: 'object', properties, required })

/** Asset DTO shared by get_workflow and the asset tools. */
export const assetRow = (a: {
  id: string
  key: string
  name: string
  kind: string
  description: string | null
  designId: string | null
  designSubject: string | null
}): Record<string, unknown> => ({
  id: a.id,
  key: a.key,
  name: a.name,
  kind: a.kind,
  description: a.description,
  // Set on published design sheets — reference-only, never a frame anchor.
  designId: a.designId,
  designSubject: a.designSubject
})
