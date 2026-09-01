import { videoAspectRatioSchema, videoResolutionSchema } from '@shared/ipc/contracts'
import { broadcastFocusNode, broadcastNavigate } from '../../events'
import * as graph from '../../services/graph'
import * as projects from '../../services/projects'
import { deriveShort } from '../../services/shorts'
import { createVideoFromTemplate } from '../../services/templates'
import * as videos from '../../services/videos'
import { obj, str, type AgentTool } from './types'

/** Projects, videos and per-video settings (style, defaults, draft, QC). */
export const projectTools: AgentTool[] = [
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
    name: 'create_video_from_template',
    description:
      'Create a video FROM a workflow template: blueprint imported with its [TOKEN] slots filled and the template’s style applied, in one call. Slots you leave blank keep their token (fill them later with update_node) and come back as unfilledTokens. Template ids, slots and blueprints: docs "templates" / "template:<id>".',
    inputSchema: obj(
      {
        projectId: str(),
        templateId: str(),
        name: str('Video name (default: the template’s label).'),
        slots: {
          type: 'object',
          description: 'Literal token → value, e.g. {"[PRODUCT]": "Aurora headphones"}.'
        }
      },
      ['projectId', 'templateId']
    ),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, templateId, name, slots }) =>
      createVideoFromTemplate({
        projectId: String(projectId),
        templateId: String(templateId),
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(slots && typeof slots === 'object'
          ? {
              slots: Object.fromEntries(
                Object.entries(slots as Record<string, unknown>).map(([k, v]) => [k, String(v)])
              )
            }
          : {})
      })
  },
  {
    name: 'derive_short',
    description:
      'Derive a 9:16 Short from a long-form MP4: imports it as a video asset and builds a new vertical video with one fill-framed clip per excerpt, in one undo step. Source = a finished Raccord video (videoId + its render_video output) OR any external file (projectId — a YouTube master, a rush). Segments = MP4 media seconds, kept in the given order. Render it at 1080×1920. Method: docs "timeline".',
    inputSchema: obj(
      {
        videoId: str('The SOURCE Raccord video (style inherited). Omit for an external file.'),
        projectId: str('External source: the project receiving the Short (overrides videoId).'),
        sourcePath: str(
          'Absolute path of the source MP4 (render_video output, or any video file).'
        ),
        segments: {
          type: 'array',
          description: 'Excerpts to keep, e.g. [{"startSec": 12, "endSec": 18}]. Max 20.',
          items: {
            type: 'object',
            properties: { startSec: { type: 'number' }, endSec: { type: 'number' } },
            required: ['startSec', 'endSec']
          }
        },
        title: str('Name of the new video (default: "<source> — Short").')
      },
      ['sourcePath', 'segments']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, projectId, sourcePath, segments, title }) =>
      deriveShort({
        // An explicit projectId signals an EXTERNAL source: it wins over the
        // videoId a video-bound chat session injects into every 'video' tool.
        ...(projectId !== undefined
          ? { projectId: String(projectId) }
          : { videoId: String(videoId) }),
        sourcePath: String(sourcePath),
        segments: (Array.isArray(segments) ? segments : []).map((s) => ({
          startSec: Number((s as { startSec?: unknown }).startSec),
          endSec: Number((s as { endSec?: unknown }).endSec)
        })),
        ...(title !== undefined ? { title: String(title) } : {})
      })
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
  }
]
