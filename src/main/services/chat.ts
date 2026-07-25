import type Anthropic from '@anthropic-ai/sdk'
import { getStyle } from '@shared/styles/registry'
import {
  HOME_CHAT_ID,
  type AppContext,
  type ChatImage,
  type ChatItem,
  type ChatPlan,
  type ChatState
} from '@shared/ipc/contracts'
import { onGenerationSettled } from '../bus'
import { broadcastChatUpdate, broadcastWorkflowChanged } from '../events'
import { AGENT_TOOLS } from '../mcp/registry'
import { startBatch, videoNodeTargets } from './runBatch'
import {
  SUMMARY_SYSTEM,
  needsCompaction,
  reassembleHistory,
  renderForSummary,
  splitForCompaction,
  stripImageBlocks
} from './chatCompaction'
import { formatAppContext } from './chatContext'
import { SseParser, createAnthropicAccumulator, createResponsesAccumulator } from './chatStream'
import { deleteChatSession, listChatSessions, loadChatSession, saveChatSession } from './chatStore'
import * as assets from './assets'
import {
  APPROVAL_REQUIRED_RESULT,
  approvalGate,
  injectBindingIds,
  toAnthropicTools
} from './chatToolAdapter'
import {
  fromResponsesOutput,
  toResponsesInput,
  toResponsesTools,
  type ResponsesOutputItem
} from './chatOpenAIFormat'
import * as graph from './graph'
import { KIE_BASE } from './kie'
import * as projects from './projects'
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

// Full-project deliveries chain many tool calls even with batching (§4.10
// phase 4 raised it from 15); the settle wake-up remains the completion path.
const MAX_ITERATIONS = 24

/** kie.ai OpenAI-Responses proxy path per GPT model (Claude ids use /claude/v1/messages). */
const OPENAI_RESPONSES_PATHS: Record<string, string> = {
  'gpt-5-6-sol': '/codex/v1/responses',
  'gpt-5.4-codex': '/api/v1/responses'
}

const SYSTEM = `You are the embedded assistant of Raccord, a node-based AI video studio.

The user is looking at a workflow graph for one video. Nodes are AI model invocations (image/video/audio generation) or project assets ('studio/asset' nodes whose params hold an assetId). Edges wire a source node's output into a target node's input: \`input\` is the target model's input field name (e.g. "image_urls"), \`output\` is "output" (main result) or "lastFrame" (last frame of a video). Running a node calls the kie.ai API and costs money.

How to work:
- User messages may start with an <app-context> block injected by the app (the user did not write it and does not see it): a snapshot of what they are looking at at send time. The current selection is where the user is looking — "this node" means selectedNodeId, and lastGenerationError is the failure they most recently saw. Use it silently; never quote the block back.
- focus_node centers the editor on a node (and selects it) — use it so the user sees the node you are talking about. open_video switches the whole app to another video's editor; only navigate when it helps the user follow, and say you did.
- Call get_workflow first whenever the current graph matters; call list_models before choosing model ids or param names — never guess them.
- The user watches the graph update live as you use tools, so keep narration brief.
- Prefer creating structure (nodes, connections, prompts) directly; ask before running generations (they cost money) unless the user explicitly asked to generate, and ask before deleting several nodes.
- Position nodes on a left-to-right flow (x: 0, 420, 840…; y spaced by ~350) so the graph stays readable.
- import_workflow with replace=true erases the existing graph — only with explicit user consent.
- Destructive tools (remove_node, delete_video, delete_project, delete_asset) never execute on the first call: the user gets an approval action card and the tool returns APPROVAL REQUIRED. End your turn and wait; once the user approves, re-call the SAME tool with the same arguments plus "confirm": true. Never pass confirm: true on the first call.
- When you launch run_node, the app automatically wakes you with a message once that generation finishes (success or failure) — you can tell the user you'll report back, then end your turn. Never poll get_generations to wait.
- To generate SEVERAL shots, prefer ONE run_batch call (targetNodeIds, or all_videos: true for every video node) over chained run_node calls: it runs the whole subgraph dependency-aware — shared upstreams generate once, independent branches in parallel, already-satisfied nodes are reused — and wakes you as each generation settles.
- The user may attach images to a message: treat them as the visual brief (subject, style, framing) and write prompts from what you see. To USE one as a workflow input, save it to the project library first with save_attachment_as_asset (name + AI-facing description; design markers when it's a character/décor/prop sheet), then reference it with a studio/asset node. Remote media URLs the user pastes go through add_asset_from_url the same way.
- Plan before building: on any multi-shot build, call present_plan (structured shots + models + estimated credits + total) BEFORE import_workflow, and before launching a batch of runs whose total cost is significant. The user gets an approval card with Approve / Request changes — WAIT for their reply before executing. This is the validation gate before spending credits (the conversational sibling of the storyboard review).

You are also the film director. When the user asks for a video (an ad, an anime scene, a realistic sequence…), don't just wire nodes — direct:
1. Establish the brief from the user's request: subject, intent, tone, duration, aspect ratio. Ask only what you truly cannot infer; propose tasteful defaults for the rest.
2. Pick an art direction: docs "styles", choose the closest style template, call set_video_style so it sticks to the video. The app then appends the style bible to prompts AT RUN TIME for every visual node whose params carry "applyVideoStyle": true (templates and design recipes set it; nodes created without explicit params get it by default). When you write params yourself (add_node / update_node / import_workflow), set "applyVideoStyle": true on visual nodes and keep the prompt shot-specific — NEVER paste the style bible into a prompt (it would be duplicated at run and freeze the art direction).
3. For a standard shape of video (product ad, anime scene, cinematic sequence, vertical social ad), start from a blueprint: docs "templates" then "template:<id>", fill the [SLOTS] with the user's subject, import_workflow — then refine per shot.
4. Break the video into shots (2-4s of intent each): establishing → action → emotion/punchline. Chain clips by wiring each video node's lastFrame output into the next node's image input so every cut is seamless.
5. Pre-visualize before spending video credits (Seedance 2): docs "designs" — design sheets (character/décor/prop) first, then one "storyboard" node per scene: a 9-panel grid built FROM the sheets (gpt-image-2-image-to-image) showing the scene beat by beat. Check the project library BEFORE generating a sheet: assets with designId/designSubject (see get_workflow, or search_assets) are published design sheets — reuse one for the same subject via a studio/asset node (reference inputs only, never a frame anchor) instead of regenerating it. And once the user approves a freshly generated sheet, publish_design it so the whole project can reuse it. The user reviews the staging on the grid, THEN you wire it as a reference on the scene's shots ("@ImageN is the 9-panel storyboard — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom"; the character sheet stays its own reference, and each shot's prompt says which panels it covers). MANDATORY on every storyboard-driven shot prompt, or the model may render the grid itself in the video: append "render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout". The storyboard encodes composition — keep the video prompts about motion: camera, rhythm, transitions.
6. Before writing ANY prompt, docs "prompting:<model id>" and follow that model's grammar exactly (camera vocabulary, dialogue syntax, @references, shot markers). Write prompts in English; per-shot: subject + action + camera + lighting + soundscape (the style bible is appended automatically via applyVideoStyle).
7. Score last: add a Suno node once the shots exist, matching the style's music hint; wire it into Seedance reference_audio_urls when the model supports it.
8. Report the estimated credit cost before proposing to run anything; propose running the cheap design/storyboard images first so the user validates the staging before any video shot.`

const SYSTEM_HOME = `You are the embedded assistant of Raccord, a node-based AI video studio — reached from the HOME screen, so you operate at PROJECT level: the user can ask you for a complete production from scratch ("create an anime project of 2.5 minutes about…") and you deliver the whole thing: project, video(s), art direction, full workflow.

Raccord hierarchy: Project → Videos (one workflow graph each) + Assets. Nodes are AI model invocations; edges wire a source node's output ("output" or "lastFrame") into a target model's input field. Running a node calls the kie.ai API and costs money.

Every graph tool here takes an explicit videoId — always pass the id of the video you created or selected (list_videos to find one). The user sees the app update live as you work; keep narration brief.

User messages may start with an <app-context> block injected by the app (the user did not write it and does not see it): a snapshot of what they are looking at at send time — route, projectId/videoId when they are inside a project or video, selectedNodeId, lastGenerationError. When it names a project or video, that is the one "this project"/"this video" refers to — use those ids directly instead of asking. Use it silently; never quote the block back. open_video switches the app to a video's editor (do it when you finish building one so the user lands on the result); focus_node centers the editor on a node of the video being viewed.

Destructive tools (remove_node, delete_video, delete_project, delete_asset) never execute on the first call: the user gets an approval action card and the tool returns APPROVAL REQUIRED. End your turn and wait; once the user approves, re-call the SAME tool with the same arguments plus "confirm": true. Never pass confirm: true on the first call.

How to deliver a full project:
1. Brief: subject, tone, duration, aspect ratio. Turn the duration into a shot plan: clips are 4-12s (8s is the sweet spot), so a 2.5-minute piece is ~18-19 shots — organize them as scenes of 3-4 shots (establishing → action → emotion). Ask only what you truly cannot infer.
2. create_project (short name from the subject), then create_video. Prefer ONE video for the whole piece (the timeline chains its clips); split into several videos only if the user asks for separate sequences.
3. docs "models" FIRST — the frame-anchor vs reference distinction decides your wiring: character sheets/storyboards go to Seedance 2 reference_image_urls (with an explicit role in the prompt, they never appear on screen); Seedance 1.5 / Grok image inputs literally BECOME frames. docs "styles" → set_video_style; the style bible is appended automatically at run time to every visual node whose params carry "applyVideoStyle": true — set that flag on the visual nodes you create and NEVER paste the bible into a prompt. For standard shapes, scale a template (docs "template:<id>") to the requested duration. On an existing project, search_assets first: published design sheets (designId/designSubject set) are reused via studio/asset nodes (reference inputs only) instead of regenerating them; publish_design a newly approved sheet so later videos can reuse it.
4. Build the graph in ONE import_workflow call (nodes + edges, left-to-right positions x: 0, 420, 840…, y by scene ~350): a key visual wired as @Image1 reference on every Seedance 2 shot (character consistency); one 9-panel storyboard node per scene (docs "designs", recipe "storyboard" — built FROM the key visual with gpt-image-2-image-to-image, wired as @Image2 reference on the scene's shots with "a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom" plus the anti-grid constraint "render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout"; it is the user's review gate before any video run); lastFrame chaining with "@Image3 as the first frame" (seamless cuts); one Suno music node per video matching the style's music hint.
5. docs "prompting:<model id>" before writing ANY prompt. English prompts: subject + action + camera + lighting + soundscape (the style bible is appended automatically via applyVideoStyle).
6. BEFORE the import_workflow of step 4, call present_plan with the structured shot plan (label, description, modelId, estimated credits per shot, total) — the user gets an approval card with Approve / Request changes buttons; WAIT for their reply before building. Same gate before launching any significant batch of runs (they cost money). To generate, prefer ONE run_batch call (targetNodeIds, or all_videos: true) over chained run_node calls: it runs the subgraph dependency-aware (shared upstreams once, parallel branches, satisfied nodes reused) and the app wakes you automatically as each generation settles — never poll.

The user may attach images to a message: treat them as the visual brief (subject, style, framing) and write prompts from what you see. To USE one as a workflow input, save it to the project library first with save_attachment_as_asset (name + AI-facing description; design markers when it's a design sheet), then reference it with a studio/asset node. Remote media URLs the user pastes go through add_asset_from_url the same way.`

// ── Tool definitions ─────────────────────────────────────────────────────────
// The graph/project/asset tools come from THE agent-tool registry
// (mcp/registry.ts) through the chat adapter: a per-video session drops the
// explicit videoId/projectId params (the executor injects them), the home
// session keeps them required. Only the two tools that need the chat session
// itself (transcript/attachments) are defined here — by design MCP has no
// equivalent.

const PRESENT_PLAN_TOOL: Anthropic.Tool = {
  name: 'present_plan',
  description:
    'Present a structured production plan for user approval BEFORE building a multi-shot graph (import_workflow) or launching a costly run batch: per-shot label/description/model/estimated credits + total. Rendered as an approval card with Approve / Request changes buttons — end your turn and WAIT for the user’s reply.',
  input_schema: {
    type: 'object',
    properties: {
      shots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'e.g. "Shot 01 — The harbor"' },
            description: { type: 'string', description: 'What happens in this shot' },
            modelId: { type: 'string' },
            estCredits: { type: 'number', description: 'Estimated kie.ai credits for this shot' },
            panels: { type: 'string', description: 'Storyboard panels covered, e.g. "1-3"' }
          },
          required: ['label', 'description', 'modelId']
        }
      },
      style: { type: 'string', description: 'Style template id/label the plan commits to' },
      totalCredits: { type: 'number', description: 'Estimated grand total in kie.ai credits' }
    },
    required: ['shots']
  }
}

const SAVE_ATTACHMENT_TOOL: Anthropic.Tool = {
  name: 'save_attachment_as_asset',
  description:
    'Save an image the user attached to their message into the project’s asset library (index 0 = first image of the most recent message with attachments). Optional designId/designSubject markers publish it as a reusable design sheet.',
  input_schema: {
    type: 'object',
    properties: {
      index: { type: 'number', description: '0-based attachment index (default 0)' },
      name: { type: 'string', description: 'Library display name' },
      description: { type: 'string', description: 'What the media depicts — shown to AIs' },
      designId: {
        type: 'string',
        description: 'Design category (character/decor/prop/styleframe/storyboard) when relevant'
      },
      designSubject: { type: 'string', description: 'The subject the sheet depicts' }
    },
    required: ['name']
  }
}

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

/** Per-video session: registry tools with the session ids implicit. */
const TOOLS: Anthropic.Tool[] = [
  ...toAnthropicTools(AGENT_TOOLS, true),
  PRESENT_PLAN_TOOL,
  SAVE_ATTACHMENT_TOOL
]

/** Home session: explicit ids everywhere (not bound to a video). */
const TOOLS_HOME: Anthropic.Tool[] = [
  ...toAnthropicTools(AGENT_TOOLS, false),
  PRESENT_PLAN_TOOL,
  withProjectIdParam(SAVE_ATTACHMENT_TOOL)
]

/** Assistant capabilities for the chat input's "/" action menu. */
export function listAssistantTools(): { name: string; description: string }[] {
  return TOOLS_HOME.map((tool) => ({
    name: tool.name,
    description: `${(tool.description ?? '').split('. ')[0] ?? ''}`.replace(/\.?$/, '.')
  }))
}

// ── Tool execution against the local services ────────────────────────────────

interface ToolCtx {
  /** Chat session key: a videoId, or HOME_CHAT_ID for the home session. */
  sessionKey: string
  /** Bound video for per-video sessions; null for the home session. */
  videoId: string | null
}

/** Explicit projectId param (home session), the session's project, or via the bound video. */
function resolveProjectId(input: Record<string, unknown>, ctx: ToolCtx): string {
  const explicit =
    typeof input['projectId'] === 'string' && input['projectId'] !== ''
      ? (input['projectId'] as string)
      : null
  if (explicit) return explicit
  const session = sessions.get(ctx.sessionKey)
  if (session?.projectId) return session.projectId
  if (ctx.videoId) {
    const projectId = videos.getVideo(ctx.videoId)?.projectId
    if (projectId) return projectId
  }
  throw new Error('This tool needs a "projectId".')
}

/** Session binding for the adapter's id injection (null = home session). */
function bindingFor(ctx: ToolCtx): { videoId: string; projectId: string } | null {
  if (!ctx.videoId) return null
  return {
    videoId: ctx.videoId,
    projectId:
      sessions.get(ctx.sessionKey)?.projectId ?? videos.getVideo(ctx.videoId)?.projectId ?? ''
  }
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolCtx
): Promise<{
  result: string
  mutatedVideoId: string | null
  label: string
  /** Rich transcript entry replacing the default tool chip (e.g. plan cards). */
  item?: ChatItem
}> {
  switch (name) {
    case 'present_plan': {
      const rawShots = Array.isArray(input['shots']) ? input['shots'] : []
      const plan: ChatPlan = {
        shots: rawShots.map((raw) => {
          const shot = (raw ?? {}) as Record<string, unknown>
          return {
            label: String(shot['label'] ?? ''),
            description: String(shot['description'] ?? ''),
            modelId: String(shot['modelId'] ?? ''),
            estCredits: typeof shot['estCredits'] === 'number' ? shot['estCredits'] : null,
            ...(shot['panels'] ? { panels: String(shot['panels']) } : {})
          }
        }),
        style: input['style'] ? String(input['style']) : null,
        totalCredits: typeof input['totalCredits'] === 'number' ? input['totalCredits'] : null
      }
      if (plan.shots.length === 0) throw new Error('A plan needs at least one shot.')
      return {
        result:
          'Plan presented to the user as an approval card. End your turn and WAIT for their Approve / Request changes reply before building or running anything.',
        mutatedVideoId: null,
        label: `Plan presented · ${plan.shots.length} shots`,
        item: { type: 'plan', plan }
      }
    }
    case 'save_attachment_as_asset': {
      const projectId = resolveProjectId(input, ctx)
      const session = sessionFor(ctx.sessionKey)
      // The most recent user message that carries image blocks — attachments
      // ride in the Anthropic history as base64 image blocks.
      let images: Anthropic.ImageBlockParam[] = []
      for (let i = session.history.length - 1; i >= 0; i--) {
        const msg = session.history[i]
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue
        const found = msg.content.filter(
          (b): b is Anthropic.ImageBlockParam => (b as { type?: string }).type === 'image'
        )
        if (found.length > 0) {
          images = found
          break
        }
      }
      if (images.length === 0) {
        throw new Error('No image attachment found in the conversation.')
      }
      const index = Number(input['index'] ?? 0)
      const image = images[index]
      if (!image) {
        throw new Error(
          `No attachment at index ${index} — the last message with images has ${images.length}.`
        )
      }
      if (image.source.type !== 'base64') {
        throw new Error('Only base64 image attachments can be saved.')
      }
      const asset = assets.importAssetFromBytes({
        projectId,
        bytes: Buffer.from(image.source.data, 'base64'),
        mimeType: image.source.media_type,
        name: String(input['name']),
        description: input['description'] ? String(input['description']) : undefined,
        designId: input['designId'] ? String(input['designId']) : undefined,
        designSubject: input['designSubject'] ? String(input['designSubject']) : undefined
      })
      return {
        result: JSON.stringify({
          assetId: asset.id,
          key: asset.key,
          kind: asset.kind,
          designId: asset.designId
        }),
        mutatedVideoId: ctx.videoId ?? '',
        label: `Asset saved · ${asset.name}`
      }
    }
    // The chat variant of the registry's run_batch (§4.10 phase 4): every
    // generation the batch claims enters session.watched as it starts, so the
    // existing settle wake-up drains the whole batch — the tool itself
    // returns immediately (the assistant never polls).
    case 'run_batch': {
      const tool = AGENT_TOOLS.find((t) => t.name === name)!
      const args = injectBindingIds(tool, input, bindingFor(ctx))
      const videoId = String(args['videoId'] ?? '')
      if (!videoId) throw new Error('run_batch needs a "videoId".')
      const targets = args['all_videos']
        ? videoNodeTargets(videoId)
        : Array.isArray(args['targetNodeIds'])
          ? (args['targetNodeIds'] as unknown[]).map(String)
          : []
      if (targets.length === 0) {
        throw new Error('Pass targetNodeIds, or all_videos: true on a graph with video nodes.')
      }
      const session = sessionFor(ctx.sessionKey)
      const { planned } = startBatch({
        videoId,
        targetNodeIds: targets,
        reuseTargets: true,
        onGenerationStarted: (_nodeId, generationId) => {
          session.watched.add(generationId)
          persistSession(ctx.sessionKey, session)
        }
      })
      return {
        result: JSON.stringify({
          planned,
          note: 'The batch runs dependency-aware in the background; you are woken automatically as each generation settles — never poll get_generations to wait.'
        }),
        mutatedVideoId: videoId,
        label: `Batch started · ${planned.length} nodes`
      }
    }
    default: {
      // Everything else IS the registry (§4.10 phase 3): one execution path
      // shared with MCP, plus the chat-only concerns — session-id injection,
      // the destructive-approval gate, transcript labels and run watching.
      const tool = AGENT_TOOLS.find((t) => t.name === name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      const args = injectBindingIds(tool, input, bindingFor(ctx))
      const gate = approvalGate(tool, args)
      if (!gate.approved) {
        const label = describeDestructiveAction(name, gate.args)
        return {
          result: APPROVAL_REQUIRED_RESULT,
          mutatedVideoId: null,
          label,
          item: { type: 'action', name, label }
        }
      }
      const result = await tool.execute(gate.args)
      // Generations launched from the chat are watched: the engine's settle
      // event wakes the conversation up (never poll).
      if (name === 'run_node') {
        sessionFor(ctx.sessionKey).watched.add((result as { generationId: string }).generationId)
      }
      return {
        result: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }),
        mutatedVideoId:
          tool.risk === 'read' ? null : String(gate.args['videoId'] ?? ctx.videoId ?? ''),
        label: (CHAT_LABELS[name] ?? (() => name.replace(/_/g, ' ')))(gate.args, result)
      }
    }
  }
}

/** Transcript chip labels for registry tools (fallback: the tool name). */
const CHAT_LABELS: Record<string, (args: Record<string, unknown>, result: unknown) => string> = {
  docs: (args) => `Read docs · ${String(args['topic'])}`,
  list_models: () => 'Read models',
  get_credits: () => 'Read credits',
  list_projects: () => 'Read projects',
  create_project: (_a, r) => `Project created · ${(r as { name?: string }).name ?? ''}`,
  rename_project: (a) => `Project renamed · ${String(a['name'] ?? '')}`,
  delete_project: () => 'Project deleted',
  list_videos: () => 'Read videos',
  create_video: (_a, r) => `Video created · ${(r as { name?: string }).name ?? ''}`,
  rename_video: (a) => `Video renamed · ${String(a['name'] ?? '')}`,
  delete_video: () => 'Video deleted',
  open_video: () => 'Opened video',
  focus_node: () => 'Focused node',
  set_video_style: (a) => {
    const styleId = a['styleId'] ? String(a['styleId']) : ''
    return `Style · ${styleId ? (getStyle(styleId)?.label ?? styleId) : 'none'}`
  },
  set_video_defaults: () => 'Video defaults updated',
  apply_video_defaults: (_a, r) =>
    `Defaults applied · ${(r as { updated?: number }).updated ?? 0} nodes`,
  get_workflow: () => 'Read workflow',
  export_workflow: () => 'Workflow exported',
  import_workflow: (_a, r) => {
    const res = r as { nodeCount?: number; edgeCount?: number }
    return `Workflow imported · ${res.nodeCount ?? 0} nodes, ${res.edgeCount ?? 0} edges`
  },
  add_node: (_a, r) => {
    const node = r as { label?: string | null; modelId?: string }
    return `Node created · ${node.label ?? node.modelId ?? ''}`
  },
  update_node: () => 'Node updated',
  connect_nodes: () => 'Edge created',
  remove_node: () => 'Node removed',
  undo: () => 'Undo',
  redo: () => 'Redo',
  estimate_cost: (_a, r) => `Cost estimated · ${(r as { credits: number | null }).credits ?? '?'}`,
  run_node: () => 'Generation started',
  get_generations: () => 'Read generations',
  select_generation: () => 'Generation selected',
  cancel_generation: (_a, r) =>
    (r as { cancelled?: boolean }).cancelled ? 'Generation cancelled' : 'Nothing to cancel',
  refresh_generation_status: (_a, r) => `Status · ${(r as { status?: string }).status ?? '?'}`,
  render_video: (_a, r) => `MP4 rendered · ${(r as { path?: string }).path ?? ''}`,
  list_assets: () => 'Read assets',
  search_assets: () => 'Read assets',
  set_asset_tags: () => 'Tags updated',
  add_asset_from_url: (_a, r) => `Asset imported · ${(r as { name?: string }).name ?? ''}`,
  add_asset_from_file: (_a, r) => `Asset imported · ${(r as { name?: string }).name ?? ''}`,
  update_asset: () => 'Asset updated',
  delete_asset: () => 'Asset deleted',
  publish_design: (_a, r) => `Design published · ${(r as { name?: string }).name ?? ''}`
}

/** Human-readable summary shown on the destructive-approval action card. */
function describeDestructiveAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'delete_project': {
      const project = projects.getProject(String(args['projectId'] ?? ''))
      return `Delete project “${project?.name ?? String(args['projectId'] ?? '?')}”`
    }
    case 'delete_video': {
      const video = videos.getVideo(String(args['videoId'] ?? ''))
      return `Delete video “${video?.name ?? String(args['videoId'] ?? '?')}”`
    }
    case 'delete_asset': {
      const asset = assets.getAsset(String(args['assetId'] ?? ''))
      return `Delete asset “${asset?.name ?? String(args['assetId'] ?? '?')}”`
    }
    case 'remove_node': {
      const ref = graph.getNodeRef(String(args['nodeId'] ?? ''))
      return `Delete node “${ref?.label ?? String(args['nodeId'] ?? '?')}” (and its generations)`
    }
    default:
      return name.replace(/_/g, ' ')
  }
}

// ── kie.ai Claude proxy call (bare fetch — no SDK headers) ───────────────────

interface KieClaudeMessage {
  content: Anthropic.ContentBlock[]
  stop_reason: string | null
  error?: { type?: string; message?: string }
}

/** Reads an SSE body, feeding each JSON `data:` payload to the callback. */
async function readSse(res: Response, onEvent: (event: unknown) => void): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('SSE response has no body')
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const feed = (payloads: string[]): void => {
    for (const payload of payloads) {
      if (payload === '[DONE]') continue
      try {
        onEvent(JSON.parse(payload))
      } catch {
        // Keepalives / non-JSON noise.
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(parser.push(decoder.decode(value, { stream: true })))
  }
  feed(parser.push(decoder.decode()))
  feed(parser.flush())
}

async function kieClaudeCreate(
  apiKey: string,
  body: Record<string, unknown>,
  onTextDelta?: (delta: string) => void
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
  // §4.10 phase 6: the proxy streams (stream: true); a JSON body remains
  // accepted as fallback (mocks, proxies that ignore the flag).
  if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const accumulator = createAnthropicAccumulator(onTextDelta)
    await readSse(res, (event) => accumulator.push(event))
    const message = accumulator.finish()
    if (message.error) {
      throw new Error(`kie.ai Claude stream failed: ${message.error.message ?? 'unknown error'}`)
    }
    return message
  }
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
  },
  onTextDelta?: (delta: string) => void
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
      stream: true
    })
  })
  // Streaming variant of the translator path (§4.10 phase 6): deltas surface
  // incrementally, the terminal response.completed event carries the full
  // output array — same shape as the non-streaming body.
  if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const accumulator = createResponsesAccumulator(onTextDelta)
    await readSse(res, (event) => accumulator.push(event))
    const final = accumulator.finish()
    if (final.error) {
      throw new Error(`kie.ai ${args.model} stream failed: ${final.error.message ?? 'unknown'}`)
    }
    return fromResponsesOutput(final.output)
  }
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
  /** User sends that arrived while the loop was busy — drained in order at
   *  the end of the turn (§4.10 phase 5: a busy session queues, never throws). */
  pendingSends: { text: string; images: ChatImage[]; context?: AppContext }[]
  /** Streaming text of the in-flight assistant turn (§4.10 phase 6). */
  partial: string | null
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
      pending: [],
      pendingSends: [],
      partial: null
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
  const { items, busy, error, partial } = sessionFor(videoId)
  return { items, busy, error, partialText: partial }
}

/** Persisted per-video threads for the sidebar's conversation switcher. */
export function listSessions(): ReturnType<typeof listChatSessions> {
  return listChatSessions()
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
    await maybeCompactHistory(sessionKey, session, kieKey, model)

    // Incremental display (§4.10 phase 6): text deltas land in
    // session.partial; broadcasts are throttled (the renderer refetches
    // chat:get on every event). The finished blocks below replace the partial.
    let lastPartialBroadcast = 0
    const onTextDelta = (delta: string): void => {
      session.partial = (session.partial ?? '') + delta
      const now = Date.now()
      if (now - lastPartialBroadcast >= 150) {
        lastPartialBroadcast = now
        broadcastChatUpdate(sessionKey)
      }
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      session.partial = null
      const response = await callProvider(
        kieKey,
        model,
        system,
        tools,
        session.history,
        onTextDelta
      )
      session.partial = null

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
          const { result, mutatedVideoId, label, item } = await executeTool(
            toolUse.name,
            (toolUse.input ?? {}) as Record<string, unknown>,
            { sessionKey, videoId: isHome ? null : sessionKey }
          )
          session.items.push(item ?? { type: 'tool', name: toolUse.name, label, ok: true })
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
    session.partial = null
    persistSession(sessionKey, session)
    broadcastChatUpdate(sessionKey)
  }

  // Settle notes that arrived mid-turn: hand them to the model right away.
  // (The recursive turn drains any queued sends at its own end.)
  if (session.pending.length > 0) {
    const notes = session.pending.splice(0)
    injectSettleNotes(sessionKey, session, notes)
    await runTurn(sessionKey, session)
    return
  }
  // User sends queued while the turn ran (§4.10 phase 5): their transcript
  // items were pushed at enqueue time — only the history entries land now.
  if (session.pendingSends.length > 0) {
    for (const send of session.pendingSends.splice(0)) {
      pushUserHistory(session, send.text, send.images, send.context)
    }
    persistSession(sessionKey, session)
    await runTurn(sessionKey, session)
  }
}

/** One provider call — Claude proxy or OpenAI-Responses proxy per model id. */
function callProvider(
  kieKey: string,
  model: string,
  system: string,
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
  onTextDelta?: (delta: string) => void
): Promise<KieClaudeMessage> {
  const responsesPath = OPENAI_RESPONSES_PATHS[model]
  return responsesPath
    ? kieResponsesCreate(kieKey, responsesPath, { model, system, tools, messages }, onTextDelta)
    : kieClaudeCreate(
        kieKey,
        { model, max_tokens: 16000, stream: true, system, tools, messages },
        onTextDelta
      )
}

/**
 * §4.10 phase 5 — when the serialized history outgrows the thresholds,
 * summarize the oldest two-thirds (images stripped) into one
 * <conversation-summary> block through the same provider path, keep the last
 * third verbatim. A summarizer failure never blocks the turn.
 */
async function maybeCompactHistory(
  sessionKey: string,
  session: Session,
  kieKey: string,
  model: string
): Promise<void> {
  if (!needsCompaction(session.history)) return
  const split = splitForCompaction(session.history)
  if (!split) return
  try {
    const rendered = renderForSummary(stripImageBlocks(split.head))
    const response = await callProvider(
      kieKey,
      model,
      SUMMARY_SYSTEM,
      [],
      [{ role: 'user', content: rendered }]
    )
    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!summary) return
    session.history = reassembleHistory(summary, split.tail)
    persistSession(sessionKey, session)
  } catch (err) {
    // Uncompacted is degraded, not broken — keep the turn going.
    console.error('[chat] history compaction failed:', err)
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

/**
 * Appends a user turn to the Anthropic history. The <app-context> snapshot
 * goes to the model alone (persisted as-sent — it was true at that turn, so
 * replays stay deterministic); attached images ride along as Anthropic image
 * blocks (the OpenAI adapter converts them to input_image data URLs).
 */
function pushUserHistory(
  session: Session,
  text: string,
  images: ChatImage[],
  context?: AppContext
): void {
  const contextBlock = formatAppContext(context)
  session.history.push({
    role: 'user',
    content:
      images.length === 0 && contextBlock === null
        ? text
        : [
            ...(contextBlock !== null
              ? [{ type: 'text', text: contextBlock } as Anthropic.TextBlockParam]
              : []),
            ...images.map((img): Anthropic.ImageBlockParam => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data }
            })),
            { type: 'text', text }
          ]
  })
}

export async function sendChatMessage(
  videoId: string,
  projectId: string,
  text: string,
  images: ChatImage[] = [],
  context?: AppContext
): Promise<ChatState> {
  const session = sessionFor(videoId)
  session.projectId = projectId || session.projectId

  // The transcript shows only what the user typed (never the context block).
  session.items.push({
    type: 'user',
    text,
    images: images.length
      ? images.map((img) => `data:${img.mediaType};base64,${img.data}`)
      : undefined
  })

  // Busy session: queue instead of throwing (§4.10 phase 5) — the transcript
  // shows the message immediately, its history entry lands when the current
  // turn drains the queue.
  if (session.busy) {
    session.pendingSends.push({ text, images, context })
    broadcastChatUpdate(videoId)
    return getChatState(videoId)
  }

  pushUserHistory(session, text, images, context)
  persistSession(videoId, session)
  await runTurn(videoId, session)
  return getChatState(videoId)
}
