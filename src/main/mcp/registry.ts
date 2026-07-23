import { broadcastWorkflowChanged } from '../events'
import * as assets from '../services/assets'
import * as generations from '../services/generations'
import * as graph from '../services/graph'
import * as graphHistory from '../services/graphHistory'
import * as projects from '../services/projects'
import { kieGetCredits } from '../services/kie'
import * as renderService from '../services/render'
import { runNode } from '../services/runEngine'
import * as videos from '../services/videos'
import { DOC_TOPICS, getDoc } from './docs'

/**
 * THE agent-facing capability registry. One entry per capability, executing
 * against the same main-process services as the IPC layer and the embedded
 * assistant. The MCP server publishes this list as-is — adding a capability
 * to Raccord means adding one entry here, nothing else.
 *
 * Design rules (keep them, they keep the token bill down):
 *  - descriptions are 1–2 lines; depth lives in the `docs` tool (progressive
 *    disclosure — agents fetch exactly the reference they need);
 *  - inputs/outputs are plain JSON; ids are explicit (an MCP client has no
 *    "current video" context);
 *  - `mutates: true` entries broadcast a refresh to the app UI after running.
 */

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutates?: boolean
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: 'object', properties, required })

export const AGENT_TOOLS: AgentTool[] = [
  // ── Documentation (call this first) ────────────────────────────────────────
  {
    name: 'docs',
    description: `Raccord reference documentation, on demand. Topics: ${DOC_TOPICS}. Start with "overview"; read "model:<id>" before creating nodes for that model.`,
    inputSchema: obj({ topic: str() }, ['topic']),
    execute: ({ topic }) => getDoc(String(topic))
  },

  // ── Account ────────────────────────────────────────────────────────────────
  {
    name: 'get_credits',
    description: 'Remaining kie.ai account credits (each generation consumes some).',
    inputSchema: obj({}),
    execute: async () => ({ credits: await kieGetCredits() })
  },

  // ── Navigation ─────────────────────────────────────────────────────────────
  {
    name: 'list_projects',
    description: 'List all projects (id, name, timestamps).',
    inputSchema: obj({}),
    execute: () => projects.listProjects()
  },
  {
    name: 'create_project',
    description: 'Create a project.',
    inputSchema: obj({ name: str() }, ['name']),
    mutates: true,
    execute: ({ name }) => projects.createProject(String(name))
  },
  {
    name: 'list_videos',
    description: 'List the videos (workflow graphs) of a project.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    execute: ({ projectId }) => videos.listVideos(String(projectId))
  },
  {
    name: 'create_video',
    description: 'Create a video (an empty workflow graph) in a project.',
    inputSchema: obj({ projectId: str(), name: str() }, ['projectId', 'name']),
    mutates: true,
    execute: ({ projectId, name }) => videos.createVideo(String(projectId), String(name))
  },

  // ── Workflow graph ─────────────────────────────────────────────────────────
  {
    name: 'get_workflow',
    description:
      'Read a video’s graph: active style (art direction), nodes (id, key, modelId, label, intent, params, hasSuccessfulOutput) and edges.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    execute: ({ videoId }) => {
      const { nodes, edges } = graph.listGraph(String(videoId))
      const gens = generations.listGenerationsForVideo(String(videoId))
      const styleId = videos.getVideo(String(videoId))?.styleId ?? null
      return {
        // Art direction of the video — docs "styles"; applied at run time to
        // nodes whose params carry applyVideoStyle: true (never baked into prompts).
        styleId,
        nodes: nodes.map((n) => ({
          id: n.id,
          key: n.key,
          modelId: n.modelId,
          label: n.label,
          intent: n.intent,
          position: n.position,
          params: n.params,
          hasSuccessfulOutput: gens.some((g) => g.nodeId === n.id && g.status === 'success')
        })),
        edges: edges.map((e) => ({
          id: e.id,
          from: e.sourceNodeId,
          to: e.targetNodeId,
          input: e.targetHandle,
          output: e.sourceHandle
        }))
      }
    }
  },
  {
    name: 'set_video_style',
    description:
      'Attach a style template (art direction — docs "styles") to a video; its style bible is appended at run time to every visual node whose params carry "applyVideoStyle": true. Empty styleId clears it.',
    inputSchema: obj(
      { videoId: str(), styleId: str('Style id from docs "styles", or "" to clear') },
      ['videoId', 'styleId']
    ),
    mutates: true,
    execute: ({ videoId, styleId }) => {
      videos.setVideoStyle(String(videoId), styleId ? String(styleId) : null)
      return { ok: true }
    }
  },
  {
    name: 'export_workflow',
    description: 'Export a video’s graph as portable workflow JSON (see docs "workflow-json").',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    execute: ({ videoId }) => graph.exportWorkflow(String(videoId))
  },
  {
    name: 'import_workflow',
    description:
      'Bulk-create a graph from workflow JSON (docs "workflow-json"). replace=true ERASES the current graph — needs explicit user consent.',
    inputSchema: obj(
      { videoId: str(), json: str('Workflow JSON as a string'), replace: { type: 'boolean' } },
      ['videoId', 'json', 'replace']
    ),
    mutates: true,
    execute: ({ videoId, json, replace }) =>
      graph.importWorkflow(String(videoId), String(json), Boolean(replace))
  },
  {
    name: 'add_node',
    description:
      'Create a node. Read docs "model:<id>" first for valid params; "studio/asset" nodes take params {"assetId"}.',
    inputSchema: obj(
      {
        videoId: str(),
        modelId: str(),
        label: str('Short display label, e.g. "Shot 01 — The harbor"'),
        intent: str('Expected result, shown to the user'),
        params: { type: 'object' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      ['videoId', 'modelId']
    ),
    mutates: true,
    execute: ({ videoId, modelId, label, intent, params, x, y }) =>
      graph.createNode({
        videoId: String(videoId),
        modelId: String(modelId),
        position: { x: Number(x ?? 0), y: Number(y ?? 0) },
        label: label ? String(label) : undefined,
        intent: intent ? String(intent) : undefined,
        params
      })
  },
  {
    name: 'update_node',
    description: 'Update a node’s label, intent and/or params (params replace the whole object).',
    inputSchema: obj({ nodeId: str(), label: str(), intent: str(), params: { type: 'object' } }, [
      'nodeId'
    ]),
    mutates: true,
    execute: ({ nodeId, label, intent, params }) => {
      const id = String(nodeId)
      if (label !== undefined) graph.updateNodeLabel(id, String(label))
      if (intent !== undefined) graph.updateNodeIntent(id, String(intent))
      if (params !== undefined) graph.updateNodeParams(id, params)
      return { ok: true }
    }
  },
  {
    name: 'connect_nodes',
    description:
      'Wire a source node output into a target node input. "input" must be a valid input field of the target model (docs "model:<id>").',
    inputSchema: obj(
      {
        videoId: str(),
        sourceNodeId: str(),
        targetNodeId: str(),
        input: str('Target model input field'),
        output: str('"output" (default) or "lastFrame"')
      },
      ['videoId', 'sourceNodeId', 'targetNodeId', 'input']
    ),
    mutates: true,
    execute: ({ videoId, sourceNodeId, targetNodeId, input, output }) =>
      graph.connectNodes({
        videoId: String(videoId),
        sourceNodeId: String(sourceNodeId),
        sourceHandle: output ? String(output) : 'output',
        targetNodeId: String(targetNodeId),
        targetHandle: String(input)
      })
  },
  {
    name: 'remove_node',
    description: 'Delete a node, its connections and its generations. Destructive.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    mutates: true,
    execute: ({ nodeId }) => {
      graph.removeNode(String(nodeId))
      return { ok: true }
    }
  },

  {
    name: 'undo',
    description: 'Undo the last graph mutation on a video (deleted generations are not restored).',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    mutates: true,
    execute: ({ videoId }) => graphHistory.undoGraph(String(videoId))
  },
  {
    name: 'redo',
    description: 'Redo the last undone graph mutation on a video.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    mutates: true,
    execute: ({ videoId }) => graphHistory.redoGraph(String(videoId))
  },

  // ── Generation ─────────────────────────────────────────────────────────────
  {
    name: 'estimate_cost',
    description:
      'Indicative kie.ai credit cost of running a node with its current params (null when unknown).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    execute: ({ nodeId }) => ({ credits: generations.estimateNodeRunCredits(String(nodeId)) })
  },
  {
    name: 'run_node',
    description:
      'Launch a node’s generation (calls kie.ai — COSTS MONEY; upstream inputs must already have outputs). Asynchronous: poll get_generations for completion.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    mutates: true,
    execute: ({ nodeId }) => runNode(String(nodeId))
  },
  {
    name: 'get_generations',
    description:
      'List a node’s generations: status (pending/running/success/failed), media URL, error.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    execute: ({ nodeId }) =>
      generations.listGenerationsForNode(String(nodeId)).map((g) => ({
        id: g.id,
        status: g.status,
        url: g.resultUrl,
        error: g.errorMessage,
        createdAt: g.createdAt
      }))
  },
  {
    name: 'render_video',
    description:
      'Render a video’s timeline into a single MP4 file (local ffmpeg, no credits): clips concatenated in shot order, music lane muxed over. Synchronous — returns the output path.',
    inputSchema: obj(
      { videoId: str(), outputPath: str('Absolute .mp4 destination (default: Downloads folder)') },
      ['videoId']
    ),
    execute: async ({ videoId, outputPath }) => {
      const target = outputPath
        ? String(outputPath)
        : renderService.defaultOutputPath(String(videoId))
      const { durationSeconds, skipped } = await renderService.renderVideo({
        videoId: String(videoId),
        outputPath: target
      })
      return { path: target, durationSeconds, skipped }
    }
  },

  // ── Assets (project-wide media library) ────────────────────────────────────
  {
    name: 'list_assets',
    description:
      'List a project’s assets (shared by all its videos): id, portable key, name, kind, description. designId/designSubject are set on published design sheets (reference-only: never wire them to a frame anchor).',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    execute: ({ projectId }) =>
      assets.listAssets(String(projectId)).map((a) => ({
        id: a.id,
        key: a.key,
        name: a.name,
        kind: a.kind,
        description: a.description,
        designId: a.designId,
        designSubject: a.designSubject
      }))
  },
  {
    name: 'search_assets',
    description:
      'Search a project’s assets by name, key, description or tag (accent-insensitive, AND terms).',
    inputSchema: obj({ projectId: str(), query: str('Search terms') }, ['projectId', 'query']),
    execute: ({ projectId, query }) =>
      assets.searchAssets(String(projectId), String(query)).map((a) => ({
        id: a.id,
        key: a.key,
        name: a.name,
        kind: a.kind,
        description: a.description,
        tags: a.tags,
        designId: a.designId,
        designSubject: a.designSubject
      }))
  },
  {
    name: 'set_asset_tags',
    description: 'Replace an asset’s tags (labels used to filter the library).',
    inputSchema: obj({ assetId: str(), tags: { type: 'array', items: { type: 'string' } } }, [
      'assetId',
      'tags'
    ]),
    mutates: true,
    execute: ({ assetId, tags }) => {
      assets.setAssetTags(String(assetId), Array.isArray(tags) ? tags.map(String) : [])
      return { ok: true }
    }
  },
  {
    name: 'add_asset_from_url',
    description:
      'Download a media URL (image/video/audio) into the project’s asset library. Give it a descriptive name and an AI-facing description.',
    inputSchema: obj(
      {
        projectId: str(),
        url: str('Public URL of the media to download'),
        name: str('Display name (default: URL filename)'),
        description: str('What the media depicts — shown to AIs')
      },
      ['projectId', 'url']
    ),
    mutates: true,
    execute: async ({ projectId, url, name, description }) => {
      const a = await assets.importAssetFromUrl(
        String(projectId),
        String(url),
        name ? String(name) : undefined,
        description ? String(description) : undefined
      )
      return { id: a.id, key: a.key, name: a.name, kind: a.kind }
    }
  },
  {
    name: 'add_asset_from_file',
    description:
      'Import a local media file (absolute path on this machine) into the project’s asset library.',
    inputSchema: obj(
      {
        projectId: str(),
        path: str('Absolute path of the media file'),
        name: str('Display name (default: file name)'),
        description: str('What the media depicts — shown to AIs')
      },
      ['projectId', 'path']
    ),
    mutates: true,
    execute: ({ projectId, path, name, description }) => {
      const a = assets.importAssetFromFile(String(projectId), String(path))
      if (name !== undefined || description !== undefined) {
        assets.updateAsset(a.id, {
          ...(name !== undefined ? { name: String(name) } : {}),
          ...(description !== undefined ? { description: String(description) } : {})
        })
      }
      return { id: a.id, key: a.key, name: name ? String(name) : a.name, kind: a.kind }
    }
  },
  {
    name: 'update_asset',
    description:
      'Update an asset’s name, description and/or design subject. Descriptions are shown to AIs — describe what the media depicts.',
    inputSchema: obj(
      {
        assetId: str(),
        name: str(),
        description: str(),
        designSubject: str('The subject a design sheet was built from (design assets only)')
      },
      ['assetId']
    ),
    mutates: true,
    execute: ({ assetId, name, description, designSubject }) => {
      assets.updateAsset(String(assetId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(designSubject !== undefined ? { designSubject: String(designSubject) } : {})
      })
      return { ok: true }
    }
  },
  {
    name: 'publish_design',
    description:
      'Publish a design node’s successful generation into the project’s asset library as a reusable design sheet (copies the node’s design category and subject). Reuse published sheets across videos instead of regenerating them.',
    inputSchema: obj(
      {
        generationId: str('A successful generation of a design node'),
        name: str('Library display name (e.g. the character’s name)'),
        description: str('What the sheet depicts — shown to AIs')
      },
      ['generationId', 'name']
    ),
    mutates: true,
    execute: async ({ generationId, name, description }) => {
      const a = await assets.promoteGeneration(
        String(generationId),
        String(name),
        description ? String(description) : undefined
      )
      return {
        id: a.id,
        key: a.key,
        name: a.name,
        designId: a.designId,
        designSubject: a.designSubject
      }
    }
  }
]

/** Runs a registry tool by name; mutating tools refresh the app UI. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = AGENT_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  const result = await tool.execute(args)
  if (tool.mutates) broadcastWorkflowChanged(String(args['videoId'] ?? ''))
  return result
}
