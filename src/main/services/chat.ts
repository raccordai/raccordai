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
import { diffAgainstCurrent } from './checkpoints'
import { finalizeVideo, planBatch, planFinalize, startBatch, videoNodeTargets } from './runBatch'
import { clampVariants } from './runPlanner'
import {
  SUMMARY_SYSTEM,
  needsCompaction,
  reassembleHistory,
  renderForSummary,
  splitForCompaction,
  stripImageBlocks
} from './chatCompaction'
import { formatAppContext } from './chatContext'
import {
  SseParser,
  createAnthropicAccumulator,
  createResponsesAccumulator,
  isRetryableProviderError
} from './chatStream'
import {
  createChatThread,
  deleteChatSession,
  findThreadIdsWatching,
  listChatThreads,
  loadChatSession,
  renameChatThread,
  saveChatSession
} from './chatStore'
import * as assets from './assets'
import * as generations from './generations'
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
import { getAssistantModel, getAssistantRunApproval, getKieApiKey, getLocale } from './settings'
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

/** Backoff before re-issuing a provider call that failed transiently. */
const PROVIDER_RETRY_DELAYS_MS = [1000, 3000]

/**
 * No byte from the proxy for this long ⇒ the turn is stuck. Without it a
 * half-open connection pins `busy` forever, and the composer stays disabled:
 * from the user's seat, the assistant simply stopped existing.
 */
const PROVIDER_IDLE_TIMEOUT_MS = 120_000

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
- Prefer creating structure (nodes, connections, prompts) directly; ask before deleting several nodes. Whether you may launch generations on your own is decided by the app (see the RUN APPROVAL line below) — don't double-ask when it already gates you.
- Position nodes on a left-to-right flow (x: 0, 420, 840…; y spaced by ~350) so the graph stays readable. If you don't have a real layout in mind, omit positions entirely — the app lays the graph out itself. NEVER give several nodes the same coordinates, and never pass 0/0 to mean "anywhere": that is what piles nodes on top of each other.
- import_workflow with replace=true erases the existing graph — only with explicit user consent.
- Destructive tools (remove_node, delete_video, delete_project, delete_asset, restore_checkpoint) never execute on the first call: the user gets an approval action card and the tool returns APPROVAL REQUIRED. End your turn and wait; once the user approves, re-call the SAME tool with the same arguments plus "confirm": true. Never pass confirm: true on the first call. Spending tools (run_node, run_batch, finalize_video, review_generation) follow the SAME protocol whenever run approval is on — the card then shows the estimated credit cost. Emit at most ONE gated call per turn: the user approves the last card, so a second one would be ambiguous. finalize_video with plan_only: true is a free preview and is never gated.
- When you launch run_node, the app automatically wakes you with a message once that generation finishes (success or failure) — you can tell the user you'll report back, then end your turn. Never poll get_generations to wait.
- To generate SEVERAL shots, prefer ONE run_batch call (targetNodeIds, or all_videos: true for every video node) over chained run_node calls: it runs the whole subgraph dependency-aware — shared upstreams generate once, independent branches in parallel, already-satisfied nodes are reused — and wakes you as each generation settles.
- Explore in draft, finalize once approved: draft mode (set_draft_mode) substitutes every run with the model's cheap draft equivalent (5–10× cheaper, generations stamped "draft") — propose it whenever the user is iterating. Once they approve the results, finalize_video re-runs the draft keepers on the REAL models and promotes them; call it with plan_only: true first and show the draft-vs-final cost.
- When a direction is uncertain (a look to settle, a shot the user keeps rejecting), run_node/run_batch accept variants: 2–4 — N candidates of the SAME node generated in parallel, cost ×N, that the user arbitrates in the app's compare grid. Say what the multiplied cost is when you propose it, use it on ONE pivotal node rather than on a whole batch, and prefer draft mode for the exploration. Once they pick, select_generation records the keeper.
- lint_node is free and catches before the spend what the QC catches after: a reference wired but never addressed in the prompt, a design sheet on a frame anchor, a storyboard shot without the anti-grid guard, a param outside the model's enums or numeric bounds, a reference handle over its combined-length budget. Run it on the nodes you just wrote prompts for, and fix what it reports before proposing a run.
- The user annotates outputs directly on the frame (a region, or a timecode on a clip): get_annotations returns that judgment verbatim. On an image, create_edit_node builds the pre-wired fix node from those notes — read them first and refine its prompt if needed; on a clip there is no in-place edit, so fold the notes into a new shot prompt.
- Before anything structural (restructuring a sequence, replacing a model everywhere, a large import), create_checkpoint first and say you did — it costs nothing and makes the change reversible. diff_checkpoint shows what a restore would change; restore_checkpoint is destructive (it deletes the nodes created since, with their generations) and goes through the approval card.
- When the video has vision QC enabled, every successful image generation is auto-reviewed and your wake-up message carries the verdict: leave "pass" alone, and on "WARN" read the notes, look at the output and propose a concrete fix (edit node, new prompt, re-run). review_generation re-checks a single generation on demand.
- The user may attach images to a message: treat them as the visual brief (subject, style, framing) and write prompts from what you see. To USE one as a workflow input, save it to the project library first with save_attachment_as_asset (name + AI-facing description; design markers when it's a character/décor/prop sheet), then reference it with a studio/asset node. Remote media URLs the user pastes go through add_asset_from_url the same way.
- Plan before building: on any multi-shot build, call present_plan (structured shots + models + estimated credits + total) BEFORE import_workflow. The user gets an approval card with Approve / Request changes — WAIT for their reply before building. present_plan is the gate on the PRODUCTION PLAN; the run-approval card is the gate on the SPEND. Don't present a plan again just to launch runs that are already gated — that would ask the user twice.

You are also the film director. When the user asks for a video (an ad, an anime scene, a realistic sequence…), don't just wire nodes — direct:
1. Establish the brief from the user's request: subject, intent, tone, duration, aspect ratio. Ask only what you truly cannot infer; propose tasteful defaults for the rest. When the user hands you a brief or a script and wants a film out of it, the FIRST deliverable is the scenario (step 4 / write_scenario), not the graph: it is where the model's constraints are still cheap to respect and where the cuts get decided.
2. Pick an art direction: docs "styles", choose the closest style template, call set_video_style so it sticks to the video. The app then appends the style bible to prompts AT RUN TIME for every visual node whose params carry "applyVideoStyle": true (templates and design recipes set it; nodes created without explicit params get it by default). When you write params yourself (add_node / update_node / import_workflow), set "applyVideoStyle": true on visual nodes and keep the prompt shot-specific — NEVER paste the style bible into a prompt (it would be duplicated at run and freeze the art direction).
3. For a standard shape of video (product ad, anime scene, cinematic sequence, vertical social ad), start from a blueprint: docs "templates" then "template:<id>", fill the [SLOTS] with the user's subject, import_workflow — then refine per shot.
4. Break the video into shots — and when the user gives you a brief or a script, do it through write_scenario (docs "scenario") rather than in your head. You write the beats (title, action, seconds, camera, sound, closesOn, screenDirection); it returns shots whose durations the model accepts, chained by their opening/closing frames, each with a promptScaffold to write the prompt on top of. It is stored on the video and shown in the editor's Scenario panel. ALWAYS report its warnings and let the user arbitrate what is editorial: a beat under the model's floor either runs AT the floor (default, keeps your cut list, adds seconds) or merges with a neighbour (keeps the film's length, changes the cut list) — say which one you applied and what the film now totals (seven 4s shots is a 28s film, not the 20s the script asked for). Then: establishing → action → emotion/punchline. Between shots you CUT — never chain. Do NOT wire a clip's lastFrame output into the next clip's image input: a generated closing frame is motion-blurred and compressed, so the next clip re-interprets a degraded still and the seam glitches (warping faces, sliding backgrounds, a visible hitch). Give every shot a new camera setup — different angle, lens or axis — and say so in the prompt ("New camera setup: this is a cut, not a continuation of the previous shot."). Consistency comes from SHARED references wired on every shot (the same character sheet, the same storyboard), not from the previous frame. Two exceptions: real continuity (a character speaking across two clips, an unbroken move) is done with video extend — the previous CLIP into reference_video_urls (@Video1) with "[cut]"-separated next beats; and on models without references (Seedance 1.5, Grok) you keep a subject identical by re-anchoring every shot on the SAME clean source still, which is a pristine image, not a generated frame.
4b. TRANSITIONS — docs "continuity", read it before writing a multi-shot sequence. Shared references keep identity stable and still leave two consecutive clips looking like two different films, because nothing told shot N+1 what shot N ended on. So: every shot prompt says which frame it OPENS ON and which frame it CLOSES ON, shot N+1's opening restates shot N's closing, and screen direction stays continuous across the cut (a subject moving left-to-right keeps moving left-to-right; don't cross the 180° line between two shots of the same action). When a cut keeps coming out wrong, or the shots are short, board it: a "shotboard" node per shot (2x2, panel 1 = opening frame, panel 4 = closing frame) settles the hand-off on a cheap image. And when a cut genuinely needs the previous clip's look, propose link_shots — it wires each clip as @Video1 on the next shot with its role sentence, in one undo step; say the cost out loud first (the batch serializes, a re-roll invalidates the shots after it, and the handle takes 3 files / 15s combined). Never apply it to a whole sequence by default.
5. Pre-visualize before spending video credits (Seedance 2): docs "designs" — design sheets (character/décor/prop) first, then one "storyboard" node per scene: a 9-panel grid built FROM the sheets (gpt-image-2-image-to-image) showing the scene beat by beat. Check the project library BEFORE generating a sheet: assets with designId/designSubject (see get_workflow, or search_assets) are published design sheets — reuse one for the same subject via a studio/asset node (reference inputs only, never a frame anchor) instead of regenerating it. And once the user approves a freshly generated sheet, publish_design it so the whole project can reuse it. on short shots (4-6s) add a "shotboard" node per shot instead — a 9-panel scene grid only spares one panel per clip, and the 4-panel board is what pins the shot's opening and closing frames. The user reviews the staging on the grid, THEN you wire it as a reference on the scene's shots ("@ImageN is the 9-panel storyboard — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom"; the character sheet stays its own reference, and each shot's prompt says which panels it covers). MANDATORY on every storyboard-driven shot prompt, or the model may render the grid itself in the video: append "render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout". The storyboard encodes composition — keep the video prompts about motion: camera, rhythm, transitions.
6. Before writing ANY prompt, docs "prompting:<model id>" and follow that model's grammar exactly (camera vocabulary, dialogue syntax, @references, shot markers). Write prompts in English; per-shot: subject + action + camera + lighting + soundscape (the style bible is appended automatically via applyVideoStyle).
7. Score last: add a Suno node once the shots exist, matching the style's music hint; wire it into Seedance reference_audio_urls when the model supports it.
8. Report the estimated credit cost before proposing to run anything; propose running the cheap design/storyboard images first so the user validates the staging before any video shot. For iteration-heavy work, propose draft mode (explore cheap, finalize_video the approved shots on the real models).`

const SYSTEM_HOME = `You are the embedded assistant of Raccord, a node-based AI video studio — reached from the HOME screen, so you operate at PROJECT level: the user can ask you for a complete production from scratch ("create an anime project of 2.5 minutes about…") and you deliver the whole thing: project, video(s), art direction, full workflow.

Raccord hierarchy: Project → Videos (one workflow graph each) + Assets. Nodes are AI model invocations; edges wire a source node's output ("output" or "lastFrame") into a target model's input field. Running a node calls the kie.ai API and costs money.

Every graph tool here takes an explicit videoId — always pass the id of the video you created or selected (list_videos to find one). The user sees the app update live as you work; keep narration brief.

User messages may start with an <app-context> block injected by the app (the user did not write it and does not see it): a snapshot of what they are looking at at send time — route, projectId/videoId when they are inside a project or video, selectedNodeId, lastGenerationError. When it names a project or video, that is the one "this project"/"this video" refers to — use those ids directly instead of asking. Use it silently; never quote the block back. open_video switches the app to a video's editor (do it when you finish building one so the user lands on the result); focus_node centers the editor on a node of the video being viewed.

Destructive tools (remove_node, delete_video, delete_project, delete_asset, restore_checkpoint) never execute on the first call: the user gets an approval action card and the tool returns APPROVAL REQUIRED. End your turn and wait; once the user approves, re-call the SAME tool with the same arguments plus "confirm": true. Never pass confirm: true on the first call. Spending tools (run_node, run_batch, finalize_video, review_generation) follow the SAME protocol whenever run approval is on — the card then shows the estimated credit cost. Emit at most ONE gated call per turn. finalize_video with plan_only: true is free and never gated.

How to deliver a full project:
1. Brief: subject, tone, duration, aspect ratio. Ask only what you truly cannot infer.
1b. SCENARIO before graph (docs "scenario"): once the video exists, call write_scenario with the beats of the film — it returns the shot list with durations the model actually accepts (every model has a hard floor: Seedance 2 refuses under 4s), each shot chained to the next by its opening/closing frame, and a promptScaffold per shot. Clips are 4-12s (8s is the sweet spot), so a 2.5-minute piece is ~18-19 shots — organize them as scenes of 3-4 shots (establishing → action → emotion). Report the scenario's warnings and reconcile the total with the requested duration instead of letting it drift.
2. create_project (short name from the subject), then create_video. Prefer ONE video for the whole piece (the timeline chains its clips); split into several videos only if the user asks for separate sequences.
3. docs "models" FIRST — the frame-anchor vs reference distinction decides your wiring: character sheets/storyboards go to Seedance 2 reference_image_urls (with an explicit role in the prompt, they never appear on screen); Seedance 1.5 / Grok image inputs literally BECOME frames. docs "styles" → set_video_style; the style bible is appended automatically at run time to every visual node whose params carry "applyVideoStyle": true — set that flag on the visual nodes you create and NEVER paste the bible into a prompt. For standard shapes, scale a template (docs "template:<id>") to the requested duration. On an existing project, search_assets first: published design sheets (designId/designSubject set) are reused via studio/asset nodes (reference inputs only) instead of regenerating them; publish_design a newly approved sheet so later videos can reuse it.
4. Build the graph in ONE import_workflow call (nodes + edges; left-to-right positions x: 0, 420, 840…, y by scene ~350, or omit positions and let the app lay it out — never reuse one coordinate for several nodes): a key visual wired as @Image1 reference on every Seedance 2 shot (character consistency); one 9-panel storyboard node per scene (docs "designs", recipe "storyboard" — built FROM the key visual with gpt-image-2-image-to-image, wired as @Image2 reference on the scene's shots with "a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom" plus the anti-grid constraint "render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout"; it is the user's review gate before any video run); NO lastFrame chaining between shots — each shot is a CUT to a new camera setup sharing the same references (chaining a generated closing frame into the next clip glitches the seam); one Suno music node per video matching the style's music hint.
4b. TRANSITIONS — docs "continuity" before you write the shot prompts. Shared references alone leave consecutive clips looking like different films: every shot prompt states which frame it OPENS ON and which it CLOSES ON, shot N+1's opening restates shot N's closing, and screen direction stays continuous across the cut (no crossing the 180° line between two shots of the same action). Short shots (4-6s) get a "shotboard" node each (2x2: panel 1 = opening frame, panel 4 = closing frame) rather than one panel of a scene grid. For the cuts that truly need the previous clip's look, propose link_shots (previous clip as @Video1 on the next shot, one undo step) and say the cost first: it serializes generation, a re-roll invalidates the shots after it, and the handle takes 3 files / 15s combined.
5. docs "prompting:<model id>" before writing ANY prompt. English prompts: subject + action + camera + lighting + soundscape (the style bible is appended automatically via applyVideoStyle). Write each shot's prompt ON TOP OF its scenario promptScaffold — it already carries the cut, the opening and closing frames and the screen direction — and reuse the scenario's shot "key" as the node key.
6. BEFORE the import_workflow of step 4, call present_plan with the structured shot plan (label, description, modelId, estimated credits per shot, total) — the user gets an approval card with Approve / Request changes buttons; WAIT for their reply before building. That gate covers the PRODUCTION PLAN; the SPEND is gated separately by the run-approval card, so don't ask twice. To generate, prefer ONE run_batch call (targetNodeIds, or all_videos: true) over chained run_node calls: it runs the subgraph dependency-aware (shared upstreams once, parallel branches, satisfied nodes reused) and the app wakes you automatically as each generation settles — never poll. For iteration-heavy work, propose draft mode (set_draft_mode: every run substituted with a cheap draft equivalent), then finalize_video (plan_only: true first for the draft-vs-final cost) re-runs the approved keepers on the real models; when vision QC is enabled, wake-up messages carry a pass/warn verdict per image generation — only dig into the warns. On a pivotal node whose direction is uncertain, variants: 2–4 on run_node/run_batch generates that many candidates in parallel (cost ×N, announce it) for the user to arbitrate in the compare grid. Run the free lint_node on the shot nodes you wrote before proposing any run, and create_checkpoint before a structural rework — both cost nothing and both save credits.

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
  /** Conversation thread id. */
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
  // The approval gate runs BEFORE the switch, not inside its default branch:
  // run_batch and finalize_video have their own cases, so gating them from the
  // default branch would have left the two biggest spenders wide open.
  // present_plan / save_attachment_as_asset are chat-only (not in the registry)
  // and never gated. The setting is read per call — the user may flip it
  // mid-turn, and the tool schemas are built once at module load.
  const registryTool = AGENT_TOOLS.find((t) => t.name === name)
  if (registryTool) {
    const bound = injectBindingIds(registryTool, input, bindingFor(ctx))
    const gate = approvalGate(registryTool, bound, {
      requireSpendingApproval: getAssistantRunApproval() === 'ask'
    })
    if (!gate.approved && !isFreePreview(name, gate.args)) {
      const label = describeAction(name, gate.args)
      return {
        result: APPROVAL_REQUIRED_RESULT,
        mutatedVideoId: null,
        label,
        item: { type: 'action', name, label }
      }
    }
    input = gate.args
  }

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
      // Ids already injected and the gate already cleared above.
      const args = input
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
      // §6.6: variants regenerate the targets on purpose — reusing a satisfied
      // target would hand back zero candidates.
      const variants = clampVariants(args['variants'] ?? 1)
      const { planned } = startBatch({
        videoId,
        targetNodeIds: targets,
        reuseTargets: variants === 1,
        variants,
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
        label:
          variants > 1
            ? `Batch started · ${planned.length} nodes ×${variants}`
            : `Batch started · ${planned.length} nodes`
      }
    }
    // Same watched-generation wiring for the finalize batch (§6.1): the settle
    // wake-up reports each real-model re-run back to the assistant.
    case 'finalize_video': {
      const args = input
      const videoId = String(args['videoId'] ?? '')
      if (!videoId) throw new Error('finalize_video needs a "videoId".')
      const plan = planFinalize(videoId)
      if (args['plan_only'] || plan.rows.length === 0) {
        return {
          result: JSON.stringify(plan),
          mutatedVideoId: null,
          label: `Finalize preview · ${plan.rows.length} draft nodes`
        }
      }
      const session = sessionFor(ctx.sessionKey)
      const { planned } = finalizeVideo(videoId, (_nodeId, generationId) => {
        session.watched.add(generationId)
        persistSession(ctx.sessionKey, session)
      })
      return {
        result: JSON.stringify({
          planned,
          note: 'The finalize batch re-runs the draft keepers on the real models in the background and promotes each success to the node selection; you are woken automatically as each generation settles — never poll.'
        }),
        mutatedVideoId: videoId,
        label: `Finalize started · ${planned.length} nodes`
      }
    }
    default: {
      // Everything else IS the registry (§4.10 phase 3): one execution path
      // shared with MCP, plus the chat-only concerns — transcript labels and
      // run watching. Ids and the approval gate were handled above.
      if (!registryTool) throw new Error(`Unknown tool: ${name}`)
      const args = input
      const result = await registryTool.execute(args)
      // Generations launched from the chat are watched: the engine's settle
      // event wakes the conversation up (never poll).
      if (name === 'run_node') {
        // Every variant is watched: the wake-up must fire for each candidate.
        const session = sessionFor(ctx.sessionKey)
        for (const id of (result as { generationIds: string[] }).generationIds) {
          session.watched.add(id)
        }
      }
      return {
        result: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }),
        mutatedVideoId:
          registryTool.risk === 'read' ? null : String(args['videoId'] ?? ctx.videoId ?? ''),
        label: (CHAT_LABELS[name] ?? (() => name.replace(/_/g, ' ')))(args, result)
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
  set_draft_mode: (a) => `Draft mode ${a['enabled'] ? 'on' : 'off'}`,
  review_generation: (_a, r) => {
    const qc = r as { verdict?: string }
    return `Vision QC · ${qc.verdict ?? '?'}`
  },
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
  run_node: (_a, r) => {
    const count = (r as { generationIds?: string[] }).generationIds?.length ?? 1
    return count > 1 ? `${count} variants started` : 'Generation started'
  },
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
  publish_design: (_a, r) => `Design published · ${(r as { name?: string }).name ?? ''}`,
  lint_node: (_a, r) => {
    const count = (r as { findings?: unknown[] }).findings?.length ?? 0
    return count === 0 ? 'Lint · clean' : `Lint · ${count} finding${count === 1 ? '' : 's'}`
  },
  get_annotations: (_a, r) => `Read notes · ${(r as unknown[]).length}`,
  create_edit_node: () => 'Fix node created',
  create_checkpoint: (_a, r) => `Checkpoint saved · ${(r as { name?: string }).name ?? ''}`,
  list_checkpoints: () => 'Read checkpoints',
  diff_checkpoint: (_a, r) => {
    const diff = r as { identical?: boolean; name?: string }
    return `Checkpoint diff · ${diff.identical ? 'no change' : (diff.name ?? '')}`
  },
  restore_checkpoint: (_a, r) =>
    `Checkpoint restored · ${(r as { nodeCount?: number }).nodeCount ?? 0} nodes`
}

/**
 * Spending calls that cost nothing and must never raise an approval card:
 * `finalize_video` with plan_only is the free draft-vs-final estimate, and both
 * SYSTEM prompts order the model to run it before proposing the real finalize.
 */
function isFreePreview(name: string, args: Record<string, unknown>): boolean {
  return name === 'finalize_video' && args['plan_only'] === true
}

/** "~120 credits" when the estimate is known, else no suffix. */
function creditSuffix(credits: number | null | undefined): string {
  return typeof credits === 'number' && credits > 0 ? ` · ~${Math.round(credits)} credits` : ''
}

/** Human-readable summary shown on an approval action card. */
function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'run_node': {
      const nodeId = String(args['nodeId'] ?? '')
      const ref = graph.getNodeRef(nodeId)
      // §6.6: the card must quote what the whole exploration costs, not one run.
      const variants = clampVariants(args['variants'] ?? 1)
      const perRun = generations.estimateNodeRunCredits(nodeId)
      const label = ref?.label ?? (nodeId || '?')
      const suffix = creditSuffix(perRun === null ? null : perRun * variants)
      return variants > 1
        ? `Run “${label}” ×${variants} variants${suffix}`
        : `Run “${label}”${suffix}`
    }
    case 'run_batch': {
      const videoId = String(args['videoId'] ?? '')
      const targets = args['all_videos']
        ? videoNodeTargets(videoId)
        : Array.isArray(args['targetNodeIds'])
          ? (args['targetNodeIds'] as unknown[]).map(String)
          : []
      const variants = clampVariants(args['variants'] ?? 1)
      const plan = targets.length > 0 ? planBatch(videoId, targets, variants === 1, variants) : null
      const count = plan?.rows.reduce((sum, row) => sum + row.variants, 0) ?? targets.length
      return `Run ${count} generation${count === 1 ? '' : 's'}${creditSuffix(plan?.total)}`
    }
    case 'finalize_video': {
      const plan = planFinalize(String(args['videoId'] ?? ''))
      return `Finalize ${plan.rows.length} draft node${plan.rows.length === 1 ? '' : 's'} on the real models${creditSuffix(plan.totalFinal)}`
    }
    case 'review_generation':
      return 'Vision QC on this generation (small credit cost)'
  }
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
    // §6.4 — the card quotes what the rollback actually costs the user.
    case 'restore_checkpoint': {
      try {
        const diff = diffAgainstCurrent(String(args['checkpointId'] ?? ''))
        const dropped = diff.added.length
        return `Restore checkpoint “${diff.name}”${dropped > 0 ? ` — deletes ${dropped} node${dropped === 1 ? '' : 's'} created since` : ''}`
      } catch {
        return 'Restore this checkpoint'
      }
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
async function readSse(
  res: Response,
  onEvent: (event: unknown) => void,
  /** Called on every chunk read — re-arms the caller's idle watchdog. */
  onChunk?: () => void
): Promise<void> {
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
    onChunk?.()
    feed(parser.push(decoder.decode(value, { stream: true })))
  }
  feed(parser.push(decoder.decode()))
  feed(parser.flush())
}

/**
 * Runs a provider call under an inactivity watchdog: the timer is re-armed on
 * every byte received, so a long generation is fine but a dead socket isn't.
 * On expiry the fetch/read is aborted and the raw AbortError is replaced by a
 * message the user can act on.
 */
async function withIdleTimeout<T>(
  label: string,
  run: (watchdog: { signal: AbortSignal; ping: () => void }) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let expired = false
  let timer: NodeJS.Timeout | undefined
  const ping = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, PROVIDER_IDLE_TIMEOUT_MS)
  }
  ping()
  try {
    return await run({ signal: controller.signal, ping })
  } catch (err) {
    if (expired) {
      throw new Error(
        `${label} stopped responding (no data for ${PROVIDER_IDLE_TIMEOUT_MS / 1000}s).`,
        { cause: err }
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function kieClaudeCreate(
  apiKey: string,
  body: Record<string, unknown>,
  onTextDelta?: (delta: string) => void
): Promise<KieClaudeMessage> {
  return withIdleTimeout('kie.ai Claude', async ({ signal, ping }) => {
    const res = await fetch(`${KIE_BASE}/claude/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal
    })
    ping()
    // §4.10 phase 6: the proxy streams (stream: true); a JSON body remains
    // accepted as fallback (mocks, proxies that ignore the flag).
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const accumulator = createAnthropicAccumulator(onTextDelta)
      await readSse(res, (event) => accumulator.push(event), ping)
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
  })
}

/** Same contract as kieClaudeCreate, over kie.ai's OpenAI Responses proxies. */
function kieResponsesCreate(
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
  return withIdleTimeout(`kie.ai ${args.model}`, async ({ signal, ping }) => {
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
      }),
      signal
    })
    ping()
    // Streaming variant of the translator path (§4.10 phase 6): deltas surface
    // incrementally, the terminal response.completed event carries the full
    // output array — same shape as the non-streaming body.
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const accumulator = createResponsesAccumulator(onTextDelta)
      await readSse(res, (event) => accumulator.push(event), ping)
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
  })
}

// ── Sessions ─────────────────────────────────────────────────────────────────

interface Session {
  history: Anthropic.MessageParam[]
  items: ChatItem[]
  busy: boolean
  error: string | null
  projectId: string | null
  /** Bound video (legacy threads); null = unbound, i.e. home prompt + toolset. */
  videoId: string | null
  title: string | null
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

/**
 * Threads deleted while a turn was in flight. That turn holds the Session by
 * reference and re-persists it in its `finally`, which would resurrect the row
 * with a half-finished transcript — so persistSession checks this first.
 */
const deletedThreads = new Set<string>()

function sessionFor(threadId: string): Session {
  let session = sessions.get(threadId)
  if (!session) {
    // A restart resumes the persisted transcript — including the watched
    // generation ids that drive the automatic wake-up (busy never survives
    // a restart: whatever turn was running died with the process).
    const persisted = loadChatSession(threadId)
    session = {
      history: persisted?.history ?? [],
      items: persisted?.items ?? [],
      busy: false,
      error: null,
      projectId: persisted?.projectId ?? null,
      videoId: persisted?.videoId ?? null,
      title: persisted?.title ?? null,
      watched: new Set(persisted?.watched ?? []),
      pending: [],
      pendingSends: [],
      partial: null
    }
    sessions.set(threadId, session)
  }
  return session
}

/** In-memory session, or a hydrated one if a transcript is persisted — never creates. */
function peekSession(threadId: string): Session | null {
  if (sessions.has(threadId)) return sessions.get(threadId)!
  return loadChatSession(threadId) ? sessionFor(threadId) : null
}

function persistSession(threadId: string, session: Session): void {
  if (deletedThreads.has(threadId)) return
  saveChatSession(threadId, {
    projectId: session.projectId ?? '',
    videoId: session.videoId,
    title: session.title,
    history: session.history,
    items: session.items,
    watched: [...session.watched]
  })
}

export function getChatState(threadId: string): ChatState {
  const { items, busy, error, partial } = sessionFor(threadId)
  return { items, busy, error, partialText: partial }
}

/** Threads for the sidebar switcher, most recently used first. */
export function listThreads(): ReturnType<typeof listChatThreads> {
  return listChatThreads()
}

/** Opens an empty conversation and returns its id. */
export function newThread(options: { projectId?: string; videoId?: string | null } = {}): string {
  const id = createChatThread(options)
  broadcastChatUpdate(id)
  return id
}

/**
 * Guarantees the default conversation (HOME_CHAT_ID) always exists, so the
 * renderer's initial selection resolves to the same thread every time. Created
 * only when missing — never "when the table is empty": with backfilled legacy
 * threads around, the sidebar would otherwise fall back to whichever of them
 * was touched last, which is both surprising and (being video-bound) a
 * different prompt and toolset. Called at startup, after the backfill.
 */
export function ensureDefaultThread(): void {
  createChatThread({ id: HOME_CHAT_ID })
}

export function renameThread(threadId: string, title: string): void {
  renameChatThread(threadId, title)
  const session = sessions.get(threadId)
  if (session) session.title = title
  broadcastChatUpdate(threadId)
}

/** Clears a thread's transcript, keeping the thread itself. */
export function clearChat(threadId: string): void {
  const session = sessionFor(threadId)
  session.history = []
  session.items = []
  session.watched.clear()
  session.error = null
  session.partial = null
  persistSession(threadId, session)
  broadcastChatUpdate(threadId)
}

export function deleteThread(threadId: string): void {
  deletedThreads.add(threadId)
  sessions.delete(threadId)
  deleteChatSession(threadId)
  broadcastChatUpdate(threadId)
}

/** One full agentic turn over whatever is already in the session history. */
async function runTurn(sessionKey: string, session: Session): Promise<void> {
  const kieKey = getKieApiKey()
  if (!kieKey) {
    throw new Error(
      "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."
    )
  }

  // A thread is "home-like" unless it is bound to a video (legacy threads).
  // Derived from the thread's own videoId — NOT from the session key, which is
  // now an opaque thread id.
  const isHome = session.videoId === null
  session.busy = true
  session.error = null
  broadcastChatUpdate(sessionKey)

  try {
    const model = getAssistantModel()
    // The assistant speaks the app's configured language (Settings → General),
    // not whatever language the docs/tool results happen to be in.
    const language = getLocale() === 'fr' ? 'French' : 'English'
    // The run-approval mode is a setting the user can flip at any time, while
    // the SYSTEM constants are static — so it is appended per turn.
    const runMode =
      getAssistantRunApproval() === 'ask'
        ? 'RUN APPROVAL IS CURRENTLY ON: every tool that spends credits (run_node, run_batch, finalize_video, review_generation) returns APPROVAL REQUIRED on its first call and shows the user a card with the estimated cost. Emit ONE gated call, end your turn, wait, then re-call the SAME tool with "confirm": true once they approve. Never announce that a generation has started until it actually has.'
        : 'RUN APPROVAL IS CURRENTLY OFF: tools that spend credits execute immediately, so ask in plain words before launching anything expensive.'
    const system = `${isHome ? SYSTEM_HOME : SYSTEM}\n\n${runMode}\n\nAlways write your replies to the user in ${language} — the application's configured language — regardless of the language of tool results, prompts or documentation. (Generation prompts themselves stay in English.)`
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
      const response = await callProviderWithRetry(
        kieKey,
        model,
        system,
        tools,
        session.history,
        onTextDelta,
        // Each attempt replays its own deltas — drop what the failed one wrote
        // or the sidebar would show the answer twice.
        () => {
          session.partial = null
        }
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
            // The bound video comes from the thread, never from the key: the
            // key is an opaque thread id and would be injected as a videoId.
            { sessionKey, videoId: session.videoId }
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

/**
 * A provider call that is allowed to fail transiently. The proxy sometimes
 * closes a stream having sent nothing: the old loop stored the resulting empty
 * assistant message and broke out of the iteration, so a build in progress
 * (project created, video created, style set…) stopped mid-way with no text,
 * no error and no card — the user was left staring at a graph that never came.
 * An empty response is now an error like any other: retried, then surfaced.
 */
async function callProviderWithRetry(
  kieKey: string,
  model: string,
  system: string,
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
  onTextDelta: (delta: string) => void,
  onAttemptStart: () => void
): Promise<KieClaudeMessage> {
  for (let attempt = 0; ; attempt++) {
    onAttemptStart()
    try {
      const response = await callProvider(kieKey, model, system, tools, messages, onTextDelta)
      if (response.content.length === 0) {
        throw new Error(`kie.ai ${model} returned an empty response (no content).`)
      }
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const delay = PROVIDER_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryableProviderError(message)) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
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
// The watching thread is looked up in the STORE, not guessed from the event:
// thread ids are opaque, so there is nothing to derive from a videoId. The
// query also finds threads that are not in memory, which is what makes a
// generation still polling across an app restart wake its conversation up.
// peekSession then hydrates the persisted transcript.
onGenerationSettled((event) => {
  for (const sessionKey of findThreadIdsWatching(event.generationId)) {
    const session = peekSession(sessionKey)
    if (!session || !session.watched.has(event.generationId)) continue
    session.watched.delete(event.generationId)
    // §6.2 — surface the vision-QC verdict so the assistant only digs into
    // what's wrong ("generate the whole film, wake me for the bad shots").
    const qcNote =
      event.qcVerdict === 'pass'
        ? ' Vision QC: pass.'
        : event.qcVerdict === 'warn'
          ? ` Vision QC: WARN — ${event.qcNotes || 'issues found'}. Review the output and propose a fix.`
          : event.qcVerdict === 'error'
            ? ` Vision QC could not run (${event.qcNotes || 'unknown error'}).`
            : ''
    const note =
      event.status === 'success'
        ? `Generation ${event.generationId} (node ${event.nodeId}) finished successfully.${qcNote}`
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

/** Thread name derived from the first user message (trimmed to one short line). */
function deriveTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export async function sendChatMessage(
  threadId: string,
  projectId: string,
  text: string,
  images: ChatImage[] = [],
  context?: AppContext
): Promise<ChatState> {
  const session = sessionFor(threadId)
  session.projectId = projectId || session.projectId
  // Unbound threads keep projectId '' on purpose: inheriting the project the
  // user happened to be viewing would pin the thread to it forever
  // (resolveProjectId prefers session.projectId over the <app-context>).
  if (!session.title) session.title = deriveTitle(text)

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
    broadcastChatUpdate(threadId)
    return getChatState(threadId)
  }

  pushUserHistory(session, text, images, context)
  persistSession(threadId, session)
  await runTurn(threadId, session)
  return getChatState(threadId)
}
