import { MODELS } from '@shared/models'
import { getStyle } from '@shared/styles/registry'
import { videoAspectRatioSchema, videoResolutionSchema } from '@shared/ipc/contracts'
import { broadcastFocusNode, broadcastNavigate, broadcastWorkflowChanged } from '../events'
import * as assets from '../services/assets'
import * as generations from '../services/generations'
import * as graph from '../services/graph'
import * as graphHistory from '../services/graphHistory'
import * as projects from '../services/projects'
import { kieGetCredits } from '../services/kie'
import * as renderService from '../services/render'
import { finalizeVideo, planFinalize, startBatch, videoNodeTargets } from '../services/runBatch'
import { cancelGeneration, refreshStatus, runNode } from '../services/runEngine'
import { reviewGeneration } from '../services/qc'
import * as videos from '../services/videos'
import { DOC_TOPICS, getDoc } from './docs'

/**
 * THE agent-facing capability registry (§4.10 phase 3). One entry per
 * capability, executing against the same main-process services as the IPC
 * layer. Both agent surfaces consume it: the MCP server publishes it as-is
 * (explicit ids), the embedded assistant adapts it per session binding
 * (`chatToolAdapter.ts`). Adding a capability to Raccord means adding one
 * entry here, nothing else.
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
 * the CHAT surface requires user approval (`confirm: true` after an action
 * card; MCP clients remain the human's own agent and execute directly);
 * 'spending' = calls kie.ai and costs credits.
 */
export type ToolRisk = 'read' | 'write' | 'destructive' | 'spending'

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  scope: ToolScope
  risk: ToolRisk
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: 'object', properties, required })

const assetRow = (a: {
  id: string
  key: string
  name: string
  kind: string
  description: string | null
  designId: string | null
  designSubject: string | null
}) => ({
  id: a.id,
  key: a.key,
  name: a.name,
  kind: a.kind,
  description: a.description,
  // Set on published design sheets — reference-only, never a frame anchor.
  designId: a.designId,
  designSubject: a.designSubject
})

export const AGENT_TOOLS: AgentTool[] = [
  // ── Documentation (call this first) ────────────────────────────────────────
  {
    name: 'docs',
    description: `Raccord reference documentation, on demand. Topics: ${DOC_TOPICS}. Start with "overview"; read "prompting:<model id>" BEFORE writing prompts for a model.`,
    inputSchema: obj({ topic: str() }, ['topic']),
    scope: 'global',
    risk: 'read',
    execute: ({ topic }) => getDoc(String(topic))
  },
  {
    name: 'list_models',
    description:
      'List every available AI model: id, kind, use-case tags, input handles (name, accepted media, required, reference alias) and parameter fields. Call this before choosing model ids or param names.',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () =>
      MODELS.map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        description: m.description,
        // Declarative use-case tags — match them against the user's brief.
        recommendedFor: m.recommendedFor,
        inputs: m.inputs.map((h) => ({
          key: h.key,
          accepts: h.accepts,
          required: h.required ?? false,
          multiple: h.multiple ?? false,
          referenceAlias: h.referenceAlias
        })),
        outputs: m.outputs.map((o) => o.key),
        paramFields: m.paramFields.map((f) => ({
          key: f.key,
          type: f.type,
          default: f.defaultValue,
          options: f.options?.map((o) => o.value),
          description: f.description
        })),
        promptingNotes: m.promptingNotes,
        // Cheap stand-in used automatically when the video is in draft mode.
        draftEquivalent: m.draftEquivalent?.modelId,
        // Long-form guide served on demand — read it before writing prompts.
        promptGuideTopic: m.promptGuide ? `prompting:${m.id}` : undefined
      }))
  },

  // ── Account ────────────────────────────────────────────────────────────────
  {
    name: 'get_credits',
    description: 'Remaining kie.ai account credits (each generation consumes some).',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: async () => ({ credits: await kieGetCredits() })
  },

  // ── Projects & videos ──────────────────────────────────────────────────────
  {
    name: 'list_projects',
    description: 'List all projects (id, name, timestamps).',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => projects.listProjects()
  },
  {
    name: 'create_project',
    description: 'Create a project. Returns the project row (its "id" is the projectId).',
    inputSchema: obj({ name: str() }, ['name']),
    scope: 'global',
    risk: 'write',
    execute: ({ name }) => projects.createProject(String(name))
  },
  {
    name: 'rename_project',
    description: 'Rename a project.',
    inputSchema: obj({ projectId: str(), name: str() }, ['projectId', 'name']),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, name }) => {
      projects.renameProject(String(projectId), String(name))
      return { ok: true }
    }
  },
  {
    name: 'delete_project',
    description: 'Delete a whole project: its videos, graphs, generations and assets. Destructive.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'destructive',
    execute: ({ projectId }) => {
      projects.deleteProject(String(projectId))
      return { ok: true }
    }
  },
  {
    name: 'list_videos',
    description: 'List the videos (workflow graphs) of a project.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => videos.listVideos(String(projectId))
  },
  {
    name: 'create_video',
    description:
      'Create a video (an empty workflow graph) in a project. Returns the video row (its "id" is the videoId).',
    inputSchema: obj({ projectId: str(), name: str() }, ['projectId', 'name']),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, name }) => videos.createVideo(String(projectId), String(name))
  },
  {
    name: 'rename_video',
    description: 'Rename a video.',
    inputSchema: obj({ videoId: str(), name: str() }, ['videoId', 'name']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, name }) => {
      videos.renameVideo(String(videoId), String(name))
      return { ok: true }
    }
  },
  {
    name: 'delete_video',
    description: 'Delete a video: its whole graph and every generation. Destructive.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'destructive',
    execute: ({ videoId }) => {
      videos.deleteVideo(String(videoId))
      return { ok: true }
    }
  },
  {
    name: 'open_video',
    description:
      "Switch the app window to a video's editor (UI navigation for the human watching).",
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => {
      const video = videos.getVideo(String(videoId))
      if (!video) throw new Error(`Unknown videoId "${String(videoId)}".`)
      broadcastNavigate({ path: `/projects/${video.projectId}/videos/${video.id}` })
      return { ok: true }
    }
  },
  {
    name: 'focus_node',
    description:
      'Center the app editor viewport on a node and select it (visible while the human views that video).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) => {
      const ref = graph.getNodeRef(String(nodeId))
      if (!ref) throw new Error(`Unknown nodeId "${String(nodeId)}".`)
      broadcastFocusNode({ videoId: ref.videoId, nodeId: ref.id })
      return { ok: true }
    }
  },

  // ── Video-level settings ───────────────────────────────────────────────────
  {
    name: 'set_video_style',
    description:
      'Attach a style template (art direction — docs "styles") to a video; its style bible is appended at run time to every visual node whose params carry "applyVideoStyle": true. Empty styleId clears it.',
    inputSchema: obj(
      { videoId: str(), styleId: str('Style id from docs "styles", or "" to clear') },
      ['videoId', 'styleId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, styleId }) => {
      videos.setVideoStyle(String(videoId), styleId ? String(styleId) : null)
      return { ok: true }
    }
  },
  {
    name: 'set_video_defaults',
    description:
      'Set a video’s default aspect ratio / resolution — pre-fills FUTURE nodes only (existing nodes change via apply_video_defaults).',
    inputSchema: obj(
      {
        videoId: str(),
        aspectRatio: {
          type: 'string',
          enum: [...videoAspectRatioSchema.options, ''],
          description: '"" clears the default'
        },
        resolution: {
          type: 'string',
          enum: [...videoResolutionSchema.options, ''],
          description: '"" clears the default'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, aspectRatio, resolution }) => {
      videos.setVideoDefaults(String(videoId), {
        ...(aspectRatio !== undefined
          ? { defaultAspectRatio: aspectRatio ? String(aspectRatio) : null }
          : {}),
        ...(resolution !== undefined
          ? { defaultResolution: resolution ? String(resolution) : null }
          : {})
      })
      return { ok: true }
    }
  },
  {
    name: 'apply_video_defaults',
    description:
      'Apply the video’s default aspect ratio / resolution to every compatible EXISTING node — one journaled sweep, undoable in a single step.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => graph.applyVideoDefaultsToNodes(String(videoId))
  },
  {
    name: 'set_draft_mode',
    description:
      'Toggle a video’s draft mode: while on, every run is substituted with the model’s cheap draft equivalent (5–10× cheaper) and stamped as a draft. Explore in draft, then finalize_video re-runs the keepers on the real models.',
    inputSchema: obj({ videoId: str(), enabled: { type: 'boolean' } }, ['videoId', 'enabled']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, enabled }) => {
      videos.setDraftMode(String(videoId), Boolean(enabled))
      return { ok: true }
    }
  },

  // ── Workflow graph ─────────────────────────────────────────────────────────
  {
    name: 'get_workflow',
    description:
      'Read a video’s graph: active style (art direction), nodes (id, key, modelId, label, intent, params, hasSuccessfulOutput), edges, and the project’s asset library.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => {
      const video = videos.getVideo(String(videoId))
      if (!video) throw new Error(`Unknown videoId "${String(videoId)}".`)
      const { nodes, edges } = graph.listGraph(video.id)
      const gens = generations.listGenerationsForVideo(video.id)
      const style = video.styleId ? getStyle(video.styleId) : undefined
      return {
        // The video's active art direction — appended at run time to prompts of
        // nodes whose params carry applyVideoStyle: true (never baked into prompts).
        style: style
          ? {
              id: style.id,
              label: style.label,
              styleBible: style.styleBible,
              imageFragment: style.imageFragment,
              videoFragment: style.videoFragment,
              musicHint: style.musicHint,
              avoid: style.avoid,
              recommendedParams: style.recommendedParams
            }
          : null,
        defaults: {
          aspectRatio: video.defaultAspectRatio ?? null,
          resolution: video.defaultResolution ?? null
        },
        // §6 iteration loop: cheap-substitution runs / vision checks on settle.
        draftMode: video.draftMode,
        qcEnabled: video.qcEnabled,
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
        })),
        assets: assets.listAssets(video.projectId).map(assetRow)
      }
    }
  },
  {
    name: 'export_workflow',
    description: 'Export a video’s graph as portable workflow JSON (see docs "workflow-json").',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
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
    scope: 'video',
    risk: 'write',
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
    scope: 'video',
    risk: 'write',
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
    scope: 'global',
    risk: 'write',
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
    scope: 'video',
    risk: 'write',
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
    description:
      'Delete a node, its connections and its generations (generations are NOT restored by undo). Destructive.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nodeId }) => {
      graph.removeNode(String(nodeId))
      return { ok: true }
    }
  },
  {
    name: 'undo',
    description: 'Undo the last graph mutation on a video (deleted generations are not restored).',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => graphHistory.undoGraph(String(videoId))
  },
  {
    name: 'redo',
    description: 'Redo the last undone graph mutation on a video.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => graphHistory.redoGraph(String(videoId))
  },

  // ── Generation ─────────────────────────────────────────────────────────────
  {
    name: 'estimate_cost',
    description:
      'Indicative kie.ai credit cost of running a node with its current params (null when unknown).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) => ({ credits: generations.estimateNodeRunCredits(String(nodeId)) })
  },
  {
    name: 'run_node',
    description:
      'Launch a node’s generation (calls kie.ai — COSTS MONEY; upstream inputs must already have outputs). Asynchronous: returns a generationId; completion is reported via get_generations (the embedded assistant is woken automatically instead).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'spending',
    execute: ({ nodeId }) => runNode(String(nodeId))
  },
  {
    name: 'run_batch',
    description:
      'Run several nodes (or every video node) dependency-aware: shared upstreams generate once, independent branches in parallel, already-satisfied nodes are reused. COSTS MONEY. Returns the planned nodes; generations start and settle asynchronously (get_generations per node).',
    inputSchema: obj(
      {
        videoId: str(),
        targetNodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit target nodes (their upstream dependencies run automatically)'
        },
        all_videos: {
          type: 'boolean',
          description: 'Target every video-model node of the graph instead'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'spending',
    execute: ({ videoId, targetNodeIds, all_videos }) => {
      const targets = all_videos
        ? videoNodeTargets(String(videoId))
        : Array.isArray(targetNodeIds)
          ? targetNodeIds.map(String)
          : []
      if (targets.length === 0) {
        throw new Error('Pass targetNodeIds, or all_videos: true on a graph with video nodes.')
      }
      const { planned, done } = startBatch({
        videoId: String(videoId),
        targetNodeIds: targets,
        reuseTargets: true
      })
      void done
      return { planned }
    }
  },
  {
    name: 'finalize_video',
    description:
      'Re-run every node whose selected generation is a draft on the REAL models (COSTS MONEY — draft substitution bypassed) and promote each result to the node’s selection. Pass plan_only: true to get the draft-vs-final cost preview without running anything.',
    inputSchema: obj(
      {
        videoId: str(),
        plan_only: { type: 'boolean', description: 'Only return the cost preview' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'spending',
    execute: ({ videoId, plan_only }) => {
      const plan = planFinalize(String(videoId))
      if (plan_only || plan.rows.length === 0) return plan
      const { planned, done } = finalizeVideo(String(videoId))
      void done
      return { planned }
    }
  },
  {
    name: 'review_generation',
    description:
      'Vision QC on a successful image generation: does it fulfill the prompt, any defects, consistent with its wired reference sheets? Verdict pass/warn + notes, persisted on the generation. Costs a small amount of credits.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'spending',
    execute: ({ generationId }) => reviewGeneration(String(generationId))
  },
  {
    name: 'get_generations',
    description:
      'List a node’s generations: status (pending/running/success/failed), media URL, draft flag, vision-QC verdict, error.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) =>
      generations.listGenerationsForNode(String(nodeId)).map((g) => ({
        id: g.id,
        status: g.status,
        url: g.resultUrl,
        draft: g.draft ?? false,
        qcVerdict: g.qcVerdict,
        qcNotes: g.qcNotes,
        error: g.errorMessage,
        createdAt: g.createdAt
      }))
  },
  {
    name: 'select_generation',
    description:
      'Mark one of a node’s successful generations as its output ("Use this"); "" resets to the newest.',
    inputSchema: obj(
      { nodeId: str(), generationId: str('A generation of this node, or "" to reset') },
      ['nodeId', 'generationId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, generationId }) => {
      graph.setSelectedGeneration(String(nodeId), generationId ? String(generationId) : null)
      return { ok: true }
    }
  },
  {
    name: 'cancel_generation',
    description: 'Cancel a node’s in-flight generation (queued or polling). No smart retry after.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId }) => cancelGeneration(String(nodeId))
  },
  {
    name: 'refresh_generation_status',
    description:
      'Force one immediate status poll of a node’s latest generation (instead of waiting for the next scheduled poll).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId }) => refreshStatus(String(nodeId))
  },
  {
    name: 'render_video',
    description:
      'Render a video’s timeline into a single MP4 file (local ffmpeg, no credits): clips concatenated in shot order, music lane muxed over. Synchronous — returns the output path.',
    inputSchema: obj(
      { videoId: str(), outputPath: str('Absolute .mp4 destination (default: Downloads folder)') },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
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
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => assets.listAssets(String(projectId)).map(assetRow)
  },
  {
    name: 'search_assets',
    description:
      'Search a project’s assets by name, key, description or tag (accent-insensitive, AND terms).',
    inputSchema: obj({ projectId: str(), query: str('Search terms') }, ['projectId', 'query']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId, query }) =>
      assets
        .searchAssets(String(projectId), String(query))
        .map((a) => ({ ...assetRow(a), tags: a.tags }))
  },
  {
    name: 'set_asset_tags',
    description: 'Replace an asset’s tags (labels used to filter the library).',
    inputSchema: obj({ assetId: str(), tags: { type: 'array', items: { type: 'string' } } }, [
      'assetId',
      'tags'
    ]),
    scope: 'global',
    risk: 'write',
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
    scope: 'project',
    risk: 'write',
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
    scope: 'project',
    risk: 'write',
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
    scope: 'global',
    risk: 'write',
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
    name: 'delete_asset',
    description:
      'Delete an asset from the project library (studio/asset nodes referencing it lose their media). Destructive.',
    inputSchema: obj({ assetId: str() }, ['assetId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ assetId }) => {
      assets.deleteAsset(String(assetId))
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
    scope: 'global',
    risk: 'write',
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
