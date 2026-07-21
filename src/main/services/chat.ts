import type Anthropic from '@anthropic-ai/sdk'
import { MODELS, getModel } from '@shared/models'
import { getStyle } from '@shared/styles/registry'
import { HOME_CHAT_ID, type ChatImage, type ChatItem, type ChatState } from '@shared/ipc/contracts'
import { onGenerationSettled } from '../bus'
import { broadcastChatUpdate, broadcastWorkflowChanged } from '../events'
import { DOC_TOPICS, getDoc } from '../mcp/docs'
import { deleteChatSession, loadChatSession, saveChatSession } from './chatStore'
import * as assets from './assets'
import {
  fromResponsesOutput,
  toResponsesInput,
  toResponsesTools,
  type ResponsesOutputItem
} from './chatOpenAIFormat'
import * as generations from './generations'
import * as graph from './graph'
import { KIE_BASE } from './kie'
import * as projects from './projects'
import { runNode } from './runEngine'
import { getAssistantModel, getKieApiKey, getLocale } from './settings'
import * as videos from './videos'

/**
 * The assistant — an agentic loop over kie.ai's Claude proxy (claude-opus-4-8,
 * https://docs.kie.ai/market/claude/claude-opus-4-8) whose tools are the SAME
 * main-process services the IPC layer exposes. One in-memory session per
 * video; the renderer mirrors it via chat:get + `event:chatUpdate` pushes.
 *
 * Uses a plain fetch (the exact recipe of kieClaudeMessage, proven in
 * production) instead of the Anthropic SDK: kie's WAF rejects the SDK's
 * telemetry headers with "403 Your request was blocked".
 */

const MAX_ITERATIONS = 15

/** kie.ai OpenAI-Responses proxy path per GPT model (Claude ids use /claude/v1/messages). */
const OPENAI_RESPONSES_PATHS: Record<string, string> = {
  'gpt-5-6-sol': '/codex/v1/responses',
  'gpt-5.4-codex': '/api/v1/responses'
}

const SYSTEM = `You are the embedded assistant of Raccord, a node-based AI video studio.

The user is looking at a workflow graph for one video. Nodes are AI model invocations (image/video/audio generation) or project assets ('studio/asset' nodes whose params hold an assetId). Edges wire a source node's output into a target node's input: \`input\` is the target model's input field name (e.g. "image_urls"), \`output\` is "output" (main result) or "lastFrame" (last frame of a video). Running a node calls the kie.ai API and costs money.

How to work:
- Call get_workflow first whenever the current graph matters; call list_models before choosing model ids or param names — never guess them.
- The user watches the graph update live as you use tools, so keep narration brief.
- Prefer creating structure (nodes, connections, prompts) directly; ask before running generations (they cost money) unless the user explicitly asked to generate, and ask before deleting several nodes.
- Position nodes on a left-to-right flow (x: 0, 420, 840…; y spaced by ~350) so the graph stays readable.
- import_workflow with replace=true erases the existing graph — only with explicit user consent.
- When you launch run_node, the app automatically wakes you with a message once that generation finishes (success or failure) — you can tell the user you'll report back, then end your turn. Never poll get_generations to wait.
- The user may attach images to a message: treat them as the visual brief (subject, style, framing) and write prompts from what you see. They are NOT project assets — to use one as a workflow input, ask the user to import it via the project's Assets tab, then reference it with a studio/asset node.

You are also the film director. When the user asks for a video (an ad, an anime scene, a realistic sequence…), don't just wire nodes — direct:
1. Establish the brief from the user's request: subject, intent, tone, duration, aspect ratio. Ask only what you truly cannot infer; propose tasteful defaults for the rest.
2. Pick an art direction: read_docs "styles", choose the closest style template (or write your own equivalent), call set_video_style so it sticks to the video. The style bible paragraph must then be appended VERBATIM to every image/video prompt of the video — this is the single biggest lever for cross-shot visual consistency.
3. For a standard shape of video (product ad, anime scene, cinematic sequence, vertical social ad), start from a blueprint: read_docs "templates" then "template:<id>", fill the [SLOTS] with the user's subject, import_workflow — then refine per shot.
4. Break the video into shots (2-4s of intent each): establishing → action → emotion/punchline. Chain clips by wiring each video node's lastFrame output into the next node's image input so every cut is seamless.
5. Pre-visualize before spending video credits (Seedance 2): read_docs "designs" — design sheets (character/décor/prop) first, then one "storyboard" node per scene: a 9-panel grid built FROM the sheets (gpt-image-2-image-to-image) showing the scene beat by beat. Check the project library BEFORE generating a sheet: assets with designId/designSubject (see get_workflow, or search_assets) are published design sheets — reuse one for the same subject via a studio/asset node (reference inputs only, never a frame anchor) instead of regenerating it. And once the user approves a freshly generated sheet, publish_design it so the whole project can reuse it. The user reviews the staging on the grid, THEN you wire it as a reference on the scene's shots ("@ImageN is the 9-panel storyboard — follow its panels in order, left to right, top to bottom"; the character sheet stays its own reference, and each shot's prompt says which panels it covers). The storyboard encodes composition — keep the video prompts about motion: camera, rhythm, transitions.
6. Before writing ANY prompt, read_docs "prompting:<model id>" and follow that model's grammar exactly (camera vocabulary, dialogue syntax, @references, shot markers). Write prompts in English; per-shot: subject + action + camera + lighting + style bible + soundscape.
7. Score last: add a Suno node once the shots exist, matching the style's music hint; wire it into Seedance reference_audio_urls when the model supports it.
8. Report the estimated credit cost before proposing to run anything; propose running the cheap design/storyboard images first so the user validates the staging before any video shot.`

const SYSTEM_HOME = `You are the embedded assistant of Raccord, a node-based AI video studio — reached from the HOME screen, so you operate at PROJECT level: the user can ask you for a complete production from scratch ("create an anime project of 2.5 minutes about…") and you deliver the whole thing: project, video(s), art direction, full workflow.

Raccord hierarchy: Project → Videos (one workflow graph each) + Assets. Nodes are AI model invocations; edges wire a source node's output ("output" or "lastFrame") into a target model's input field. Running a node calls the kie.ai API and costs money.

Every graph tool here takes an explicit videoId — always pass the id of the video you created or selected (list_videos to find one). The user sees the app update live as you work; keep narration brief.

How to deliver a full project:
1. Brief: subject, tone, duration, aspect ratio. Turn the duration into a shot plan: clips are 4-12s (8s is the sweet spot), so a 2.5-minute piece is ~18-19 shots — organize them as scenes of 3-4 shots (establishing → action → emotion). Ask only what you truly cannot infer.
2. create_project (short name from the subject), then create_video. Prefer ONE video for the whole piece (the timeline chains its clips); split into several videos only if the user asks for separate sequences.
3. read_docs "models" FIRST — the frame-anchor vs reference distinction decides your wiring: character sheets/storyboards go to Seedance 2 reference_image_urls (with an explicit role in the prompt, they never appear on screen); Seedance 1.5 / Grok image inputs literally BECOME frames. read_docs "styles" → set_video_style; the style bible must be appended VERBATIM to every visual prompt. For standard shapes, scale a template (read_docs "template:<id>") to the requested duration. On an existing project, search_assets first: published design sheets (designId/designSubject set) are reused via studio/asset nodes (reference inputs only) instead of regenerating them; publish_design a newly approved sheet so later videos can reuse it.
4. Build the graph in ONE import_workflow call (nodes + edges, left-to-right positions x: 0, 420, 840…, y by scene ~350): a key visual wired as @Image1 reference on every Seedance 2 shot (character consistency); one 9-panel storyboard node per scene (read_docs "designs", recipe "storyboard" — built FROM the key visual with gpt-image-2-image-to-image, wired as @Image2 reference on the scene's shots with "follow its panels in order, left to right, top to bottom"; it is the user's review gate before any video run); lastFrame chaining with "@Image3 as the first frame" (seamless cuts); one Suno music node per video matching the style's music hint.
5. read_docs "prompting:<model id>" before writing ANY prompt. English prompts: subject + action + camera + lighting + style bible + soundscape.
6. Report the plan and the estimated credit cost; ASK before running anything (run_node costs money — when you do launch it, the app wakes you automatically on completion, never poll).

The user may attach images to a message: treat them as the visual brief (subject, style, framing) and write prompts from what you see. They are NOT project assets — to use one as a workflow input, ask the user to import it via the project's Assets tab, then reference it with a studio/asset node.`

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_workflow',
    description:
      "Read the current workflow graph: nodes (id, key, modelId, label, intent, params, whether they already have a successful output), edges, and the project's asset library.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_models',
    description:
      'List every available AI model with its id, kind, description, input handles (name, accepted media, required, reference alias) and parameter fields. Call this before creating nodes.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'add_node',
    description:
      'Create a node in the workflow. Use a modelId from list_models, or "studio/asset" with params {"assetId": …} for an asset node.',
    input_schema: {
      type: 'object',
      properties: {
        modelId: { type: 'string' },
        label: { type: 'string', description: 'Short display label, e.g. "Shot 01 — The harbor"' },
        intent: { type: 'string', description: 'Expected result, shown next to the output' },
        params: { type: 'object', description: 'Model params (see list_models paramFields)' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['modelId']
    }
  },
  {
    name: 'update_node',
    description: 'Update a node’s label, intent and/or params (params replace the whole object).',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        label: { type: 'string' },
        intent: { type: 'string' },
        params: { type: 'object' }
      },
      required: ['nodeId']
    }
  },
  {
    name: 'connect_nodes',
    description:
      'Wire a source node output into a target node input. `input` must be one of the target model’s input handle keys; `output` is "output" (default) or "lastFrame".',
    input_schema: {
      type: 'object',
      properties: {
        sourceNodeId: { type: 'string' },
        targetNodeId: { type: 'string' },
        input: { type: 'string' },
        output: { type: 'string' }
      },
      required: ['sourceNodeId', 'targetNodeId', 'input']
    }
  },
  {
    name: 'remove_node',
    description: 'Delete a node, its connections and its generations. Destructive.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId']
    }
  },
  {
    name: 'import_workflow',
    description:
      'Bulk-create a whole graph from workflow JSON (version 1): {"version":1,"nodes":[{"key","modelId","label"?,"intent"?,"position":{"x","y"},"params"}],"edges":[{"from","to","input","output"?}]}. Keys are your own stable ids referenced by edges. replace=true erases the current graph first.',
    input_schema: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'The workflow JSON as a string' },
        replace: { type: 'boolean' }
      },
      required: ['json', 'replace']
    }
  },
  {
    name: 'run_node',
    description:
      'Launch the generation of a node (calls kie.ai — costs money; upstream inputs must already have outputs). Returns a generationId; completion arrives asynchronously.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId']
    }
  },
  {
    name: 'get_generations',
    description: 'List a node’s generations with status (running/success/failed) and media URL.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId']
    }
  },
  {
    name: 'read_docs',
    description: `Raccord reference documentation, on demand. Topics: ${DOC_TOPICS}. Read "prompting:<model id>" BEFORE writing prompts for a model; "styles" for art directions; "templates" / "template:<id>" for ready-to-import blueprints.`,
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic']
    }
  },
  {
    name: 'set_video_style',
    description:
      'Attach a style template (see read_docs "styles") to the current video — its style bible must then be appended to every visual prompt. Pass null to clear.',
    input_schema: {
      type: 'object',
      properties: { styleId: { type: ['string', 'null'] } },
      required: ['styleId']
    }
  },
  {
    name: 'search_assets',
    description:
      'Search the project’s asset library by name, key, description or tag. Published design sheets carry designId/designSubject — reuse them via a studio/asset node (reference inputs only) instead of regenerating a sheet for the same subject.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (AND, accent-insensitive)' }
      },
      required: ['query']
    }
  },
  {
    name: 'publish_design',
    description:
      'Publish a design node’s successful generation into the project’s asset library as a reusable design sheet (its design category and subject are copied from the node). Do this once the user approves a sheet, so other videos of the project can reuse it.',
    input_schema: {
      type: 'object',
      properties: {
        generationId: { type: 'string' },
        name: { type: 'string', description: 'Library display name (e.g. the character’s name)' },
        description: { type: 'string', description: 'What the sheet depicts — shown to AIs' }
      },
      required: ['generationId', 'name']
    }
  }
]

// ── Home-session toolset ─────────────────────────────────────────────────────
// Project-level tools, plus the graph tools with an explicit required videoId
// (the home session is not bound to a video).

const PROJECT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description: 'List every project (id, name).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_project',
    description: 'Create a project. Returns its projectId.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'list_videos',
    description: 'List the videos of a project (id, name).',
    input_schema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId']
    }
  },
  {
    name: 'create_video',
    description: 'Create a video (one workflow graph) in a project. Returns its videoId.',
    input_schema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      required: ['projectId', 'name']
    }
  }
]

/** Tools whose scope is a whole video: the home variant requires a videoId param. */
const VIDEO_SCOPED_TOOLS = new Set([
  'get_workflow',
  'add_node',
  'connect_nodes',
  'import_workflow',
  'set_video_style'
])

/** Tools whose scope is a whole project: the home variant requires a projectId param. */
const PROJECT_SCOPED_TOOLS = new Set(['search_assets'])

function withProjectIdParam(tool: Anthropic.Tool): Anthropic.Tool {
  const schema = tool.input_schema as { properties?: Record<string, unknown>; required?: string[] }
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        projectId: { type: 'string', description: 'The project whose assets this acts on' },
        ...(schema.properties ?? {})
      },
      required: ['projectId', ...(schema.required ?? [])]
    } as Anthropic.Tool['input_schema']
  }
}

function withVideoIdParam(tool: Anthropic.Tool): Anthropic.Tool {
  const schema = tool.input_schema as { properties?: Record<string, unknown>; required?: string[] }
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        videoId: { type: 'string', description: 'The video whose graph this acts on' },
        ...(schema.properties ?? {})
      },
      required: ['videoId', ...(schema.required ?? [])]
    } as Anthropic.Tool['input_schema']
  }
}

const TOOLS_HOME: Anthropic.Tool[] = [
  ...PROJECT_TOOLS,
  ...TOOLS.map((t) =>
    VIDEO_SCOPED_TOOLS.has(t.name)
      ? withVideoIdParam(t)
      : PROJECT_SCOPED_TOOLS.has(t.name)
        ? withProjectIdParam(t)
        : t
  )
]

// ── Tool execution against the local services ────────────────────────────────

interface ToolCtx {
  /** Chat session key: a videoId, or HOME_CHAT_ID for the home session. */
  sessionKey: string
  /** Bound video for per-video sessions; null for the home session. */
  videoId: string | null
}

/** Explicit videoId param (home session) or the session's bound video. */
function resolveVideoId(input: Record<string, unknown>, ctx: ToolCtx): string {
  const explicit =
    typeof input['videoId'] === 'string' && input['videoId'] !== ''
      ? (input['videoId'] as string)
      : null
  const id = explicit ?? ctx.videoId
  if (!id)
    throw new Error(
      'This tool needs a "videoId" — create a video first or find one with list_videos.'
    )
  return id
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolCtx
): Promise<{ result: string; mutatedVideoId: string | null; label: string }> {
  switch (name) {
    case 'list_projects': {
      const rows = projects.listProjects().map((p) => ({ id: p.id, name: p.name }))
      return { result: JSON.stringify(rows), mutatedVideoId: null, label: 'Read projects' }
    }
    case 'create_project': {
      const project = projects.createProject(String(input['name']))
      return {
        result: JSON.stringify({ projectId: project.id }),
        mutatedVideoId: '',
        label: `Project created · ${project.name}`
      }
    }
    case 'list_videos': {
      const rows = videos
        .listVideos(String(input['projectId']))
        .map((v) => ({ id: v.id, name: v.name }))
      return { result: JSON.stringify(rows), mutatedVideoId: null, label: 'Read videos' }
    }
    case 'create_video': {
      const video = videos.createVideo(String(input['projectId']), String(input['name']))
      return {
        result: JSON.stringify({ videoId: video.id }),
        mutatedVideoId: '',
        label: `Video created · ${video.name}`
      }
    }
    case 'get_workflow': {
      const videoId = resolveVideoId(input, ctx)
      const video = videos.getVideo(videoId)
      if (!video) throw new Error(`Unknown video: ${videoId}`)
      const { nodes, edges } = graph.listGraph(videoId)
      const gens = generations.listGenerationsForVideo(videoId)
      const styleId = video.styleId ?? null
      const style = styleId ? getStyle(styleId) : undefined
      const payload = {
        // The video's active art direction — append `style.styleBible` to every visual prompt.
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
        assets: assets.listAssets(video.projectId).map((a) => ({
          id: a.id,
          key: a.key,
          name: a.name,
          kind: a.kind,
          description: a.description,
          // Set on published design sheets — reference-only, never a frame anchor.
          designId: a.designId,
          designSubject: a.designSubject
        }))
      }
      return { result: JSON.stringify(payload), mutatedVideoId: null, label: 'Read workflow' }
    }
    case 'list_models': {
      const payload = MODELS.map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        description: m.description,
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
        // Long-form guide served on demand — read it before writing prompts for this model.
        promptGuideTopic: m.promptGuide ? `prompting:${m.id}` : undefined
      }))
      return { result: JSON.stringify(payload), mutatedVideoId: null, label: 'Read models' }
    }
    case 'add_node': {
      const videoId = resolveVideoId(input, ctx)
      const node = graph.createNode({
        videoId,
        modelId: String(input['modelId']),
        position: { x: Number(input['x'] ?? 0), y: Number(input['y'] ?? 0) },
        label: input['label'] ? String(input['label']) : undefined,
        intent: input['intent'] ? String(input['intent']) : undefined,
        params: input['params']
      })
      const model = getModel(node.modelId)
      return {
        result: JSON.stringify({ nodeId: node.id, key: node.key }),
        mutatedVideoId: videoId,
        label: `Node created · ${node.label ?? model?.label ?? node.modelId}`
      }
    }
    case 'update_node': {
      const nodeId = String(input['nodeId'])
      if (input['label'] !== undefined) graph.updateNodeLabel(nodeId, String(input['label']))
      if (input['intent'] !== undefined) graph.updateNodeIntent(nodeId, String(input['intent']))
      if (input['params'] !== undefined) graph.updateNodeParams(nodeId, input['params'])
      return { result: '{"ok":true}', mutatedVideoId: ctx.videoId ?? '', label: 'Node updated' }
    }
    case 'connect_nodes': {
      const videoId = resolveVideoId(input, ctx)
      const edge = graph.connectNodes({
        videoId,
        sourceNodeId: String(input['sourceNodeId']),
        sourceHandle: input['output'] ? String(input['output']) : 'output',
        targetNodeId: String(input['targetNodeId']),
        targetHandle: String(input['input'])
      })
      return {
        result: JSON.stringify({ edgeId: edge.id }),
        mutatedVideoId: videoId,
        label: 'Edge created'
      }
    }
    case 'remove_node': {
      graph.removeNode(String(input['nodeId']))
      return { result: '{"ok":true}', mutatedVideoId: ctx.videoId ?? '', label: 'Node removed' }
    }
    case 'import_workflow': {
      const videoId = resolveVideoId(input, ctx)
      const res = graph.importWorkflow(videoId, String(input['json']), Boolean(input['replace']))
      return {
        result: JSON.stringify(res),
        mutatedVideoId: videoId,
        label: `Workflow imported · ${res.nodeCount} nodes, ${res.edgeCount} edges`
      }
    }
    case 'run_node': {
      const res = await runNode(String(input['nodeId']))
      sessionFor(ctx.sessionKey).watched.add(res.generationId)
      return {
        result: JSON.stringify(res),
        mutatedVideoId: ctx.videoId ?? '',
        label: 'Generation started'
      }
    }
    case 'get_generations': {
      const rows = generations.listGenerationsForNode(String(input['nodeId'])).map((g) => ({
        id: g.id,
        status: g.status,
        url: g.resultUrl,
        error: g.errorMessage
      }))
      return { result: JSON.stringify(rows), mutatedVideoId: null, label: 'Read generations' }
    }
    case 'read_docs': {
      const topic = String(input['topic'])
      return { result: getDoc(topic), mutatedVideoId: null, label: `Read docs · ${topic}` }
    }
    case 'set_video_style': {
      const videoId = resolveVideoId(input, ctx)
      const styleId = input['styleId'] == null ? null : String(input['styleId'])
      videos.setVideoStyle(videoId, styleId)
      const label = styleId ? (getStyle(styleId)?.label ?? styleId) : 'none'
      return { result: '{"ok":true}', mutatedVideoId: videoId, label: `Style · ${label}` }
    }
    case 'search_assets': {
      const explicit =
        typeof input['projectId'] === 'string' && input['projectId'] !== ''
          ? (input['projectId'] as string)
          : null
      const projectId = explicit ?? videos.getVideo(resolveVideoId(input, ctx))?.projectId
      if (!projectId) throw new Error('This tool needs a "projectId".')
      const rows = assets.searchAssets(projectId, String(input['query'])).map((a) => ({
        id: a.id,
        key: a.key,
        name: a.name,
        kind: a.kind,
        description: a.description,
        tags: a.tags,
        designId: a.designId,
        designSubject: a.designSubject
      }))
      return { result: JSON.stringify(rows), mutatedVideoId: null, label: 'Read assets' }
    }
    case 'publish_design': {
      const asset = await assets.promoteGeneration(
        String(input['generationId']),
        String(input['name']),
        input['description'] ? String(input['description']) : undefined
      )
      return {
        result: JSON.stringify({
          assetId: asset.id,
          key: asset.key,
          designId: asset.designId,
          designSubject: asset.designSubject
        }),
        mutatedVideoId: ctx.videoId ?? '',
        label: `Design published · ${asset.name}`
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── kie.ai Claude proxy call (bare fetch — no SDK headers) ───────────────────

interface KieClaudeMessage {
  content: Anthropic.ContentBlock[]
  stop_reason: string | null
  error?: { type?: string; message?: string }
}

async function kieClaudeCreate(
  apiKey: string,
  body: Record<string, unknown>
): Promise<KieClaudeMessage> {
  const res = await fetch(`${KIE_BASE}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  let json: KieClaudeMessage
  try {
    json = JSON.parse(raw) as KieClaudeMessage
  } catch {
    throw new Error(`kie.ai Claude returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }
  if (!res.ok || json.error) {
    throw new Error(
      `kie.ai Claude failed (HTTP ${res.status}): ${json.error?.message ?? raw.slice(0, 300)}`
    )
  }
  return json
}

/** Same contract as kieClaudeCreate, over kie.ai's OpenAI Responses proxies. */
async function kieResponsesCreate(
  apiKey: string,
  path: string,
  args: {
    model: string
    system: string
    tools: Anthropic.Tool[]
    messages: Anthropic.MessageParam[]
  }
): Promise<KieClaudeMessage> {
  const res = await fetch(`${KIE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      instructions: args.system,
      input: toResponsesInput(args.messages),
      tools: toResponsesTools(args.tools),
      tool_choice: 'auto',
      stream: false
    })
  })
  const raw = await res.text()
  let json: { output?: ResponsesOutputItem[]; error?: { message?: string } }
  try {
    json = JSON.parse(raw) as typeof json
  } catch {
    throw new Error(
      `kie.ai ${args.model} returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`
    )
  }
  if (!res.ok || json.error) {
    throw new Error(
      `kie.ai ${args.model} failed (HTTP ${res.status}): ${json.error?.message ?? raw.slice(0, 300)}`
    )
  }
  return fromResponsesOutput(json.output)
}

// ── Sessions ─────────────────────────────────────────────────────────────────

interface Session {
  history: Anthropic.MessageParam[]
  items: ChatItem[]
  busy: boolean
  error: string | null
  projectId: string | null
  /** Generations launched via run_node — their completion resumes the loop. */
  watched: Set<string>
  /** Settle notes that arrived while the loop was busy. */
  pending: string[]
}

const sessions = new Map<string, Session>()

function sessionFor(videoId: string): Session {
  let session = sessions.get(videoId)
  if (!session) {
    // A restart resumes the persisted transcript — including the watched
    // generation ids that drive the automatic wake-up (busy never survives
    // a restart: whatever turn was running died with the process).
    const persisted = loadChatSession(videoId)
    session = {
      history: persisted?.history ?? [],
      items: persisted?.items ?? [],
      busy: false,
      error: null,
      projectId: persisted?.projectId ?? null,
      watched: new Set(persisted?.watched ?? []),
      pending: []
    }
    sessions.set(videoId, session)
  }
  return session
}

/** In-memory session, or a hydrated one if a transcript is persisted — never creates. */
function peekSession(videoId: string): Session | null {
  if (sessions.has(videoId)) return sessions.get(videoId)!
  return loadChatSession(videoId) ? sessionFor(videoId) : null
}

function persistSession(videoId: string, session: Session): void {
  // Video sessions need their projectId to persist; the home session has none.
  if (videoId !== HOME_CHAT_ID && !session.projectId) return
  saveChatSession(videoId, {
    projectId: session.projectId ?? '',
    history: session.history,
    items: session.items,
    watched: [...session.watched]
  })
}

export function getChatState(videoId: string): ChatState {
  const { items, busy, error } = sessionFor(videoId)
  return { items, busy, error }
}

export function clearChat(videoId: string): void {
  sessions.delete(videoId)
  deleteChatSession(videoId)
  broadcastChatUpdate(videoId)
}

/** One full agentic turn over whatever is already in the session history. */
async function runTurn(sessionKey: string, session: Session): Promise<void> {
  const kieKey = getKieApiKey()
  if (!kieKey) {
    throw new Error(
      "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."
    )
  }

  const isHome = sessionKey === HOME_CHAT_ID
  session.busy = true
  session.error = null
  broadcastChatUpdate(sessionKey)

  try {
    const model = getAssistantModel()
    // The assistant speaks the app's configured language (Settings → General),
    // not whatever language the docs/tool results happen to be in.
    const language = getLocale() === 'fr' ? 'French' : 'English'
    const system = `${isHome ? SYSTEM_HOME : SYSTEM}\n\nAlways write your replies to the user in ${language} — the application's configured language — regardless of the language of tool results, prompts or documentation. (Generation prompts themselves stay in English.)`
    const tools = isHome ? TOOLS_HOME : TOOLS
    let lastMutatedVideoId: string | null = null
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const responsesPath = OPENAI_RESPONSES_PATHS[model]
      const response = responsesPath
        ? await kieResponsesCreate(kieKey, responsesPath, {
            model,
            system,
            tools,
            messages: session.history
          })
        : await kieClaudeCreate(kieKey, {
            model,
            max_tokens: 16000,
            // Explicit: kie.ai's proxy documents stream as defaulting to true.
            stream: false,
            system,
            tools,
            messages: session.history
          })

      // Preserve the full content (incl. thinking blocks) in the history.
      session.history.push({ role: 'assistant', content: response.content })

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim() !== '') {
          session.items.push({ type: 'assistant', text: block.text })
          broadcastChatUpdate(sessionKey)
        }
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      )
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break

      const results: Anthropic.ToolResultBlockParam[] = []
      for (const toolUse of toolUses) {
        try {
          const { result, mutatedVideoId, label } = await executeTool(
            toolUse.name,
            (toolUse.input ?? {}) as Record<string, unknown>,
            { sessionKey, videoId: isHome ? null : sessionKey }
          )
          session.items.push({ type: 'tool', name: toolUse.name, label, ok: true })
          results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result })
          if (mutatedVideoId !== null) {
            lastMutatedVideoId = mutatedVideoId
            broadcastWorkflowChanged(mutatedVideoId)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          session.items.push({ type: 'tool', name: toolUse.name, label: message, ok: false })
          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: message,
            is_error: true
          })
        }
        broadcastChatUpdate(sessionKey)
      }
      // All tool results go back in a single user message.
      session.history.push({ role: 'user', content: results })
    }
    if (lastMutatedVideoId !== null) broadcastWorkflowChanged(lastMutatedVideoId)
  } catch (err) {
    session.error = err instanceof Error ? err.message : String(err)
  } finally {
    session.busy = false
    persistSession(sessionKey, session)
    broadcastChatUpdate(sessionKey)
  }

  // Settle notes that arrived mid-turn: hand them to the model right away.
  if (session.pending.length > 0) {
    const notes = session.pending.splice(0)
    injectSettleNotes(sessionKey, session, notes)
    await runTurn(sessionKey, session)
  }
}

function injectSettleNotes(videoId: string, session: Session, notes: string[]): void {
  session.items.push({
    type: 'tool',
    name: 'generation-settled',
    label: 'Generation settled — assistant resuming',
    ok: true
  })
  session.history.push({
    role: 'user',
    content: `<system-reminder>${notes.join('\n')}\nFollow up on what you told the user: check the result if useful and report back in the user's language. This is an automated wake-up, not a user message.</system-reminder>`
  })
  broadcastChatUpdate(videoId)
}

// A generation launched by the assistant settled → resume the conversation.
// peekSession also hydrates persisted transcripts, so a generation that was
// still polling across an app restart wakes the assistant up all the same.
// The home session watches generations across ALL videos, so both keys are
// candidates; whichever session actually watches this generation wins.
onGenerationSettled((event) => {
  for (const sessionKey of [event.videoId, HOME_CHAT_ID]) {
    const session = peekSession(sessionKey)
    if (!session || !session.watched.has(event.generationId)) continue
    session.watched.delete(event.generationId)
    const note =
      event.status === 'success'
        ? `Generation ${event.generationId} (node ${event.nodeId}) finished successfully.`
        : `Generation ${event.generationId} (node ${event.nodeId}) FAILED: ${event.errorMessage ?? 'unknown error'}.`
    if (session.busy) {
      session.pending.push(note)
      return
    }
    injectSettleNotes(sessionKey, session, [note])
    void runTurn(sessionKey, session)
    return
  }
})

export async function sendChatMessage(
  videoId: string,
  projectId: string,
  text: string,
  images: ChatImage[] = []
): Promise<ChatState> {
  const session = sessionFor(videoId)
  if (session.busy) throw new Error('Assistant is already working — wait for it to finish.')

  session.projectId = projectId || null
  session.items.push({
    type: 'user',
    text,
    images: images.length
      ? images.map((img) => `data:${img.mediaType};base64,${img.data}`)
      : undefined
  })
  // Attached images ride along as Anthropic image blocks; the OpenAI adapter
  // converts them to input_image data URLs for the GPT models.
  session.history.push({
    role: 'user',
    content:
      images.length === 0
        ? text
        : [
            ...images.map((img): Anthropic.ImageBlockParam => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data }
            })),
            { type: 'text', text }
          ]
  })
  persistSession(videoId, session)
  await runTurn(videoId, session)
  return getChatState(videoId)
}
