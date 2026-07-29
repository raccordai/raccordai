import { MODELS } from '@shared/models'
import { MAX_VARIANTS } from '@shared/config'
import { getStyle } from '@shared/styles/registry'
import { videoAspectRatioSchema, videoResolutionSchema } from '@shared/ipc/contracts'
import { SCREEN_DIRECTIONS, planScenario, type ScenarioBeat } from '@shared/scenario'
import { broadcastFocusNode, broadcastNavigate, broadcastWorkflowChanged } from '../events'
import * as assets from '../services/assets'
import * as generations from '../services/generations'
import * as graph from '../services/graph'
import * as graphHistory from '../services/graphHistory'
import { createEditNodeFromAnnotations, listAnnotations } from '../services/annotations'
import { linkShots } from '../services/continuity'
import {
  castRole,
  createCasting,
  deleteCasting,
  listCastings,
  planCastRole,
  updateCasting
} from '../services/casting'
import {
  createCheckpoint,
  diffAgainstCurrent,
  listCheckpoints,
  restoreCheckpoint
} from '../services/checkpoints'
import { lintNodeById } from '../services/lint'
import { createRecipeNode } from '../services/recipes'
import * as projects from '../services/projects'
import { kieGetCredits } from '../services/kie'
import * as renderService from '../services/render'
import { finalizeVideo, planFinalize, startBatch, videoNodeTargets } from '../services/runBatch'
import { cancelGeneration, refreshStatus, runNode } from '../services/runEngine'
import { clampVariants } from '../services/runPlanner'
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
 * the CHAT surface always requires user approval (`confirm: true` after an
 * action card); 'spending' = calls kie.ai and costs credits, gated the same
 * way while the `assistantRunApproval` setting is 'ask' (the default).
 * MCP clients remain the human's own agent and execute directly either way.
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
          maxCount: h.maxCount,
          // Combined-length budget across the handle (Seedance 2: 15 s).
          maxTotalSeconds: h.maxTotalSeconds,
          // The frame-anchor vs reference distinction, machine-readable.
          frameAnchor: h.frameAnchor ?? false,
          referenceAlias: h.referenceAlias
        })),
        outputs: m.outputs.map((o) => o.key),
        paramFields: m.paramFields.map((f) => ({
          key: f.key,
          type: f.type,
          default: f.defaultValue,
          options: f.options?.map((o) => o.value),
          // Numeric bounds are a hard API contract (a Seedance clip cannot be
          // shorter than 4 s) — without them here an agent has no way to know.
          min: f.min,
          max: f.max,
          step: f.step,
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
        // §6.7 — the shot list this graph is meant to realize. Summary only:
        // get_scenario returns the shots with their prompt scaffolds.
        scenario: video.scenario
          ? {
              brief: video.scenario.brief,
              shotCount: video.scenario.shots.length,
              totalSeconds: video.scenario.totalSeconds,
              warnings: video.scenario.warnings.length
            }
          : null,
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
    name: 'write_scenario',
    description:
      'Turn a brief into the video\'s scenario, BEFORE present_plan: you write the beats, it returns shots with durations the model accepts, chained by their opening/closing frames, each carrying a promptScaffold to write the shot prompt on top of. Always report its `warnings` to the user — stretched or merged beats, a total that drifts from the brief, a cut with no exit frame. Details: docs "scenario".',
    inputSchema: obj(
      {
        videoId: str(),
        brief: str('The user’s brief, verbatim — what the film has to deliver'),
        modelId: str('Video model the shot durations must be legal for'),
        targetSeconds: {
          type: 'number',
          description: 'Total length the brief asks for, when it names one'
        },
        shortBeatPolicy: {
          type: 'string',
          enum: ['stretch', 'merge'],
          description:
            'Beats under the model floor: "stretch" (default) runs them at the floor and keeps the cut list; "merge" folds them into a neighbour and keeps the film length.'
        },
        beats: {
          type: 'array',
          description: 'The script, in order.',
          items: {
            type: 'object',
            properties: {
              title: str('Short beat title, e.g. "Le départ"'),
              action: str('What happens — the raw material of the shot prompt'),
              seconds: { type: 'number', description: 'Length the script asks for' },
              camera: str('Camera intent, e.g. "low-angle tracking"'),
              sound: str('Dialogue and sound design'),
              opensOn: str('Frame this beat opens on (derived from the previous one if omitted)'),
              closesOn: str('Frame this beat closes on — what the NEXT shot opens on'),
              screenDirection: {
                type: 'string',
                enum: [...SCREEN_DIRECTIONS],
                description: 'Which way the subject travels — continuity across the cut'
              },
              boardDriven: {
                type: 'boolean',
                description: 'True if a storyboard/shot board will be wired on this shot'
              },
              mergeWithNext: {
                type: 'boolean',
                description: 'Fold this beat into the next one whatever the policy'
              }
            },
            required: ['title', 'action', 'seconds']
          }
        }
      },
      ['videoId', 'brief', 'modelId', 'beats']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, brief, modelId, targetSeconds, shortBeatPolicy, beats }) => {
      const scenario = planScenario({
        brief: String(brief),
        modelId: String(modelId),
        ...(typeof targetSeconds === 'number' ? { targetSeconds } : {}),
        ...(shortBeatPolicy === 'merge' || shortBeatPolicy === 'stretch'
          ? { shortBeatPolicy }
          : {}),
        beats: (Array.isArray(beats) ? beats : []) as ScenarioBeat[]
      })
      videos.setVideoScenario(String(videoId), scenario)
      return scenario
    }
  },
  {
    name: 'get_scenario',
    description:
      "The video's scenario: the shot list, each shot's legal duration, its opening and closing frames, and the promptScaffold to write its prompt on top of. Null when none was written yet.",
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => videos.getVideoScenario(String(videoId))
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
        x: {
          type: 'number',
          description:
            'Canvas x. Omit BOTH x and y to drop the node in the next free slot — never pass 0/0 to mean "anywhere", it stacks nodes on top of each other. Left-to-right flow: 0, 420, 840…'
        },
        y: { type: 'number', description: 'Canvas y. Rows are spaced ~350 apart.' }
      },
      ['videoId', 'modelId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, modelId, label, intent, params, x, y }) =>
      graph.createNode({
        videoId: String(videoId),
        modelId: String(modelId),
        ...(x === undefined && y === undefined
          ? {}
          : { position: { x: Number(x ?? 0), y: Number(y ?? 0) } }),
        label: label ? String(label) : undefined,
        intent: intent ? String(intent) : undefined,
        params
      })
  },
  {
    name: 'add_recipe_node',
    description:
      'Create a PRE-CONFIGURED node from a recipe: a design sheet (docs "designs") or a shot preset (docs "shots"). Builds the prompt for the model and the video’s style, sets the markers, and wires the source of a from-image/from-video mode in ONE undo step. Prefer it over add_node whenever a recipe fits.',
    inputSchema: obj(
      {
        videoId: str(),
        recipeId: str('Recipe id — docs "designs" / docs "shots"'),
        modeId: str(
          '"text" (default), "from-image" or "from-video" — a source mode needs `source`'
        ),
        modelId: str('Override the mode’s model; must be one of the recipe’s supported models'),
        values: {
          type: 'object',
          description:
            'Field values keyed by field id, e.g. {"description":"Léa, pink hair","views":"turnaround"}. "description" is required; unknown keys are ignored and blank selects fall back to their default.'
        },
        source: {
          type: 'object',
          description:
            'The media a from-image/from-video mode is built on: {"assetId"} (a library asset — an asset node is created and wired) or {"nodeId"} (an existing node of this video).',
          properties: { assetId: str(), nodeId: str() }
        },
        x: { type: 'number', description: 'Canvas x. Omit BOTH x and y for the next free slot.' },
        y: { type: 'number', description: 'Canvas y.' }
      },
      ['videoId', 'recipeId', 'values']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, recipeId, modeId, modelId, values, source, x, y }) => {
      const raw = (values ?? {}) as Record<string, unknown>
      const src = (source ?? {}) as { assetId?: unknown; nodeId?: unknown }
      return createRecipeNode({
        videoId: String(videoId),
        recipeId: String(recipeId),
        ...(modeId === undefined ? {} : { modeId: String(modeId) }),
        ...(modelId === undefined ? {} : { modelId: String(modelId) }),
        values: Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [key, value == null ? '' : String(value)])
        ),
        ...(src.assetId || src.nodeId
          ? {
              source: {
                ...(src.assetId ? { assetId: String(src.assetId) } : {}),
                ...(src.nodeId ? { nodeId: String(src.nodeId) } : {})
              }
            }
          : {}),
        ...(x === undefined && y === undefined
          ? {}
          : { position: { x: Number(x ?? 0), y: Number(y ?? 0) } })
      })
    }
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
    name: 'link_shots',
    description:
      'Chain shots for continuity: each clip becomes an @Video reference on the NEXT shot (same look, wardrobe, set, grade), role sentence appended to its prompt, one undo step. It serializes the batch and a re-roll invalidates the shots after it — propose it, never apply it by default. Cuts it cannot wire come back in "skipped". NOT lastFrame chaining. Details: docs "continuity".',
    inputSchema: obj(
      {
        videoId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Video shot node ids IN TIMELINE ORDER (at least two).'
        }
      },
      ['videoId', 'nodeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, nodeIds }) =>
      linkShots(String(videoId), (Array.isArray(nodeIds) ? nodeIds : []).map(String))
  },
  {
    name: 'list_castings',
    description:
      'The project’s cast: the named identities of the film ("Léa" = this published sheet) with their subject and standing notes. Check it BEFORE generating a sheet for a character/décor/prop that already has a role.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) =>
      listCastings(String(projectId)).map((c) => ({
        id: c.id,
        name: c.name,
        assetId: c.assetId,
        sheet: c.assetName,
        designId: c.designId,
        subject: c.designSubject,
        notes: c.notes
      }))
  },
  {
    name: 'create_casting',
    description:
      'Name a published design sheet as a role of the film ("Léa is this character sheet"), project-wide. Do it once the user approves a sheet — the name is what later prompts carry. Notes are standing direction folded into every role sentence.',
    inputSchema: obj(
      {
        projectId: str(),
        name: str('The name the film calls this role, e.g. "Léa" — unique in the project.'),
        assetId: str('A published design sheet of the project (image asset).'),
        notes: str('Standing direction, e.g. "always wears the red scarf".')
      },
      ['projectId', 'name', 'assetId']
    ),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, name, assetId, notes }) =>
      createCasting({
        projectId: String(projectId),
        name: String(name),
        assetId: String(assetId),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'update_casting',
    description:
      'Rename a role, re-point it at a regenerated sheet, or change its standing notes. Re-pointing does NOT rewire the shots already cast — re-run cast_role for that.',
    inputSchema: obj({ castingId: str(), name: str(), assetId: str(), notes: str() }, [
      'castingId'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ castingId, name, assetId, notes }) =>
      updateCasting(String(castingId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(assetId !== undefined ? { assetId: String(assetId) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'cast_role',
    description:
      'Cast a role onto a video: its sheet is wired as a reference on every shot and its identity sentence written into each prompt, in ONE undo step. Idempotent — a second call reports "alreadyCast" instead of double-wiring. Shots it cannot wire come back in "skipped". Pass plan_only first to show the user what it would touch. Details: docs "casting".',
    inputSchema: obj(
      {
        videoId: str(),
        castingId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Defaults to every shot of the video. Name stills explicitly (a storyboard).'
        },
        plan_only: {
          type: 'boolean',
          description: 'Dry run: report what would be wired without touching the graph.'
        }
      },
      ['videoId', 'castingId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, castingId, nodeIds, plan_only }) => {
      const args = {
        videoId: String(videoId),
        castingId: String(castingId),
        ...(Array.isArray(nodeIds) ? { nodeIds: nodeIds.map(String) } : {})
      }
      return plan_only === true ? planCastRole(args) : castRole(args)
    }
  },
  {
    name: 'remove_casting',
    description:
      'Forget a role. Shots already cast keep their reference and their prompt — this only removes the name from the project’s cast.',
    inputSchema: obj({ castingId: str() }, ['castingId']),
    scope: 'global',
    risk: 'write',
    execute: ({ castingId }) => {
      deleteCasting(String(castingId))
      return { ok: true }
    }
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
  // ── §6.4 checkpoints ───────────────────────────────────────────────────────
  {
    name: 'create_checkpoint',
    description:
      'Capture the video’s graph under a name (nodes, edges, params and the selected output per node) so a risky change can be walked back. Free.',
    inputSchema: obj({ videoId: str(), name: str('Short name, e.g. "before restructuring"') }, [
      'videoId',
      'name'
    ]),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, name }) => createCheckpoint(String(videoId), String(name))
  },
  {
    name: 'list_checkpoints',
    description: 'List the video’s checkpoints (newest first): id, name, node count, date.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listCheckpoints(String(videoId))
  },
  {
    name: 'diff_checkpoint',
    description:
      'What restoring a checkpoint would change: nodes added/removed, params (prompt first) and labels changed, edges added/removed, selected outputs changed. Free — read this before proposing a restore.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'read',
    execute: ({ checkpointId }) => diffAgainstCurrent(String(checkpointId))
  },
  {
    name: 'restore_checkpoint',
    description:
      'Roll the graph back to a checkpoint (ONE undo step). Nodes created since are deleted with their generations; outputs deleted since are not resurrected.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ checkpointId }) => restoreCheckpoint(String(checkpointId))
  },

  // ── §6.3 regional feedback ────────────────────────────────────────────────
  {
    name: 'get_annotations',
    description:
      'The user’s notes on one generation: a region of the frame or a timecode, plus what they said is wrong. This is their judgment — read it before proposing a fix.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'read',
    execute: ({ generationId }) => listAnnotations(String(generationId))
  },
  {
    name: 'create_edit_node',
    description:
      'Build the fix node from a generation’s notes: a gpt-image-2-image-to-image node wired to it, prompt composed from the regions and comments (image outputs only — for a clip, use the notes to rewrite the shot prompt). Creates nothing else and runs nothing.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId }) => createEditNodeFromAnnotations(String(generationId))
  },
  {
    name: 'lint_node',
    description:
      'Check a node BEFORE running it: empty prompt, missing required input, reference wired but never addressed in the prompt, design sheet on a frame anchor, storyboard shot without the anti-grid guard, param outside the model’s enums or numeric bounds (a clip shorter than the model accepts), reference handle over its combined-length budget. Free — no kie.ai call.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) => {
      const findings = lintNodeById(String(nodeId))
      return {
        ok: findings.length === 0,
        findings: findings.map((f) => ({
          rule: f.rule,
          severity: f.severity,
          message: f.message,
          subject: f.subject ?? null,
          // The fix an agent can apply itself (update_node / connect_nodes).
          fix: f.fix ?? null
        }))
      }
    }
  },
  {
    name: 'run_node',
    description:
      'Launch a node’s generation (calls kie.ai — COSTS MONEY; upstream inputs must already have outputs). Asynchronous: returns a generationId; completion is reported via get_generations (the embedded assistant is woken automatically instead). Pass variants: N to explore N parallel candidates of the SAME node (cost ×N) and let the user pick.',
    inputSchema: obj(
      {
        nodeId: str(),
        variants: {
          type: 'number',
          description: `Parallel candidates to generate for this node (1–${MAX_VARIANTS}, default 1 — the cost is multiplied accordingly)`
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'spending',
    execute: ({ nodeId, variants }) =>
      runNode(String(nodeId), false, { variants: clampVariants(variants ?? 1) })
  },
  {
    name: 'run_batch',
    description:
      'Run several nodes (or every video node) dependency-aware: shared upstreams generate once, independent branches in parallel, already-satisfied nodes are reused. COSTS MONEY. Returns the planned nodes; generations start and settle asynchronously (get_generations per node). variants: N generates N candidates per TARGET (dependencies still run once).',
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
        },
        variants: {
          type: 'number',
          description: `Parallel candidates per target node (1–${MAX_VARIANTS}, default 1 — the cost is multiplied accordingly)`
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'spending',
    execute: ({ videoId, targetNodeIds, all_videos, variants }) => {
      const targets = all_videos
        ? videoNodeTargets(String(videoId))
        : Array.isArray(targetNodeIds)
          ? targetNodeIds.map(String)
          : []
      if (targets.length === 0) {
        throw new Error('Pass targetNodeIds, or all_videos: true on a graph with video nodes.')
      }
      const count = clampVariants(variants ?? 1)
      const { planned, done } = startBatch({
        videoId: String(videoId),
        targetNodeIds: targets,
        // Exploring variants means regenerating on purpose — reusing the
        // satisfied target would return zero candidates.
        reuseTargets: count === 1,
        variants: count
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
