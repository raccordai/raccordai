import { broadcastWorkflowChanged } from '../events'
import * as graphHistory from '../services/graphHistory'
import { assetTools } from './registry/assets'
import { castingTools } from './registry/casting'
import { demoTools } from './registry/demo'
import { generationTools } from './registry/generation'
import { graphTools } from './registry/graph'
import { nicheTools } from './registry/niches'
import { platformTools } from './registry/platform'
import { projectTools } from './registry/projects'
import { renderTools } from './registry/render'
import { timelineTools } from './registry/timeline'
import { obj, str, type AgentTool } from './registry/types'

/**
 * THE agent-facing capability registry (§4.10 phase 3). One entry per
 * capability, executing against the same main-process services as the IPC
 * layer. Both agent surfaces consume it: the MCP server publishes it as-is
 * (explicit ids), the embedded assistant adapts it per session binding
 * (`chatToolAdapter.ts`). Adding a capability to Raccord means adding one
 * entry to the matching domain module in ./registry/, nothing else.
 *
 * Design rules (keep them, they keep the token bill down):
 *  - descriptions are 1–2 lines; depth lives in the `docs` tool (progressive
 *    disclosure — agents fetch exactly the reference they need);
 *  - inputs/outputs are plain JSON; ids are explicit (an MCP client has no
 *    "current video" context — the chat adapter injects the session's ids);
 *  - every entry declares `scope` and `risk` (invariant-tested);
 *  - settings (API keys, update channel, concurrency) and backup/restore are
 *    deliberately NOT here — an LLM loop must not touch keys or relaunch the
 *    app.
 *
 * This file only aggregates the domain modules and hosts batch_edit — the one
 * meta-tool that dispatches over the whole registry.
 */

export type {
  AgentTool,
  ToolExecuteContext,
  ToolMediaResult,
  ToolRisk,
  ToolScope
} from './registry/types'
export { isToolMediaResult } from './registry/types'

/** Write tools that still must not run inside batch_edit (long-running,
 * navigation, or history-manipulating — grouping them makes no sense). */
const BATCH_EXCLUDED = new Set([
  'batch_edit',
  'undo',
  'redo',
  'render_video',
  'cancel_render',
  'cancel_generation',
  'dequeue_generation',
  'open_video',
  'export_image',
  'export_fcpxml',
  'export_publish_kit',
  'import_workflow',
  'restore_checkpoint'
])

const batchEditTool: AgentTool = {
  name: 'batch_edit',
  description:
    'Run several WRITE tool calls as ONE undo step on a video — the user undoes your gesture, not its 10 implementation details. Only risk "write" graph/timeline tools are allowed (no reads, deletes, spending, undo/redo, renders or exports). Calls run in order; the first failure stops the batch (already-applied calls stay, still one undo step). Every call must target this same video.',
  inputSchema: obj(
    {
      videoId: str(),
      calls: {
        type: 'array',
        items: obj({ tool: str(), args: { type: 'object' } }, ['tool']),
        description: 'Tool calls in execution order (1-20).'
      }
    },
    ['videoId', 'calls']
  ),
  scope: 'video',
  risk: 'write',
  execute: async ({ videoId, calls }) => {
    const list = Array.isArray(calls) ? calls : []
    if (list.length < 1 || list.length > 20) {
      throw new Error('batch_edit takes 1 to 20 calls.')
    }
    const resolved = list.map((raw) => {
      const call = raw as { tool?: unknown; args?: unknown }
      const tool = AGENT_TOOLS.find((t) => t.name === String(call.tool))
      if (!tool) throw new Error(`Unknown tool: ${String(call.tool)}`)
      if (tool.risk !== 'write' || BATCH_EXCLUDED.has(tool.name)) {
        throw new Error(`"${tool.name}" cannot run inside batch_edit — only plain write tools can.`)
      }
      return {
        tool,
        args: (call.args && typeof call.args === 'object' ? call.args : {}) as Record<
          string,
          unknown
        >
      }
    })
    return graphHistory.withGraphHistoryGroupAsync(String(videoId), async () => {
      const results: Array<{ tool: string; result: unknown }> = []
      for (const { tool, args } of resolved) {
        results.push({ tool: tool.name, result: await tool.execute(args) })
      }
      return { ok: true, results }
    })
  }
}

export const AGENT_TOOLS: AgentTool[] = [
  ...platformTools,
  ...projectTools,
  ...graphTools,
  ...timelineTools,
  ...castingTools,
  batchEditTool,
  ...generationTools,
  ...demoTools,
  ...renderTools,
  ...assetTools,
  ...nicheTools
]

/** Runs a registry tool by name; non-read tools refresh the app UI. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = AGENT_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  const result = await tool.execute(args)
  if (tool.risk !== 'read') broadcastWorkflowChanged(String(args['videoId'] ?? ''))
  return result
}
