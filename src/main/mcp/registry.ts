import { MODELS } from '@shared/models'
import { MAX_VARIANTS } from '@shared/config'
import { getStyle } from '@shared/styles/registry'
import { videoAspectRatioSchema, videoResolutionSchema } from '@shared/ipc/contracts'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import { CAPTION_PRESET_IDS, isCaptionPresetId } from '@shared/captions'
import { CLIP_LOOK_IDS } from '@shared/looks'
import { STILL_MOTION_IDS } from '@shared/stillMotion'
import { TEXT_ANIMATION_IDS, isTextAnimationId } from '@shared/textAnimations'
import { SCREEN_DIRECTIONS, planScenario, type ScenarioBeat } from '@shared/scenario'
import { broadcastFocusNode, broadcastNavigate, broadcastWorkflowChanged } from '../events'
import * as assets from '../services/assets'
import * as generations from '../services/generations'
import * as graph from '../services/graph'
import * as graphHistory from '../services/graphHistory'
import {
  addAnnotation,
  createEditNodeFromAnnotations,
  deleteAnnotation,
  listAnnotations
} from '../services/annotations'
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
  deleteCheckpoint,
  diffAgainstCurrent,
  listCheckpoints,
  restoreCheckpoint
} from '../services/checkpoints'
import { lintNodeById } from '../services/lint'
import {
  createTextLayer,
  deleteTextLayer,
  listTextLayers,
  updateTextLayer
} from '../services/textLayers'
import {
  createImageLayer,
  deleteImageLayer,
  listImageLayers,
  updateImageLayer
} from '../services/imageLayers'
import {
  createFeedbackItem,
  deleteFeedbackItem,
  listFeedback,
  updateFeedbackItem
} from '../services/feedback'
import { getTimelineInfo } from '../services/timelineInfo'
import { waitForGenerations } from '../services/generationWait'
import { generationMediaPreview } from '../services/mediaPreview'

import { createRecipeNode } from '../services/recipes'
import { elevenlabsListVoices } from '../services/elevenlabs'
import {
  createVoicePersona,
  deleteVoicePersona,
  listVoicePersonas,
  updateVoicePersona
} from '../services/voicePersonas'
import { formatTranscript, type SpeechTranscript } from '@shared/speech'
import * as scenarioGraph from '../services/scenarioGraph'
import * as projects from '../services/projects'
import { kieGetCredits } from '../services/kie'
import * as renderService from '../services/render'
import { finalizeVideo, planFinalize, startBatch, videoNodeTargets } from '../services/runBatch'
import * as niches from '../services/niches'
import { fetchSearchSuggestions } from '../services/youtubeApi'
import {
  analyzeSerpOpportunity,
  channelRatioSignal,
  combineSignals,
  nicheRatio,
  ratioSignal,
  SP_PRESETS
} from '@shared/niches'
import {
  cancelGeneration,
  dequeueGeneration,
  queueState,
  refreshStatus,
  runNode
} from '../services/runEngine'
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
  {
    name: 'project_credits_usage',
    description: 'Estimated kie.ai credits already spent by a project’s generations.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => generations.projectCreditsUsage(String(projectId))
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
    name: 'get_project_instructions',
    description:
      "The project's Instructions: the user's methodology (markdown) that every video of the project must follow. Read it before planning work in a project whose instructions you have not seen this conversation.",
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => ({
      instructions: projects.getProject(String(projectId))?.instructions ?? null
    })
  },
  {
    name: 'set_project_instructions',
    description:
      "Replace the project's Instructions (full-replacement markdown; empty string clears). Only when the user asks to save or change their per-project methodology.",
    inputSchema: obj(
      { projectId: str(), instructions: str('Full replacement markdown; empty string clears.') },
      ['projectId', 'instructions']
    ),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, instructions }) => {
      projects.setProjectInstructions(String(projectId), String(instructions))
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
  {
    name: 'set_qc_enabled',
    description:
      'Toggle a video’s vision QC: while on, every successful image generation gets one cheap automated review (verdict in get_generations and in the settle wake-up).',
    inputSchema: obj({ videoId: str(), enabled: { type: 'boolean' } }, ['videoId', 'enabled']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, enabled }) => {
      videos.setQcEnabled(String(videoId), Boolean(enabled))
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
        // The project's methodology exists — read it with get_project_instructions
        // before planning work when true.
        hasProjectInstructions: Boolean(projects.getProject(video.projectId)?.instructions),
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
          // Timeline editing state (set_timeline_order / set_clip_trim /
          // set_clip_transition / set_clip_overlay).
          timelineOrder: n.timelineOrder ?? null,
          trimStartSec: n.trimStartSec ?? null,
          trimEndSec: n.trimEndSec ?? null,
          transitionAfter: n.transitionAfter ?? null,
          transitionDurationSec: n.transitionDurationSec ?? null,
          // Split clip (§6.12e): non-null once split_clip ran — each segment
          // has its own trim/transition, addressed by segmentIndex.
          segments: n.segments ?? null,
          overlay: n.overlay ?? null,
          // Baked per-clip effects + audio placement — what set_clip_speed /
          // set_clip_look / set_still_motion / set_clip_volume /
          // set_audio_offset wrote (null = untouched). get_timeline returns
          // the RESOLVED placement these produce.
          speed: n.speed ?? null,
          look: n.look ?? null,
          stillMotion: n.stillMotion ?? null,
          volume: n.volume ?? null,
          timelineOffsetSec: n.timelineOffsetSec ?? null,
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
    name: 'get_timeline',
    description:
      'The RESOLVED timeline in FINAL-timeline seconds (media probed for real durations): each clip entry’s start/end/duration (trims, speed and transition overlaps applied), the film’s totalSeconds, and the music/speech lanes with each track’s computed start. This is how you know where shot N starts before syncing audio with set_audio_offset or placing text/image layers.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => getTimelineInfo(String(videoId))
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
              roles: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Cast roles appearing in this beat, by name (list_castings). WHO is in a shot cannot be derived from the script — name them here and build_graph_from_scenario wires each sheet on exactly the shots it belongs to.'
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
    name: 'build_graph_from_scenario',
    description:
      'Realize the video’s scenario as a graph: one shot-preset node per shot, camera move read from the shot’s own `camera` line, duration, frames and screen direction filled in, and the scenario’s roles cast onto the shots naming them — ONE undo step. Prefer it to hand-writing an import_workflow. Re-running only adds new shots; plan_only is free. Details: docs "scenario".',
    inputSchema: obj(
      {
        videoId: str(),
        shotKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scenario shot keys to build. Defaults to every shot not built yet.'
        },
        plan_only: {
          type: 'boolean',
          description: 'Dry run: report what would be created without touching the graph.'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, shotKeys, plan_only }) => {
      const args = {
        videoId: String(videoId),
        ...(Array.isArray(shotKeys) ? { shotKeys: shotKeys.map(String) } : {})
      }
      return plan_only === true
        ? scenarioGraph.planScenarioGraph(args)
        : scenarioGraph.buildGraphFromScenario(args)
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
    name: 'update_node_position',
    description:
      'Move a node on the canvas (left-to-right flow, x: 0, 420, 840…, y spaced ~350). get_workflow returns the current positions.',
    inputSchema: obj(
      {
        nodeId: str(),
        position: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y'])
      },
      ['nodeId', 'position']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, position }) => {
      const p = position as { x?: unknown; y?: unknown }
      graph.updateNodePosition(String(nodeId), { x: Number(p?.x ?? 0), y: Number(p?.y ?? 0) })
      return { ok: true }
    }
  },
  {
    name: 'set_timeline_order',
    description:
      'Set the timeline order of a video’s clips explicitly (one undo step). Pass ALL clip node ids in the desired sequence — playback, FCPXML and MP4 render follow it. Image/asset node ids may be included: they become STILL slots (5 s default, duration = trim window via set_clip_trim); a still left out of the list is removed from the timeline.',
    inputSchema: obj(
      {
        videoId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every video clip node id, in timeline order.'
        }
      },
      ['videoId', 'nodeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, nodeIds }) => {
      graph.setTimelineOrder(String(videoId), (Array.isArray(nodeIds) ? nodeIds : []).map(String))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_trim',
    description:
      'Trim a clip on the timeline: in/out points in seconds within its media (null clears a bound). Applies to playback, FCPXML and the MP4 render — the generation itself is untouched, so a trim is always reversible. Works on audio nodes too, and on a STILL slot the window IS its hold time (e.g. trimEndSec 8 = 8 s on screen).',
    inputSchema: obj(
      {
        nodeId: str(),
        trimStartSec: { type: ['number', 'null'], description: 'In-point (≥ 0), null = start' },
        trimEndSec: { type: ['number', 'null'], description: 'Out-point (> in), null = end' },
        segmentIndex: {
          type: 'number',
          description: 'On a SPLIT clip: which segment to trim (see get_workflow segments)'
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, trimStartSec, trimEndSec, segmentIndex }) => {
      graph.setClipTrim(
        String(nodeId),
        {
          trimStartSec: trimStartSec == null ? null : Number(trimStartSec),
          trimEndSec: trimEndSec == null ? null : Number(trimEndSec)
        },
        segmentIndex == null ? undefined : Number(segmentIndex)
      )
      return { ok: true }
    }
  },
  {
    name: 'split_clip',
    description:
      'Razor: cut a video clip in two at a MEDIA-time point (seconds inside the clip’s media, ≥0.2 s from each edge). The halves stay adjacent, each with its own trim/transition (see get_workflow segments; edit them via set_clip_trim/set_clip_transition with segmentIndex). One undo step.',
    inputSchema: obj(
      {
        nodeId: str(),
        atMediaSec: { type: 'number', description: 'Cut point in MEDIA seconds' }
      },
      ['nodeId', 'atMediaSec']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, atMediaSec }) => {
      graph.splitClip(String(nodeId), Number(atMediaSec))
      return { ok: true }
    }
  },
  {
    name: 'remove_clip_segment',
    description:
      'Remove ONE segment of a split clip (e.g. cut out the middle after two split_clip calls). The last two segments collapse back into a plain clip. The node and its generations are untouched.',
    inputSchema: obj(
      {
        nodeId: str(),
        segmentIndex: { type: 'number', description: '0-based segment to remove' }
      },
      ['nodeId', 'segmentIndex']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, segmentIndex }) => {
      graph.removeClipSegment(String(nodeId), Number(segmentIndex))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_transition',
    description:
      'Set the transition from a clip INTO the next one at render time, or null for a plain cut (the default and the doctrine’s preference). Each transition overlaps the two clips by durationSec (default 0.5 s) and shortens the film accordingly. The library ids are the `transition` enum values.',
    inputSchema: obj(
      {
        nodeId: str(),
        transition: { type: ['string', 'null'], enum: [...CLIP_TRANSITION_IDS, null] },
        durationSec: { type: 'number', description: 'Overlap length, 0.1–2 s (default 0.5)' },
        segmentIndex: {
          type: 'number',
          description: 'On a SPLIT clip: which segment’s outgoing cut (default: the last)'
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, transition, durationSec, segmentIndex }) => {
      graph.setClipTransition(
        String(nodeId),
        transition == null ? null : String(transition),
        durationSec == null ? null : Number(durationSec),
        segmentIndex == null ? undefined : Number(segmentIndex)
      )
      return { ok: true }
    }
  },
  {
    name: 'set_clip_overlay',
    description:
      'Burn a text layer over a clip at render time (title card, caption, credit): text + numpad alignment (1–9, e.g. 8 = top center, 2 = bottom center) + size (sm/md/lg). Null clears it. Preview shows it in the timeline player.',
    inputSchema: obj(
      {
        nodeId: str(),
        overlay: {
          type: ['object', 'null'],
          properties: {
            text: { type: 'string' },
            align: { type: 'number', description: 'ASS numpad alignment 1–9' },
            size: { type: 'string', enum: ['sm', 'md', 'lg'] }
          },
          required: ['text', 'align', 'size']
        }
      },
      ['nodeId', 'overlay']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, overlay }) => {
      const o = overlay as { text?: unknown; align?: unknown; size?: unknown } | null
      graph.setClipOverlay(
        String(nodeId),
        o == null
          ? null
          : {
              text: String(o.text ?? ''),
              align: Math.min(9, Math.max(1, Number(o.align ?? 2))),
              size: o.size === 'sm' || o.size === 'lg' ? o.size : 'md'
            }
      )
      return { ok: true }
    }
  },
  {
    name: 'set_clip_volume',
    description:
      'Volume gain of an audio track on the timeline (music/speech lanes): 1 = original, 0–2 (e.g. 0.5 = half, 2 = double). Null resets. Applies to the preview player and the MP4 render (per-track ffmpeg volume).',
    inputSchema: obj(
      {
        nodeId: str(),
        volume: { type: ['number', 'null'], description: 'Gain 0–2, null = original (1)' }
      },
      ['nodeId', 'volume']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, volume }) => {
      graph.setClipVolume(String(nodeId), volume == null ? null : Number(volume))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_speed',
    description:
      'Playback speed of a video clip on the timeline: 1 = original, 0.25–4 (0.5 = slow motion, 2 = twice as fast). Null resets. The rendered slot lasts trimmed duration ÷ speed; audio follows (pitch-corrected atempo). Preview plays at the same rate.',
    inputSchema: obj(
      {
        nodeId: str(),
        speed: { type: ['number', 'null'], description: 'Factor 0.25–4, null = original (1)' }
      },
      ['nodeId', 'speed']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, speed }) => {
      graph.setClipSpeed(String(nodeId), speed == null ? null : Number(speed))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_look',
    description:
      'Colour look baked on a clip at render time (the `look` enum lists the library: warm, cool, faded, vivid, mono, noir, vintage). Null removes it. The timeline player previews a CSS approximation live.',
    inputSchema: obj(
      {
        nodeId: str(),
        look: { type: ['string', 'null'], enum: [...CLIP_LOOK_IDS, null] }
      },
      ['nodeId', 'look']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, look }) => {
      graph.setClipLook(String(nodeId), look == null ? null : String(look))
      return { ok: true }
    }
  },
  {
    name: 'set_still_motion',
    description:
      'Ken Burns motion on a STILL timeline slot (image/asset node placed via set_timeline_order): zoom-in, zoom-out, pan-left or pan-right instead of a frozen frame. Null = static. Applied at render (zoompan).',
    inputSchema: obj(
      {
        nodeId: str(),
        motion: { type: ['string', 'null'], enum: [...STILL_MOTION_IDS, null] }
      },
      ['nodeId', 'motion']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, motion }) => {
      graph.setStillMotion(String(nodeId), motion == null ? null : String(motion))
      return { ok: true }
    }
  },
  {
    name: 'set_audio_offset',
    description:
      'Absolute start of an AUDIO track on the final timeline (seconds). Null restores the default layout (chained after the previous lane track). Overlapping tracks of a lane simply mix. Preview and MP4 render follow the same placement. Read get_timeline first for where the clips start (docs "timeline" for the sync method).',
    inputSchema: obj(
      {
        nodeId: str(),
        offsetSec: { type: ['number', 'null'], description: 'Start in seconds (≥ 0), null = chain' }
      },
      ['nodeId', 'offsetSec']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, offsetSec }) => {
      graph.setTimelineOffset(String(nodeId), offsetSec == null ? null : Number(offsetSec))
      return { ok: true }
    }
  },
  {
    name: 'list_image_layers',
    description:
      'The video’s sticker track: image overlays composited over the film at render time — timing (absolute FINAL-timeline seconds), normalized center position, width as % of the output width, and the image source (an image node’s output or a project asset).',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listImageLayers(String(videoId))
  },
  {
    name: 'add_image_layer',
    description:
      'Add a sticker (image overlay) to the video: pass nodeId (an image node — its best generation is composited) OR assetId (a project asset), never both. Position is the sticker’s CENTER (x/y normalized 0–1); widthPct sizes it as % of the output width.',
    inputSchema: obj(
      {
        videoId: str(),
        nodeId: str('Image node id (exactly one of nodeId/assetId)'),
        assetId: str('Project asset id (exactly one of nodeId/assetId)'),
        startSec: { type: 'number', description: 'Start, in FINAL-timeline seconds' },
        endSec: { type: 'number', description: 'End, in FINAL-timeline seconds (> start)' },
        x: { type: 'number', description: 'Center x, 0–1 (default 0.5)' },
        y: { type: 'number', description: 'Center y, 0–1 (default 0.5)' },
        widthPct: { type: 'number', description: '% of output width, 1–100 (default 25)' }
      },
      ['videoId', 'startSec', 'endSec']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createImageLayer({
        videoId: String(args['videoId']),
        startSec: Number(args['startSec']),
        endSec: Number(args['endSec']),
        ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
        ...(args['assetId'] !== undefined ? { assetId: String(args['assetId']) } : {}),
        ...(args['x'] !== undefined ? { x: Number(args['x']) } : {}),
        ...(args['y'] !== undefined ? { y: Number(args['y']) } : {}),
        ...(args['widthPct'] !== undefined ? { widthPct: Number(args['widthPct']) } : {})
      })
  },
  {
    name: 'update_image_layer',
    description:
      'Update a sticker’s timing, position or size (list_image_layers gives the ids). The image source is fixed — delete and re-add to change it.',
    inputSchema: obj(
      {
        layerId: str(),
        patch: {
          type: 'object',
          description: 'Fields to change: startSec, endSec, x, y, widthPct'
        }
      },
      ['layerId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId, patch }) =>
      updateImageLayer(String(layerId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_image_layer',
    description: 'Remove a sticker from the timeline (easily recreated with add_image_layer).',
    inputSchema: obj({ layerId: str() }, ['layerId']),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId }) => {
      deleteImageLayer(String(layerId))
      return { ok: true }
    }
  },
  {
    name: 'list_text_layers',
    description:
      'The video’s title track: free text layers (titles, captions, credits) with their timing (absolute seconds on the FINAL timeline), frame position (normalized x/y + numpad anchor) and typography. Burned at render.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listTextLayers(String(videoId))
  },
  {
    name: 'add_text_layer',
    description:
      'Add a text layer to the video’s title track. Position is normalized (x/y in 0–1, anchor = ASS numpad 1–9 saying which point of the text sits on x/y); sizePct is % of the output height; colorHex is #RRGGBB; fontFamily is a system font name (null = default sans).',
    inputSchema: obj(
      {
        videoId: str(),
        content: str('The text (max 500 chars)'),
        startSec: { type: 'number', description: 'Start, in FINAL-timeline seconds' },
        endSec: { type: 'number', description: 'End, in FINAL-timeline seconds (> start)' },
        x: { type: 'number', description: '0–1, default 0.5' },
        y: { type: 'number', description: '0–1, default 0.5' },
        anchor: { type: 'number', description: 'Numpad 1–9, default 5 (centered on x/y)' },
        fontFamily: { type: 'string', description: 'e.g. "Georgia", "Futura", "Impact"' },
        sizePct: { type: 'number', description: '% of output height, 1–30 (default 6)' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        colorHex: { type: 'string', description: '#RRGGBB (default #ffffff)' },
        animation: {
          type: 'string',
          enum: [...TEXT_ANIMATION_IDS],
          description: 'Entrance animation (fade, pop, slide-up); omit for static'
        }
      },
      ['videoId', 'content', 'startSec', 'endSec']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createTextLayer({
        videoId: String(args['videoId']),
        content: String(args['content']),
        startSec: Number(args['startSec']),
        endSec: Number(args['endSec']),
        ...(args['x'] !== undefined ? { x: Number(args['x']) } : {}),
        ...(args['y'] !== undefined ? { y: Number(args['y']) } : {}),
        ...(args['anchor'] !== undefined ? { anchor: Number(args['anchor']) } : {}),
        ...(args['fontFamily'] !== undefined ? { fontFamily: String(args['fontFamily']) } : {}),
        ...(args['sizePct'] !== undefined ? { sizePct: Number(args['sizePct']) } : {}),
        ...(args['bold'] !== undefined ? { bold: Boolean(args['bold']) } : {}),
        ...(args['italic'] !== undefined ? { italic: Boolean(args['italic']) } : {}),
        ...(args['colorHex'] !== undefined ? { colorHex: String(args['colorHex']) } : {}),
        ...(isTextAnimationId(args['animation']) ? { animation: args['animation'] } : {})
      })
  },
  {
    name: 'update_text_layer',
    description:
      'Update any fields of a text layer (list_text_layers gives the ids): content, timing, position, anchor, font, size, bold/italic, colour.',
    inputSchema: obj(
      {
        layerId: str(),
        patch: {
          type: 'object',
          description:
            'Fields to change: content, startSec, endSec, x, y, anchor, fontFamily, sizePct, bold, italic, colorHex, animation (fade | pop | slide-up | null)'
        }
      },
      ['layerId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId, patch }) =>
      updateTextLayer(String(layerId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_text_layer',
    description: 'Remove a text layer from the title track (easily recreated with add_text_layer).',
    inputSchema: obj({ layerId: str() }, ['layerId']),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId }) => {
      deleteTextLayer(String(layerId))
      return { ok: true }
    }
  },
  {
    name: 'list_feedback',
    description:
      'The video’s feedback bucket: review notes the user took while watching the timeline. Each item has a comment, a status (open | done), and usually a FINAL-timeline timecodeSec + the node (id + label snapshot) under the playhead. Work through the open items, then mark each one done with update_feedback.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listFeedback(String(videoId))
  },
  {
    name: 'add_feedback',
    description:
      'Add a note to the video’s feedback bucket (e.g. a follow-up the user asked for). timecodeSec is in FINAL-timeline seconds; nodeId/nodeLabel anchor the note to the shot it is about.',
    inputSchema: obj(
      {
        videoId: str(),
        comment: str('The note (max 2000 chars)'),
        timecodeSec: {
          type: 'number',
          description: 'FINAL-timeline seconds; omit for a general note'
        },
        nodeId: str('Node the note is about'),
        nodeLabel: str('Display name of that node at note time')
      },
      ['videoId', 'comment']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createFeedbackItem({
        videoId: String(args['videoId']),
        comment: String(args['comment']),
        ...(args['timecodeSec'] !== undefined ? { timecodeSec: Number(args['timecodeSec']) } : {}),
        ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
        ...(args['nodeLabel'] !== undefined ? { nodeLabel: String(args['nodeLabel']) } : {})
      })
  },
  {
    name: 'update_feedback',
    description:
      'Update a feedback item (list_feedback gives the ids) — set status to "done" once a note has been addressed, or amend comment/timecodeSec.',
    inputSchema: obj(
      {
        feedbackId: str(),
        patch: {
          type: 'object',
          description:
            'Fields to change: status ("open" | "done"), comment, timecodeSec, nodeId, nodeLabel'
        }
      },
      ['feedbackId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ feedbackId, patch }) =>
      updateFeedbackItem(String(feedbackId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_feedback',
    description:
      'Delete a feedback item. A user note is unrecoverable once deleted — prefer marking it done with update_feedback.',
    inputSchema: obj({ feedbackId: str() }, ['feedbackId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ feedbackId }) => {
      deleteFeedbackItem(String(feedbackId))
      return { ok: true }
    }
  },
  {
    name: 'replace_node_model',
    description:
      'Swap a node’s model in place (e.g. Grok → Seedance): compatible params are kept, edges re-land on matching handles — but the node’s GENERATIONS are deleted (a new model can’t reuse them). Destructive.',
    inputSchema: obj({ nodeId: str(), modelId: str('The new model id (list_models)') }, [
      'nodeId',
      'modelId'
    ]),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nodeId, modelId }) => {
      graph.replaceNodeModel(String(nodeId), String(modelId))
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
    name: 'disconnect_edge',
    description:
      'Remove ONE connection by its edge id (get_workflow lists them) — the nodes on both sides stay. Undoable.',
    inputSchema: obj({ edgeId: str('Edge id from get_workflow') }, ['edgeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ edgeId }) => {
      graph.disconnectEdge(String(edgeId))
      return { ok: true }
    }
  },
  {
    name: 'reorder_edges',
    description:
      'Reorder the connections of ONE input handle — the order is semantic (@Image1/@Image2 numbering, Seedance 1.5 first/last frame). Pass every edge of that handle in the desired order.',
    inputSchema: obj(
      {
        videoId: str(),
        targetNodeId: str(),
        input: str('The input handle whose connections to reorder'),
        edgeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'ALL edge ids currently on that handle, in the desired order.'
        }
      },
      ['videoId', 'targetNodeId', 'input', 'edgeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, targetNodeId, input, edgeIds }) => {
      graph.reorderEdges({
        videoId: String(videoId),
        targetNodeId: String(targetNodeId),
        targetHandle: String(input),
        edgeIds: (Array.isArray(edgeIds) ? edgeIds : []).map(String)
      })
      return { ok: true }
    }
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
  // ── Speech (§8): ElevenLabs voices + the channel's voice personas ─────────
  {
    name: 'list_voice_personas',
    description:
      'The channel’s named voice identities ("Narrateur" = this ElevenLabs voice id), app-wide, optionally filtered to one niche. Check it BEFORE writing a speech node’s voice — recurring characters must keep their voice across videos. Details: docs "speech".',
    inputSchema: obj({
      niche_id: str('Only this niche’s personas plus the unpinned ones.')
    }),
    scope: 'global',
    risk: 'read',
    execute: ({ niche_id }) =>
      listVoicePersonas(niche_id !== undefined ? String(niche_id) : undefined)
  },
  {
    name: 'create_voice_persona',
    description:
      'Name an ElevenLabs voice as a persona of the channel ("Narrateur is this voice id"). The name is what dialogue scripts and future videos reuse — one persona per recurring character/narrator.',
    inputSchema: obj(
      {
        name: str('Unique name, e.g. "Narrateur" or "Léa".'),
        voice_id: str('ElevenLabs voice id (custom clone or premade).'),
        description: str('Delivery notes, e.g. "calm, warm, slightly amused".'),
        niche_id: str('Pin the persona to a niche/channel (omit = available everywhere).')
      },
      ['name', 'voice_id']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ name, voice_id, description, niche_id }) =>
      createVoicePersona({
        name: String(name),
        voiceId: String(voice_id),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(niche_id !== undefined ? { nicheId: String(niche_id) } : {})
      })
  },
  {
    name: 'update_voice_persona',
    description:
      'Rename a voice persona, re-point it at another ElevenLabs voice id, or change its notes/niche. Existing speech nodes keep their already-written voice ids.',
    inputSchema: obj(
      {
        persona_id: str(),
        name: str(),
        voice_id: str(),
        description: str(),
        niche_id: str('"" unpins the persona from its niche.')
      },
      ['persona_id']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ persona_id, name, voice_id, description, niche_id }) =>
      updateVoicePersona(String(persona_id), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(voice_id !== undefined ? { voiceId: String(voice_id) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(niche_id !== undefined ? { nicheId: String(niche_id) || null } : {})
      })
  },
  {
    name: 'delete_voice_persona',
    description:
      'Forget a voice persona. Speech nodes keep their voice ids — this only removes the name from the channel’s cast of voices.',
    inputSchema: obj({ persona_id: str() }, ['persona_id']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ persona_id }) => {
      deleteVoicePersona(String(persona_id))
      return { ok: true }
    }
  },
  {
    name: 'list_elevenlabs_voices',
    description:
      'Search the ElevenLabs voice library of the configured account (name, category, voice id, preview URL) — the source of ids for voice personas and speech nodes.',
    inputSchema: obj({ search: str('Filter by name/description/labels.') }),
    scope: 'global',
    risk: 'read',
    execute: ({ search }) =>
      elevenlabsListVoices({ ...(search !== undefined ? { search: String(search) } : {}) })
  },
  {
    name: 'get_transcript',
    description:
      'The timed transcript of a speech node’s output: `segments` carry the raw float start/end seconds (MEDIA time of the audio file — the precision sub-second sync with set_audio_offset needs), `formatted` renders them as [m:ss] lines with speaker labels. Pass generation_id for a specific take.',
    inputSchema: obj({ nodeId: str(), generation_id: str('Defaults to the node’s best output.') }, [
      'nodeId'
    ]),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId, generation_id }) => {
      const rows = generations.listGenerationsForNode(String(nodeId))
      const row =
        generation_id !== undefined
          ? rows.find((g) => g.id === String(generation_id))
          : (rows.find((g) => g.status === 'success' && g.transcript) ?? rows[0])
      if (!row) throw new Error('No generation on this node.')
      const transcript = (row.transcript ?? null) as SpeechTranscript | null
      if (!transcript) {
        throw new Error('No transcript on this generation (only ElevenLabs speech runs carry one).')
      }
      return {
        generationId: row.id,
        text: transcript.text,
        segments: transcript.segments,
        formatted: formatTranscript(transcript)
      }
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
  {
    name: 'delete_checkpoint',
    description:
      'Delete a checkpoint. The graph is untouched, but the captured state can never be restored again. Destructive.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ checkpointId }) => {
      deleteCheckpoint(String(checkpointId))
      return { ok: true }
    }
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
    name: 'add_annotation',
    description:
      'Leave a note on a generation: a normalized region of the frame (image) or a timecode in seconds (clip), plus the comment. Shows up in the app’s feedback layer like a user note.',
    inputSchema: obj(
      {
        generationId: str(),
        comment: str('What is wrong (or right) there'),
        region: obj(
          {
            x: { type: 'number', description: '0–1, left edge' },
            y: { type: 'number', description: '0–1, top edge' },
            w: { type: 'number', description: '0–1' },
            h: { type: 'number', description: '0–1' }
          },
          ['x', 'y', 'w', 'h']
        ),
        timecodeSec: { type: 'number', description: 'Clip outputs: the moment the note is about' }
      },
      ['generationId', 'comment']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId, comment, region, timecodeSec }) =>
      addAnnotation({
        generationId: String(generationId),
        comment: String(comment),
        region: region ? (region as { x: number; y: number; w: number; h: number }) : null,
        timecodeSec: timecodeSec === undefined ? null : Number(timecodeSec)
      })
  },
  {
    name: 'delete_annotation',
    description:
      'Delete one note from a generation (get_annotations lists their ids). Destructive.',
    inputSchema: obj({ annotationId: str() }, ['annotationId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ annotationId }) => {
      deleteAnnotation(String(annotationId))
      return { ok: true }
    }
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
      'List a node’s generations: status (pending/running/success/failed), media URL, local file path, draft flag, vision-QC verdict, error. Look at a result with get_generation_media (or read localPath directly when you run on this machine).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) =>
      generations.listGenerationsForNode(String(nodeId)).map((g) => ({
        id: g.id,
        status: g.status,
        url: g.resultUrl,
        // Absolute path of the cached media on this machine — a local agent
        // can open it with its own file tools instead of fetching the URL.
        localPath: g.resultPath,
        draft: g.draft ?? false,
        qcVerdict: g.qcVerdict,
        qcNotes: g.qcNotes,
        // Speech runs only — read it with get_transcript.
        hasTranscript: g.transcript != null,
        error: g.errorMessage,
        createdAt: g.createdAt
      }))
  },
  {
    name: 'get_generation_media',
    description:
      'Look at a generation with your own eyes: returns a downscaled JPEG of the result as inline image content (for a video: one frame — position first|middle|last, or at_sec in media time). Judge results before spending more credits.',
    inputSchema: obj(
      {
        generationId: str(),
        position: {
          type: 'string',
          enum: ['first', 'middle', 'last'],
          description: 'Video only: which frame to grab (default middle).'
        },
        at_sec: { type: 'number', description: 'Video only: grab the frame at this media time.' }
      },
      ['generationId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ generationId, position, at_sec }) =>
      generationMediaPreview(String(generationId), {
        position:
          position === 'first' || position === 'middle' || position === 'last'
            ? position
            : undefined,
        atSec: typeof at_sec === 'number' ? at_sec : undefined
      })
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
    name: 'dequeue_generation',
    description:
      'Remove ONE queued-but-unsubmitted generation from the run queue (row deleted — nothing was spent). Ids via queue_state/get_generations; a running generation needs cancel_generation.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId }) => dequeueGeneration(String(generationId))
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
    name: 'queue_state',
    description:
      'The generation queue right now: running and queued generation ids, the concurrency limit, and per-generation smart-retry counts. Not a completion signal — the settle wake-up is.',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => queueState()
  },
  {
    name: 'wait_for_generations',
    description:
      'Long-poll: blocks until the listed generations (and/or every in-flight generation of the listed nodes) settle — success or failure — or timeout_sec elapses (default 120, max 600; a timeout returns stillPending instead of throwing). For external agents; the embedded assistant is woken automatically and never needs this.',
    inputSchema: obj({
      generationIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Generation ids to wait on (already-settled ids report immediately).'
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Wait on every pending/running generation of these nodes.'
      },
      timeout_sec: { type: 'number' }
    }),
    scope: 'global',
    risk: 'read',
    execute: ({ generationIds, nodeIds, timeout_sec }) =>
      waitForGenerations({
        generationIds: Array.isArray(generationIds) ? generationIds.map(String) : undefined,
        nodeIds: Array.isArray(nodeIds) ? nodeIds.map(String) : undefined,
        timeoutSec: typeof timeout_sec === 'number' ? timeout_sec : undefined
      })
  },
  {
    name: 'render_video',
    description:
      'Render a video’s timeline into a single MP4 file (local ffmpeg, no credits): clips concatenated in shot order, music lane muxed over. Synchronous — returns the output path. Optional fps/resolution override the first clip’s probed spec.',
    inputSchema: obj(
      {
        videoId: str(),
        outputPath: str('Absolute .mp4 destination (default: Downloads folder)'),
        fps: { type: 'number', description: 'Output frame rate (default: probed)' },
        resolution: obj(
          {
            width: { type: 'number' },
            height: { type: 'number' }
          },
          ['width', 'height']
        ),
        burnSubtitles: {
          type: 'boolean',
          description: 'Burn the scenario’s quoted dialogue as subtitles'
        },
        captionsPreset: {
          type: 'string',
          enum: [...CAPTION_PRESET_IDS],
          description:
            'Burn dynamic captions from the speech lane’s transcripts (real ElevenLabs timings): classic line, pop-in, or karaoke word highlight. Omit for none.'
        },
        duckMusic: {
          type: 'boolean',
          description: 'Duck the music bed under the voice-over (transcript-timed windows)'
        },
        quality: {
          type: 'string',
          enum: ['draft', 'standard', 'high'],
          description: 'Encoder quality (default standard)'
        },
        codec: {
          type: 'string',
          enum: ['h264', 'hevc'],
          description: 'Output codec (default h264; hevc = smaller files, forces re-encode)'
        },
        watermarkText: {
          type: 'string',
          description: 'Translucent corner text over the whole film (max 80 chars)'
        },
        watermarkPosition: {
          type: 'string',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
          description: 'Watermark corner (default bottom-right)'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: async ({
      videoId,
      outputPath,
      fps,
      resolution,
      burnSubtitles,
      captionsPreset,
      duckMusic,
      quality,
      codec,
      watermarkText,
      watermarkPosition
    }) => {
      const target = outputPath
        ? String(outputPath)
        : renderService.defaultOutputPath(String(videoId))
      const res = resolution as { width?: unknown; height?: unknown } | undefined
      const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
      const corner = corners.find((c) => c === watermarkPosition)
      const { durationSeconds, skipped } = await renderService.renderVideo({
        videoId: String(videoId),
        outputPath: target,
        ...(fps !== undefined ? { fps: Number(fps) } : {}),
        ...(res ? { resolution: { width: Number(res.width), height: Number(res.height) } } : {}),
        ...(burnSubtitles !== undefined ? { burnSubtitles: Boolean(burnSubtitles) } : {}),
        ...(isCaptionPresetId(captionsPreset) ? { captionsPreset } : {}),
        ...(duckMusic !== undefined ? { duckMusic: Boolean(duckMusic) } : {}),
        ...(quality === 'draft' || quality === 'standard' || quality === 'high' ? { quality } : {}),
        ...(codec === 'h264' || codec === 'hevc' ? { codec } : {}),
        ...(watermarkText
          ? { watermark: { text: String(watermarkText), ...(corner ? { position: corner } : {}) } }
          : {})
      })
      return { path: target, durationSeconds, skipped }
    }
  },
  {
    name: 'cancel_render',
    description: 'Cancel a video’s in-flight MP4 render. Returns whether one was running.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => ({ cancelled: renderService.cancelRender(String(videoId)) })
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
    name: 'asset_references',
    description:
      'Which videos use an asset (via studio/asset nodes). Check this BEFORE delete_asset — deleting a referenced asset breaks those workflows.',
    inputSchema: obj({ assetId: str() }, ['assetId']),
    scope: 'global',
    risk: 'read',
    execute: ({ assetId }) => assets.assetReferences(String(assetId))
  },
  {
    name: 'delete_asset',
    description:
      'Delete an asset from the project library (studio/asset nodes referencing it lose their media). Destructive — run asset_references first.',
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
  },

  // ── YouTube niche research (§7) ────────────────────────────────────────────
  {
    name: 'list_niches',
    description:
      'The YouTube niches under watch: name, positioning brief, tracked channel/video counts. A niche is a watchlist of competitor channels plus the user’s own, refreshed on demand. Details: docs "niches".',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => niches.listNiches()
  },
  {
    name: 'get_niche',
    description:
      'One niche in full: brief, tracked channels (subscribers, age, isMine) and per-channel aggregates over the tracked videos (avg/median views, upload cadence). The starting point of any niche analysis.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheId }) => {
      const { aggregates, ...detail } = niches.getNiche(String(nicheId))
      return {
        ...detail,
        channels: detail.channels.map((c) => ({ ...c, aggregates: aggregates[c.channelId] }))
      }
    }
  },
  {
    name: 'create_niche',
    description:
      'Create a niche watchlist. languageCode/locationCode are the DataForSEO defaults for its keyword searches (2840=US, 2250=FR…). Put the positioning brief in description — you own that field.',
    inputSchema: obj(
      {
        name: str(),
        description: str('Positioning brief / angle notes — the assistant maintains this.'),
        languageCode: str('Default "en".'),
        locationCode: {
          type: 'number',
          description: 'DataForSEO location code, default 2840 (US).'
        }
      },
      ['name']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ name, description, languageCode, locationCode }) =>
      niches.createNiche({
        name: String(name),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(languageCode !== undefined ? { languageCode: String(languageCode) } : {}),
        ...(locationCode !== undefined ? { locationCode: Number(locationCode) } : {})
      })
  },
  {
    name: 'update_niche',
    description:
      'Rename a niche, rewrite its positioning brief (description), or set its PRODUCTION PROFILE (style_id from docs "styles", aspect_ratio, target_seconds) — the profile shapes every workflow created from the roadmap.',
    inputSchema: obj(
      {
        nicheId: str(),
        name: str(),
        description: str(),
        languageCode: str(),
        location_code: {
          type: 'number',
          description: 'DataForSEO location code (2840=US, 2250=FR…).'
        },
        style_id: str('A Raccord style template id (docs "styles"), or empty to clear.'),
        aspect_ratio: str('16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9'),
        target_seconds: { type: 'number', description: 'Target video length in seconds.' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      nicheId,
      name,
      description,
      languageCode,
      location_code,
      style_id,
      aspect_ratio,
      target_seconds
    }) =>
      niches.updateNiche(String(nicheId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(languageCode !== undefined ? { languageCode: String(languageCode) } : {}),
        ...(location_code !== undefined ? { locationCode: Number(location_code) } : {}),
        ...(style_id !== undefined ? { styleId: String(style_id) || null } : {}),
        ...(aspect_ratio !== undefined ? { aspectRatio: String(aspect_ratio) || null } : {}),
        ...(target_seconds !== undefined ? { targetSeconds: Number(target_seconds) || null } : {})
      })
  },
  {
    name: 'delete_niche',
    description:
      'Delete a niche and everything tracked in it (channels, videos, transcripts). Unrecoverable.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nicheId }) => niches.deleteNiche(String(nicheId))
  },
  {
    name: 'add_niche_channel',
    description:
      'Track a YouTube channel in a niche, by id (UC…), @handle or URL. Set is_mine=true for the user’s own channels — analyses compare "mine" against the rest. Stats come back immediately; run refresh_niche to pull its videos.',
    inputSchema: obj(
      {
        nicheId: str(),
        ref: str('Channel id, @handle or youtube.com URL.'),
        is_mine: { type: 'boolean', description: 'True for the user’s own channel.' },
        notes: str()
      },
      ['nicheId', 'ref']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, ref, is_mine, notes }) =>
      niches.addChannel({
        nicheId: String(nicheId),
        ref: String(ref),
        ...(is_mine !== undefined ? { isMine: Boolean(is_mine) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'update_niche_channel',
    description: 'Toggle a tracked channel’s is_mine flag or rewrite its notes.',
    inputSchema: obj({ nicheChannelId: str(), is_mine: { type: 'boolean' }, notes: str() }, [
      'nicheChannelId'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheChannelId, is_mine, notes }) =>
      niches.updateChannel(String(nicheChannelId), {
        ...(is_mine !== undefined ? { isMine: Boolean(is_mine) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'remove_niche_channel',
    description:
      'Stop tracking a channel. Its channel-sourced videos (and their transcripts) are deleted with it; keyword-search finds survive.',
    inputSchema: obj({ nicheChannelId: str() }, ['nicheChannelId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nicheChannelId }) => niches.removeChannel(String(nicheChannelId))
  },
  {
    name: 'refresh_niche',
    description:
      'Pull fresh data for a whole niche: channel stats, latest uploads of every tracked channel, and updated stats of every tracked video. Free (YouTube quota only, ~1 unit per 50 items). Run it before an analysis session.',
    inputSchema: obj(
      {
        nicheId: str(),
        videos_per_channel: {
          type: 'number',
          description: 'Latest uploads to track per channel (default 30).'
        }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, videos_per_channel }) =>
      niches.refreshNiche(
        String(nicheId),
        videos_per_channel !== undefined ? Number(videos_per_channel) : undefined
      )
  },
  {
    name: 'list_niche_videos',
    description:
      'Tracked videos of a niche, scored through three outlier lenses: ratio = views/subscribers (null = hidden subs, very strong), channel_ratio = views vs the channel’s own median, views_per_day = velocity; `signal` combines the first two. Filters: format, max_subscribers, max_channel_age_months, min_views, sort. Lens semantics: docs "niches".',
    inputSchema: obj(
      {
        nicheId: str(),
        format: str('long | short | all (default long).'),
        max_subscribers: { type: 'number' },
        max_channel_age_months: { type: 'number' },
        min_views: { type: 'number' },
        sort: str('ratio | views | date (default ratio).'),
        language: str('BCP-47 primary subtag (en, fr…) — best-effort audio-language filter.'),
        limit: { type: 'number', description: 'Default 200.' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({
      nicheId,
      format,
      max_subscribers,
      max_channel_age_months,
      min_views,
      sort,
      language,
      limit
    }) =>
      niches
        .listNicheVideos(
          String(nicheId),
          {
            ...(format !== undefined ? { format: format as 'all' | 'long' | 'short' } : {}),
            ...(max_subscribers !== undefined ? { maxSubscribers: Number(max_subscribers) } : {}),
            ...(max_channel_age_months !== undefined
              ? { maxChannelAgeMonths: Number(max_channel_age_months) }
              : {}),
            ...(min_views !== undefined ? { minViews: Number(min_views) } : {}),
            ...(sort !== undefined ? { sort: sort as 'ratio' | 'views' | 'date' } : {}),
            ...(language !== undefined ? { language: String(language) } : {})
          },
          limit !== undefined ? Number(limit) : undefined
        )
        .map((v) => {
          const ratio = nicheRatio(v.views, v.channelSubscribers)
          return {
            ...v,
            ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
            channelRatio: v.channelRatio === null ? null : Math.round(v.channelRatio * 100) / 100,
            viewsPerDay: v.viewsPerDay === null ? null : Math.round(v.viewsPerDay),
            signal: combineSignals(ratioSignal(ratio), channelRatioSignal(v.channelRatio))
          }
        })
  },
  {
    name: 'get_niche_video',
    description:
      'One tracked video in full: description AND transcript (when fetched — run fetch_niche_transcripts first). This is the raw material for topic analysis and video ideas.',
    inputSchema: obj({ nicheVideoId: str() }, ['nicheVideoId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheVideoId }) => niches.getNicheVideoDetail(String(nicheVideoId))
  },
  {
    name: 'fetch_niche_transcripts',
    description:
      'Fetch missing transcripts (YouTube captions, human track preferred) for a niche’s tracked videos, most-viewed first. Videos without captions are marked resolved and listed in "failed". Batch of `limit` (default 10) per call; "remaining" says how many are left.',
    inputSchema: obj(
      {
        nicheId: str(),
        video_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these YouTube video ids.'
        },
        limit: { type: 'number' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, video_ids, limit }) =>
      niches.fetchTranscripts({
        nicheId: String(nicheId),
        ...(Array.isArray(video_ids) ? { videoIds: video_ids.map(String) } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {})
      })
  },
  {
    name: 'niche_keyword_search',
    description: `Hunt niche videos on a keyword: DataForSEO scrapes the real YouTube SERP (native filters via search_param presets: ${SP_PRESETS.map((p) => p.id).join(', ')}), the YouTube API enriches, results come back scored (views/subscribers). save=true adds the hits to the niche. Paid per 20 results on DataForSEO’s side.`,
    inputSchema: obj(
      {
        keyword: str(),
        nicheId: str(
          'Optional — required with save=true; also provides default location/language.'
        ),
        depth: { type: 'number', description: '20–700 results, billed per 20 (default 100).' },
        search_param: str('An sp preset id, a raw sp value or a filtered YouTube URL.'),
        location_code: { type: 'number' },
        language_code: str(),
        save: { type: 'boolean', description: 'Save the hits into the niche (source "search").' }
      },
      ['keyword']
    ),
    scope: 'global',
    risk: 'write',
    execute: async ({
      keyword,
      nicheId,
      depth,
      search_param,
      location_code,
      language_code,
      save
    }) => {
      const result = await niches.keywordSearch({
        keyword: String(keyword),
        ...(nicheId !== undefined ? { nicheId: String(nicheId) } : {}),
        ...(depth !== undefined ? { depth: Number(depth) } : {}),
        ...(search_param !== undefined ? { searchParam: String(search_param) } : {}),
        ...(location_code !== undefined ? { locationCode: Number(location_code) } : {}),
        ...(language_code !== undefined ? { languageCode: String(language_code) } : {}),
        ...(save !== undefined ? { save: Boolean(save) } : {})
      })
      return {
        ...result,
        /** The SERP landscape at a glance — approachable/contested/saturated. */
        opportunity: analyzeSerpOpportunity(result.videos, new Date()),
        videos: result.videos.map((v) => {
          const ratio = nicheRatio(v.views, v.channelSubscribers)
          return {
            ...v,
            ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
            signal: ratioSignal(ratio)
          }
        })
      }
    }
  },

  {
    name: 'youtube_keyword_suggestions',
    description:
      'YouTube search autocomplete for a seed query — the real "what people type" demand signal. FREE and unlimited: expand seeds recursively here, then spend niche_keyword_search (paid) only on the best 2-3 keywords.',
    inputSchema: obj(
      {
        query: str('Seed keyword, e.g. "learn english".'),
        language_code: str('Interface language for suggestions (default en).')
      },
      ['query']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ query, language_code }) =>
      fetchSearchSuggestions(
        String(query),
        language_code !== undefined ? String(language_code) : 'en'
      )
  },

  // ── Roadmap (§7b): the videos to make, idea → workflow → published ────────
  {
    name: 'list_roadmap',
    description:
      'The niche’s video roadmap: ideas with angle, evidence, title/description drafts, thumbnail brief, status (idea | in_production | published) and the assigned workflow. Published items carry live views vs the niche median.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheId }) => niches.listRoadmap(String(nicheId))
  },
  {
    name: 'add_roadmap_item',
    description:
      'Add a video idea to the niche roadmap. ALWAYS ground it: evidence must cite the tracked videos proving demand (title, ratio, views). Write the YouTube title AND 5-10 title_variants (packaging-first: the click is decided at ideation), the description draft, and a thumbnail_brief (subject + emotion + 2-4 word overlay) — it seeds the thumbnail node on assignment. Method: docs "niches".',
    inputSchema: obj(
      {
        nicheId: str(),
        title: str('The YouTube title — punchy, curiosity-driven, in the niche’s language.'),
        title_variants: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Candidate titles (max 20) — different promises/angles, not rewordings. The user promotes one to `title`.'
        },
        angle: str('One-line pitch: what makes this video different.'),
        description: str('YouTube description draft.'),
        thumbnail_brief: str('Prompt brief for the thumbnail recipe node.'),
        evidence: str('The tracked videos proving demand, with ratio and views.'),
        video_type: str('long (default) | short')
      },
      ['nicheId', 'title']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      nicheId,
      title,
      title_variants,
      angle,
      description,
      thumbnail_brief,
      evidence,
      video_type
    }) =>
      niches.addRoadmapItem({
        nicheId: String(nicheId),
        title: String(title),
        ...(Array.isArray(title_variants) ? { titleVariants: title_variants.map(String) } : {}),
        ...(angle !== undefined ? { angle: String(angle) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(thumbnail_brief !== undefined ? { thumbnailBrief: String(thumbnail_brief) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence) } : {}),
        ...(video_type !== undefined ? { videoType: video_type as 'long' | 'short' } : {})
      })
  },
  {
    name: 'update_roadmap_item',
    description:
      'Rewrite a roadmap item’s title/title_variants/angle/description/thumbnail brief/evidence, or move its status. Use it to iterate on titles and descriptions when the user asks for variants.',
    inputSchema: obj(
      {
        itemId: str(),
        title: str(),
        title_variants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Candidate titles (max 20); empty array clears the list.'
        },
        angle: str(),
        description: str(),
        thumbnail_brief: str(),
        evidence: str(),
        video_type: str('long | short'),
        status: str('idea | in_production | published'),
        sort_order: { type: 'number', description: 'Position in the roadmap.' }
      },
      ['itemId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      itemId,
      title,
      title_variants,
      angle,
      description,
      thumbnail_brief,
      evidence,
      video_type,
      status,
      sort_order
    }) =>
      niches.updateRoadmapItem(String(itemId), {
        ...(title !== undefined ? { title: String(title) } : {}),
        ...(Array.isArray(title_variants) ? { titleVariants: title_variants.map(String) } : {}),
        ...(angle !== undefined ? { angle: String(angle) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(thumbnail_brief !== undefined ? { thumbnailBrief: String(thumbnail_brief) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence) } : {}),
        ...(video_type !== undefined ? { videoType: video_type as 'long' | 'short' } : {}),
        ...(status !== undefined
          ? { status: status as 'idea' | 'in_production' | 'published' }
          : {}),
        ...(sort_order !== undefined ? { sortOrder: Number(sort_order) } : {})
      })
  },
  {
    name: 'delete_roadmap_item',
    description: 'Delete a roadmap idea. The assigned Raccord video (if any) is NOT touched.',
    inputSchema: obj({ itemId: str() }, ['itemId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ itemId }) => niches.deleteRoadmapItem(String(itemId))
  },
  {
    name: 'assign_roadmap_item',
    description:
      'Idea → workflow: creates the Raccord video (or links video_id), applies the niche’s production profile (a `short` forces 9:16, vertical thumbnail included), seeds the thumbnail node from the brief and stamps the video↔item back-link — the editor assistant then receives the niche context automatically. Then write_scenario (angle + evidence transcripts as brief, niche target_seconds).',
    inputSchema: obj(
      {
        itemId: str(),
        project_id: str('Project to create the workflow in (omit when passing video_id).'),
        video_id: str('Link an existing Raccord video instead of creating one.')
      },
      ['itemId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ itemId, project_id, video_id }) =>
      niches.assignRoadmapItem(String(itemId), {
        ...(project_id !== undefined ? { projectId: String(project_id) } : {}),
        ...(video_id !== undefined ? { videoId: String(video_id) } : {})
      })
  },
  {
    name: 'mark_roadmap_published',
    description:
      'Mark a roadmap item live: pass the YouTube URL (or id). If the channel is tracked in the niche (is_mine), the item reports its views against the niche median on the next refresh.',
    inputSchema: obj({ itemId: str(), url: str('YouTube watch/shorts URL or the video id.') }, [
      'itemId',
      'url'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ itemId, url }) => niches.markRoadmapPublished(String(itemId), String(url))
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
