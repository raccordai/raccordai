import { z } from 'zod'
import { MAX_VARIANTS } from '../config'
import { SCENARIO_VERSION, SCREEN_DIRECTIONS, type Scenario } from '../scenario'
import { type SpeechTranscript } from '../speech'
import { CLIP_TRANSITION_IDS, TRANSITION_MAX_SECONDS, TRANSITION_MIN_SECONDS } from '../transitions'
import { CAPTION_PRESET_IDS } from '../captions'
import {
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  RENDER_CODECS,
  RENDER_QUALITIES,
  SPEED_MAX,
  SPEED_MIN,
  VOLUME_MAX,
  VOLUME_MIN
} from '../config'
import { CLIP_LOOK_IDS } from '../looks'
import { STILL_MOTION_IDS } from '../stillMotion'
import { TEXT_ANIMATION_IDS } from '../textAnimations'

/**
 * Single source of truth for the renderer <-> main boundary.
 * Every channel declares its input and output schema; the main process
 * validates both sides at runtime, the renderer gets full static typing.
 */

export const localeSchema = z.enum(['fr', 'en'])
export type Locale = z.infer<typeof localeSchema>

/**
 * Session key of the home (project-level) assistant — used as the `videoId`
 * of the chat channels (`projectId` is '' there). It can create projects and
 * videos and build workflows anywhere; video-scoped sessions use real ids.
 */
export const HOME_CHAT_ID = 'home'

/**
 * Models the embedded assistant can run on — all served by kie.ai's market
 * proxies with the same API key. Claude ids go through /claude/v1/messages
 * (Anthropic Messages format); GPT ids go through the OpenAI Responses proxies.
 */
export const assistantModelSchema = z.enum([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gpt-5-6-sol',
  'gpt-5.4-codex'
])
export type AssistantModel = z.infer<typeof assistantModelSchema>

/**
 * Model the assistant runs on until the user picks another one — the single
 * source of truth for main's fallback and for the renderer's optimistic
 * rendering while `settings:getAssistantModel` is still in flight.
 */
export const DEFAULT_ASSISTANT_MODEL: AssistantModel = 'claude-opus-5'

/**
 * Does the assistant need the user's approval before spending credits?
 * 'ask' (default) gates every run tool behind the same approval card as the
 * destructive ones; 'auto' lets it launch generations on its own.
 */
export const assistantRunApprovalSchema = z.enum(['ask', 'auto'])
export type AssistantRunApproval = z.infer<typeof assistantRunApprovalSchema>

export const releaseChannelSchema = z.enum(['dev', 'beta', 'stable'])
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>

/** Packaged-build channel (dev is implied by an unpackaged run). */
export const updateChannelSchema = z.enum(['stable', 'beta'])
export type UpdateChannel = z.infer<typeof updateChannelSchema>

export const updateStateSchema = z.object({
  status: z.enum([
    'unsupported',
    'idle',
    'checking',
    'downloading',
    'downloaded',
    'up-to-date',
    'error'
  ]),
  version: z.string().nullable(),
  error: z.string().nullable()
})
export type UpdateState = z.infer<typeof updateStateSchema>

export const appInfoSchema = z.object({
  version: z.string(),
  channel: releaseChannelSchema,
  platform: z.string(),
  dbPath: z.string(),
  localApi: z.object({
    running: z.boolean(),
    port: z.number().nullable()
  })
})
export type AppInfo = z.infer<typeof appInfoSchema>

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Free per-project methodology (markdown) — the assistant reads AND writes this, and obeys it with priority. */
  instructions: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Project = z.infer<typeof projectSchema>

/** Video-level default aspect ratio — applied to node params only when the model supports the value. */
export const videoAspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
export type VideoAspectRatio = z.infer<typeof videoAspectRatioSchema>

/** Video-level default resolution (video models use Np, image models use NK). */
export const videoResolutionSchema = z.enum(['480p', '720p', '1080p', '1K', '2K', '4K'])
export type VideoResolution = z.infer<typeof videoResolutionSchema>

/** Scenario (§6.7) — mirrors `Scenario` in src/shared/scenario.ts (type-checked against it). */
export const scenarioShotSchema = z.object({
  key: z.string(),
  title: z.string(),
  action: z.string(),
  seconds: z.number(),
  requestedSeconds: z.number(),
  camera: z.string().optional(),
  sound: z.string().optional(),
  opensOn: z.string(),
  closesOn: z.string(),
  screenDirection: z.enum(SCREEN_DIRECTIONS).optional(),
  /** Cast roles (§6.10) appearing in the shot, by name — what §6.11 wires. */
  roles: z.array(z.string()).optional(),
  mergedFrom: z.array(z.string()).optional(),
  promptScaffold: z.string()
})

export const scenarioSchema = z.object({
  version: z.literal(SCENARIO_VERSION),
  brief: z.string(),
  modelId: z.string(),
  targetSeconds: z.number().optional(),
  shots: z.array(scenarioShotSchema),
  totalSeconds: z.number(),
  warnings: z.array(z.string())
})

/**
 * Compile-time guard: the zod mirror above and the `Scenario` type produced by
 * `planScenario` must stay identical. Typecheck fails on any drift (a field
 * added to one side only), which is what keeps the stored JSON, the IPC
 * boundary and the planner talking about the same object.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type ScenarioContractMatchesPlanner = Exactly<z.infer<typeof scenarioSchema>, Scenario>
const scenarioContractMatchesPlanner: ScenarioContractMatchesPlanner = true
void scenarioContractMatchesPlanner

export const videoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Active style template id (src/shared/styles/registry.ts), null = no style. */
  styleId: z.string().nullable(),
  /** Video-level generation defaults — pre-fill new nodes, never silently rewrite existing ones. */
  defaultAspectRatio: z.string().nullable(),
  defaultResolution: z.string().nullable(),
  /** Draft mode (§6.1): runs substitute each model's draftEquivalent until finalized. */
  draftMode: z.boolean(),
  /** Vision QC (§6.2): successful image generations get one cheap vision check. */
  qcEnabled: z.boolean(),
  /** Scenario (§6.7): the shot list the graph is built from; null until written. */
  scenario: scenarioSchema.nullable(),
  /** The niche roadmap item this video was created from (§7b), null otherwise. */
  roadmapItemId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Video = z.infer<typeof videoSchema>

export const mediaKindSchema = z.enum(['image', 'video', 'audio'])

export const assetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: mediaKindSchema,
  filePath: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
  /** Normalized (lowercase, deduplicated) user labels for filtering the library. */
  tags: z.array(z.string()),
  /** Design-recipe category when this asset is a published design sheet (e.g. 'character'). */
  designId: z.string().nullable(),
  /** The subject the design sheet was built from ("Mira, 12, red scarf"). */
  designSubject: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number().nullable()
})
export type Asset = z.infer<typeof assetSchema>

/** Display URL: media://asset/<id> for managed files, else the referenced sourceUrl. */
export const assetWithUrlSchema = assetSchema.extend({ url: z.string().nullable() })
export type AssetWithUrl = z.infer<typeof assetWithUrlSchema>

/**
 * A cast role (§6.10): the film's name for a published design sheet. The sheet
 * markers are resolved on the way out so the UI and the agents never have to
 * re-query the library to render "Léa — character sheet".
 */
export const castingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** The name the film calls this role, e.g. "Léa" — unique within the project. */
  name: z.string(),
  assetId: z.string(),
  /** Standing direction folded into every role sentence ("always wears the red scarf"). */
  notes: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  assetName: z.string(),
  designId: z.string().nullable(),
  designSubject: z.string().nullable()
})
export type Casting = z.infer<typeof castingSchema>

/** What casting a role onto a video would do — same shape dry-run or applied. */
export const castRolePlanSchema = z.object({
  castingId: z.string(),
  name: z.string(),
  /** The node already carrying the sheet in this video — null until the first cast. */
  sourceNodeId: z.string().nullable(),
  cast: z.array(
    z.object({
      nodeId: z.string(),
      label: z.string(),
      alias: z.string(),
      /** The sentence that would be appended; empty when the prompt already has it. */
      role: z.string()
    })
  ),
  alreadyCast: z.array(z.object({ nodeId: z.string(), label: z.string(), alias: z.string() })),
  skipped: z.array(z.object({ nodeId: z.string(), label: z.string(), reason: z.string() }))
})

export const castRoleResultSchema = z.object({
  castingId: z.string(),
  name: z.string(),
  sourceNodeId: z.string(),
  cast: z.array(z.object({ nodeId: z.string(), alias: z.string() })),
  alreadyCast: z.array(z.object({ nodeId: z.string(), alias: z.string() })),
  skipped: z.array(z.object({ nodeId: z.string(), reason: z.string() }))
})

/**
 * A voice persona: the channel's named voice identity (ElevenLabs voice id +
 * standing direction), app-level like niches so the same narrator serves every
 * video; optionally pinned to one niche. The casting table names who appears
 * on screen — this names who SPEAKS.
 */
export const voicePersonaSchema = z.object({
  id: z.string(),
  /** The name scripts call this voice, e.g. "Narrateur" or "Léa" — unique app-wide. */
  name: z.string(),
  /** ElevenLabs voice id (custom or premade). */
  voiceId: z.string(),
  /** Delivery notes the assistant folds into speech prompts ("calm, warm, slow"). */
  description: z.string().nullable(),
  /** Pinned channel/niche — null means available everywhere. */
  nicheId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type VoicePersona = z.infer<typeof voicePersonaSchema>

export const elevenLabsVoiceSchema = z.object({
  voiceId: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  previewUrl: z.string().nullable(),
  labels: z.record(z.string(), z.string())
})
export type ElevenLabsVoiceInfo = z.infer<typeof elevenLabsVoiceSchema>

/** Scenario → graph (§6.11): what building the shot list would create. */
export const scenarioGraphPlanSchema = z.object({
  videoId: z.string(),
  modelId: z.string(),
  shotCount: z.number(),
  build: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      recipeId: z.string(),
      modelId: z.string(),
      seconds: z.number(),
      /** Why this preset — the camera words that matched, or the fallback rule. */
      reason: z.string(),
      notes: z.array(z.string()),
      roles: z.array(z.object({ name: z.string(), castingId: z.string().nullable() }))
    })
  ),
  alreadyBuilt: z.array(z.object({ key: z.string(), title: z.string() })),
  skipped: z.array(z.object({ key: z.string(), title: z.string(), reason: z.string() })),
  unknownRoles: z.array(z.string())
})

export type ScenarioGraphPlan = z.infer<typeof scenarioGraphPlanSchema>

export const scenarioGraphResultSchema = z.object({
  videoId: z.string(),
  created: z.array(z.object({ nodeId: z.string(), key: z.string(), recipeId: z.string() })),
  alreadyBuilt: z.array(z.object({ key: z.string(), title: z.string() })),
  skipped: z.array(z.object({ key: z.string(), title: z.string(), reason: z.string() })),
  cast: z.array(
    z.object({
      castingId: z.string(),
      name: z.string(),
      nodeIds: z.array(z.string()),
      skipped: z.array(z.object({ nodeId: z.string(), reason: z.string() }))
    })
  ),
  unknownRoles: z.array(z.string())
})

/**
 * YouTube niche research (§7) — a niche is a watchlist of competitor channels,
 * the user's own channels, and the videos tracked for both. App-level (not
 * project-scoped); refreshed on demand via DataForSEO + the YouTube Data API.
 */
export const nicheSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Free positioning notes / brief — the assistant reads AND writes this. */
  description: z.string().nullable(),
  languageCode: z.string(),
  locationCode: z.number().int(),
  /** Production profile, applied to every workflow created from the roadmap. */
  styleId: z.string().nullable(),
  aspectRatio: videoAspectRatioSchema.nullable(),
  targetSeconds: z.number().int().positive().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Niche = z.infer<typeof nicheSchema>

/** A roadmap entry: a video to make, backed by tracked-data evidence. */
export const nicheRoadmapItemSchema = z.object({
  id: z.string(),
  nicheId: z.string(),
  title: z.string(),
  /** Packaging-first (§7c): candidate YouTube titles written before production. */
  titleVariants: z.array(z.string()).nullable(),
  angle: z.string().nullable(),
  /** YouTube description draft. */
  description: z.string().nullable(),
  thumbnailBrief: z.string().nullable(),
  evidence: z.string().nullable(),
  videoType: z.enum(['long', 'short']),
  status: z.enum(['idea', 'in_production', 'published']),
  /** The Raccord workflow it was assigned to (with its project, for links). */
  videoId: z.string().nullable(),
  projectId: z.string().nullable(),
  publishedVideoId: z.string().nullable(),
  /** Live stats once published, when the video is tracked in the niche. */
  published: z.object({ views: z.number(), nicheMedianViews: z.number() }).nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type NicheRoadmapItem = z.infer<typeof nicheRoadmapItemSchema>

export const nicheOverviewSchema = nicheSchema.extend({
  channelCount: z.number(),
  mineChannelCount: z.number(),
  videoCount: z.number()
})
export type NicheOverview = z.infer<typeof nicheOverviewSchema>

export const nicheChannelSchema = z.object({
  id: z.string(),
  nicheId: z.string(),
  channelId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  handle: z.string().nullable(),
  url: z.string(),
  thumbnail: z.string().nullable(),
  /** -1 = hidden subscriber count. */
  subscribers: z.number(),
  videoCount: z.number(),
  viewCount: z.number(),
  channelCreatedAt: z.string().nullable(),
  uploadsPlaylistId: z.string().nullable(),
  /** True for the user's own channels — what the niche analysis compares against. */
  isMine: z.boolean(),
  notes: z.string().nullable(),
  lastRefreshedAt: z.number().nullable(),
  createdAt: z.number()
})
export type NicheChannel = z.infer<typeof nicheChannelSchema>

/** Transcript text stays out of list payloads — fetch it per video. */
export const nicheVideoSchema = z.object({
  id: z.string(),
  nicheId: z.string(),
  videoId: z.string(),
  channelId: z.string(),
  channelTitle: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  thumbnail: z.string().nullable(),
  publishedAt: z.string().nullable(),
  views: z.number(),
  /** Engagement stats — null on rows ingested before they were tracked. */
  likeCount: z.number().nullable(),
  commentCount: z.number().nullable(),
  /** BCP-47 audio language when YouTube declares it. */
  language: z.string().nullable(),
  /** false = the API says no captions exist (transcript fetch is pointless). */
  hasCaptions: z.boolean().nullable(),
  /** SERP position when the video came from a keyword search. */
  serpRank: z.number().nullable(),
  durationSeconds: z.number(),
  madeForKids: z.boolean(),
  channelSubscribers: z.number(),
  channelCreatedAt: z.string().nullable(),
  source: z.enum(['channel', 'search']),
  keyword: z.string().nullable(),
  hasTranscript: z.boolean(),
  /** Second outlier lens: views vs the channel's own median (≥3 tracked videos). */
  channelRatio: z.number().nullable(),
  /** Velocity: measured views/day over snapshots, or lifetime average as fallback. */
  viewsPerDay: z.number().nullable(),
  statsRefreshedAt: z.number().nullable(),
  createdAt: z.number()
})
export type NicheVideo = z.infer<typeof nicheVideoSchema>

/** One keyword-search hit, enriched and scorable (ratio = views/subscribers). */
export const nicheScoredVideoSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  thumbnail: z.string(),
  publishedAt: z.string().nullable(),
  views: z.number(),
  likeCount: z.number().nullable(),
  commentCount: z.number().nullable(),
  tags: z.array(z.string()),
  categoryId: z.string().nullable(),
  durationSeconds: z.number(),
  madeForKids: z.boolean(),
  hasCaptions: z.boolean().nullable(),
  /** SERP position — what the DataForSEO scrape is actually paid for. */
  serpRank: z.number().nullable(),
  channelId: z.string(),
  channelTitle: z.string(),
  channelUrl: z.string(),
  channelThumbnail: z.string(),
  channelSubscribers: z.number(),
  channelVideoCount: z.number(),
  channelViewCount: z.number(),
  channelCreatedAt: z.string().nullable(),
  language: z.string().nullable()
})
export type NicheScoredVideoDto = z.infer<typeof nicheScoredVideoSchema>

export const nicheVideoFiltersSchema = z.object({
  format: z.enum(['all', 'long', 'short']).optional(),
  maxSubscribers: z.number().int().positive().nullable().optional(),
  maxChannelAgeMonths: z.number().positive().nullable().optional(),
  minViews: z.number().int().min(0).nullable().optional(),
  madeForKidsOnly: z.boolean().optional(),
  sort: z.enum(['ratio', 'views', 'date']).optional(),
  language: z.string().nullable().optional()
})
export type NicheVideoFiltersInput = z.infer<typeof nicheVideoFiltersSchema>

/** Per-channel aggregates over the videos tracked in the niche. */
export const nicheChannelAggregatesSchema = z.object({
  videosTracked: z.number(),
  totalViews: z.number(),
  avgViews: z.number(),
  medianViews: z.number(),
  avgDurationSeconds: z.number(),
  uploadsPerMonth: z.number().nullable()
})
export type NicheChannelAggregates = z.infer<typeof nicheChannelAggregatesSchema>

export const nicheRefreshResultSchema = z.object({
  channelsRefreshed: z.number(),
  videosAdded: z.number(),
  videosUpdated: z.number(),
  /** YouTube Data API units spent (estimation — quota resets midnight Pacific). */
  quotaUsed: z.number()
})
export type NicheRefreshResult = z.infer<typeof nicheRefreshResultSchema>

export const positionSchema = z.object({ x: z.number(), y: z.number() })

export const clipTransitionSchema = z.enum(CLIP_TRANSITION_IDS)
export type ClipTransition = z.infer<typeof clipTransitionSchema>

/**
 * One timeline SEGMENT of a clip (§6.12e — split/razor): its own trim window
 * inside the node's media and its own transition into whatever follows. A node
 * without `segments` plays as ONE implicit segment read from the historical
 * trim/transition columns; splitting materializes the array. Segments of one
 * node are always adjacent on the timeline (reordering stays node-grained).
 */
export const timelineSegmentSchema = z.object({
  trimStartSec: z.number().nullable().optional(),
  trimEndSec: z.number().nullable().optional(),
  transitionAfter: z.string().nullable().optional(),
  transitionDurationSec: z.number().nullable().optional()
})
export type TimelineSegment = z.infer<typeof timelineSegmentSchema>

/** Text layer burned over a clip: ASS numpad alignment (1–9) + size preset. */
export const clipOverlaySchema = z.object({
  text: z.string().trim().min(1).max(200),
  align: z.number().int().min(1).max(9),
  size: z.enum(['sm', 'md', 'lg'])
})
export type ClipOverlay = z.infer<typeof clipOverlaySchema>

/**
 * A sticker on the timeline (§6.12d): an image overlay in absolute
 * final-timeline seconds, normalized CENTER position, width as % of the output
 * width. The image comes from an image node's output OR a project asset
 * (exactly one of nodeId/assetId). Composited at render (overlay pass).
 */
export const imageLayerSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  nodeId: z.string().nullable(),
  assetId: z.string().nullable(),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  widthPct: z.number().min(1).max(100),
  createdAt: z.number()
})
export type ImageLayer = z.infer<typeof imageLayerSchema>

/** Creation payload: one of nodeId/assetId required (service-enforced). */
export const imageLayerInputSchema = imageLayerSchema
  .omit({ id: true, createdAt: true })
  .partial({ nodeId: true, assetId: true, x: true, y: true, widthPct: true })

/**
 * A free text layer on the timeline (§6.12b): absolute final-timeline seconds,
 * normalized frame position + ASS numpad anchor, own typography. Burned at
 * render through the libass pass; previewed (and dragged) on the player.
 */
export const textLayerSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  content: z.string().trim().min(1).max(500),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  anchor: z.number().int().min(1).max(9),
  fontFamily: z.string().trim().min(1).max(80).nullable(),
  sizePct: z.number().min(1).max(30),
  bold: z.boolean(),
  italic: z.boolean(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Entrance animation preset (a TEXT_ANIMATIONS id, null = static). */
  animation: z.enum(TEXT_ANIMATION_IDS).nullable(),
  createdAt: z.number()
})
export type TextLayer = z.infer<typeof textLayerSchema>

/** Creation payload: everything but the generated id/createdAt; styling optional. */
export const textLayerInputSchema = textLayerSchema.omit({ id: true, createdAt: true }).partial({
  x: true,
  y: true,
  anchor: true,
  fontFamily: true,
  sizePct: true,
  bold: true,
  italic: true,
  colorHex: true,
  animation: true
})

/**
 * A feedback note (§6.13): a comment taken while watching the timeline,
 * anchored to a final-timeline timecode and to the node under the playhead
 * (label snapshotted so the note survives node deletion/renaming). Worked
 * through in the editor's feedback panel and by agents via MCP.
 */
export const feedbackItemSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  nodeId: z.string().nullable(),
  nodeLabel: z.string().trim().min(1).max(200).nullable(),
  timecodeSec: z.number().min(0).nullable(),
  comment: z.string().trim().min(1).max(2000),
  status: z.enum(['open', 'done']),
  createdAt: z.number()
})
export type FeedbackItem = z.infer<typeof feedbackItemSchema>

/** Creation payload: everything but the generated id/createdAt; anchors optional. */
export const feedbackItemInputSchema = feedbackItemSchema
  .omit({ id: true, createdAt: true })
  .partial({ nodeId: true, nodeLabel: true, timecodeSec: true, status: true })

export const graphNodeSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  key: z.string(),
  modelId: z.string(),
  label: z.string().nullable(),
  intent: z.string().nullable(),
  position: positionSchema,
  params: z.unknown(),
  selectedGenerationId: z.string().nullable(),
  // Timeline editing (additive columns): explicit slot, trim window, and the
  // transition into the NEXT clip. Optional so pre-existing GraphNode literals
  // (tests, snapshots) stay valid; shared helpers treat undefined as null.
  timelineOrder: z.number().nullable().optional(),
  trimStartSec: z.number().nullable().optional(),
  trimEndSec: z.number().nullable().optional(),
  transitionAfter: z.string().nullable().optional(),
  transitionDurationSec: z.number().nullable().optional(),
  overlay: clipOverlaySchema.nullable().optional(),
  /** Audio-lane volume gain (0–2, null = 1) — read through the shared clipVolume. */
  volume: z.number().nullable().optional(),
  /** Clip playback speed (0.25–4, null = 1) — read through the shared clipSpeed. */
  speed: z.number().nullable().optional(),
  /** Colour look baked at render (a CLIP_LOOKS id) — read through the shared clipLook. */
  look: z.string().nullable().optional(),
  /** Ken Burns preset of a STILL slot (a STILL_MOTIONS id) — shared stillMotionOf. */
  stillMotion: z.string().nullable().optional(),
  /** Absolute start of an AUDIO track (final-timeline s) — shared clipTimelineOffset. */
  timelineOffsetSec: z.number().nullable().optional(),
  /** Split clip (§6.12e): materialized segments, null = one implicit segment. */
  segments: z.array(timelineSegmentSchema).nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const graphEdgeSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  sourceNodeId: z.string(),
  sourceHandle: z.string(),
  targetNodeId: z.string(),
  targetHandle: z.string(),
  createdAt: z.number()
})
export type GraphEdge = z.infer<typeof graphEdgeSchema>

export const generationStatusSchema = z.enum(['pending', 'running', 'success', 'failed'])

/** Vision-QC verdict (§6.2): 'error' means the QC call itself failed. */
export const qcVerdictSchema = z.enum(['pass', 'warn', 'error'])
export type QcVerdict = z.infer<typeof qcVerdictSchema>

/** Zod mirror of shared/speech's SpeechTranscript (compile-checked below). */
export const speechTranscriptSchema: z.ZodType<SpeechTranscript> = z.object({
  text: z.string(),
  segments: z.array(
    z.object({
      start: z.number().nullable(),
      end: z.number().nullable(),
      text: z.string(),
      speaker: z.string().optional()
    })
  )
})

export const generationSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  videoId: z.string(),
  status: generationStatusSchema,
  kieTaskId: z.string().nullable(),
  inputSnapshot: z.unknown(),
  /** Display URL: media://generation/<id>/result once local, else the remote kie.ai URL. */
  url: z.string().nullable(),
  lastFrameUrl: z.string().nullable(),
  resultMimeType: z.string().nullable(),
  /** True when the run was substituted to the model's draftEquivalent (§6.1). */
  draft: z.boolean(),
  /** Vision-QC verdict (§6.2) — 'pass' | 'warn' | 'error', null = not checked. */
  qcVerdict: qcVerdictSchema.nullable(),
  qcNotes: z.string().nullable(),
  /** Speech runs only (§8): what was spoken, with per-segment timestamps. */
  transcript: speechTranscriptSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable()
})
export type Generation = z.infer<typeof generationSchema>

/** The portable workflow JSON (version 1) — same interchange format as video-studio. */
export const workflowExportSchema = z.object({
  version: z.literal(1),
  assets: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      kind: mediaKindSchema,
      mimeType: z.string().optional(),
      description: z.string()
    })
  ),
  nodes: z.array(
    z.object({
      key: z.string(),
      modelId: z.string(),
      label: z.string().optional(),
      intent: z.string().optional(),
      position: positionSchema,
      params: z.record(z.string(), z.unknown())
    })
  ),
  edges: z.array(
    z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      input: z.string(),
      output: z.string()
    })
  )
})
export type WorkflowExport = z.infer<typeof workflowExportSchema>

/**
 * A structured production plan presented by the assistant before building or
 * running (§4.7): per-shot model + estimated cost, rendered as an approval
 * card in the chat panel.
 */
export const chatPlanSchema = z.object({
  shots: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      modelId: z.string(),
      estCredits: z.number().nullable(),
      /** Storyboard panels this shot covers (e.g. "1-3"), when relevant. */
      panels: z.string().optional()
    })
  ),
  /** Style template id or label the plan commits to, when one was chosen. */
  style: z.string().nullable(),
  totalCredits: z.number().nullable()
})
export type ChatPlan = z.infer<typeof chatPlanSchema>

/**
 * Snapshot of what the user is looking at, attached to a chat send (§4.10
 * phase 2). All-optional: the renderer fills what it cheaply knows; the chat
 * service renders it as an <app-context> block for the model (never shown in
 * the transcript).
 */
export const appContextSchema = z.object({
  route: z.string().optional(),
  projectId: z.string().optional(),
  videoId: z.string().optional(),
  selectedNodeId: z.string().optional(),
  selectedGenerationId: z.string().optional(),
  /** The niche page the user is on (§7), if any. */
  nicheId: z.string().optional(),
  /** Last generation error surfaced to the user (toast), if any. */
  lastError: z.string().optional()
})
export type AppContext = z.infer<typeof appContextSchema>

/** An image attached to a chat message (base64, no data: prefix). */
export const chatImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().min(1)
})
export type ChatImage = z.infer<typeof chatImageSchema>

/** One rendered entry of the assistant conversation (Claude-style transcript). */
export const chatItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    text: z.string(),
    /** Data URLs of the images attached to this message (thumbnail display). */
    images: z.array(z.string()).optional()
  }),
  z.object({ type: z.literal('assistant'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    label: z.string(),
    ok: z.boolean()
  }),
  z.object({ type: z.literal('plan'), plan: chatPlanSchema }),
  /** Destructive-approval action card (§4.10 phase 3): shown when a destructive
   *  tool was called without confirm — Approve / Request changes post back. */
  z.object({ type: z.literal('action'), name: z.string(), label: z.string() })
])
export type ChatItem = z.infer<typeof chatItemSchema>

export const chatStateSchema = z.object({
  items: z.array(chatItemSchema),
  busy: z.boolean(),
  error: z.string().nullable(),
  /** Streaming text of the in-flight assistant turn (§4.10 phase 6). */
  partialText: z.string().nullable()
})
export type ChatState = z.infer<typeof chatStateSchema>

/**
 * Live view of the generation queue (ids are generation ids). `queued` is in
 * start order — a node's queue position is its index + 1. `retrying` maps a
 * generation to its current automatic-retry attempt (1-based, max 3).
 */
export const queueStateSchema = z.object({
  running: z.array(z.string()),
  queued: z.array(z.string()),
  limit: z.number().int().min(1),
  retrying: z.record(z.string(), z.number())
})
export type QueueState = z.infer<typeof queueStateSchema>

/**
 * Variants ×N (§6.6) — parallel candidates claimed for one node. Omitted or 1
 * means a plain single run; the cap keeps an exploration from silently
 * multiplying the bill.
 */
export const variantsSchema = z.number().int().min(1).max(MAX_VARIANTS).optional()

/** §6.3 — a note the user left on one generation (region or timecode). */
export const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
})
export const annotationSchema = z.object({
  id: z.string(),
  region: regionSchema.nullable(),
  timecodeSec: z.number().nullable(),
  comment: z.string()
})

/** §6.4 — a named graph capture, listed newest first. */
export const checkpointSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  name: z.string(),
  nodeCount: z.number().int().min(0),
  createdAt: z.number()
})

/** §6.4 — what restoring a checkpoint would change in the current graph. */
export const checkpointDiffSchema = z.object({
  name: z.string(),
  added: z.array(z.object({ key: z.string(), label: z.string() })),
  removed: z.array(z.object({ key: z.string(), label: z.string() })),
  changed: z.array(
    z.object({ key: z.string(), label: z.string(), changedParams: z.array(z.string()) })
  ),
  edgesAdded: z.array(z.string()),
  edgesRemoved: z.array(z.string()),
  selectionChanged: z.array(z.string()),
  identical: z.boolean()
})

/** A prompt-lint finding (§6.5) as it crosses the IPC boundary. */
export const lintFindingSchema = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string()
})

/** One line of the pre-run cost preview (§4.4), variants-aware since §6.6. */
export const plannedRowSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  /** Total for this node: per-run estimate × variants (null = no declared rates). */
  credits: z.number().nullable(),
  variants: z.number().int().min(1),
  /** §6.5 — what the prompt lint says about this node, shown in the run confirm. */
  lint: z.array(lintFindingSchema)
})
export type PlannedRow = z.infer<typeof plannedRowSchema>

export const ipcContracts = {
  'app:getInfo': { input: z.void(), output: appInfoSchema },
  'settings:getLocale': { input: z.void(), output: localeSchema },
  'settings:setLocale': { input: localeSchema, output: z.void() },
  'projects:list': { input: z.void(), output: z.array(projectSchema) },
  'projects:get': { input: z.object({ id: z.string() }), output: projectSchema.nullable() },
  'projects:create': { input: z.object({ name: z.string().trim().min(1) }), output: projectSchema },
  'projects:delete': { input: z.object({ id: z.string() }), output: z.void() },

  'projects:overview': {
    input: z.void(),
    output: z.array(
      projectSchema.extend({
        videoCount: z.number(),
        thumbnailUrl: z.string().nullable(),
        thumbnailKind: mediaKindSchema.nullable()
      })
    )
  },
  'projects:rename': {
    input: z.object({ id: z.string(), name: z.string().trim().min(1) }),
    output: z.void()
  },
  'projects:setInstructions': {
    input: z.object({
      id: z.string(),
      instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).nullable()
    }),
    output: z.void()
  },

  'videos:listByProject': {
    input: z.object({ projectId: z.string() }),
    output: z.array(videoSchema)
  },
  'videos:overview': {
    input: z.object({ projectId: z.string() }),
    output: z.array(
      videoSchema.extend({
        clipCount: z.number(),
        nodeCount: z.number(),
        thumbnailUrl: z.string().nullable(),
        thumbnailKind: mediaKindSchema.nullable()
      })
    )
  },
  'videos:get': { input: z.object({ videoId: z.string() }), output: videoSchema.nullable() },
  'videos:create': {
    input: z.object({ projectId: z.string(), name: z.string().trim().min(1) }),
    output: videoSchema
  },
  'videos:rename': {
    input: z.object({ videoId: z.string(), name: z.string().trim().min(1) }),
    output: z.void()
  },
  'videos:remove': { input: z.object({ videoId: z.string() }), output: z.void() },
  'videos:setStyle': {
    input: z.object({ videoId: z.string(), styleId: z.string().nullable() }),
    output: z.void()
  },
  /** Video-level generation defaults (null clears; omitted fields are untouched). */
  'videos:setDefaults': {
    input: z.object({
      videoId: z.string(),
      defaultAspectRatio: videoAspectRatioSchema.nullable().optional(),
      defaultResolution: videoResolutionSchema.nullable().optional()
    }),
    output: z.void()
  },
  /** Bulk-apply the video defaults to every compatible existing node — one undoable step. */
  'nodes:applyVideoDefaults': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ updated: z.number() })
  },
  /** Draft mode (§6.1): while on, runs substitute each model's draftEquivalent. */
  'videos:setDraftMode': {
    input: z.object({ videoId: z.string(), enabled: z.boolean() }),
    output: z.void()
  },
  /** Vision QC (§6.2): while on, successful image generations get one cheap vision check. */
  'videos:setQcEnabled': {
    input: z.object({ videoId: z.string(), enabled: z.boolean() }),
    output: z.void()
  },

  'assets:listByProject': {
    input: z.object({ projectId: z.string() }),
    output: z.array(assetWithUrlSchema)
  },
  'assets:get': {
    input: z.object({ assetId: z.string() }),
    output: assetWithUrlSchema.nullable()
  },
  /** Opens the native file picker and imports the selected media files. */
  'assets:importFromDialog': {
    input: z.object({ projectId: z.string() }),
    output: z.array(assetWithUrlSchema)
  },
  /**
   * Import local media files by absolute path (canvas drag-and-drop — paths
   * come from the preload's getPathForFile). Unsupported files are skipped;
   * only the imported assets are returned.
   */
  'assets:importFromPaths': {
    input: z.object({ projectId: z.string(), paths: z.array(z.string()).min(1) }),
    output: z.array(assetWithUrlSchema)
  },
  'assets:update': {
    input: z.object({
      assetId: z.string(),
      name: z.string().trim().min(1).optional(),
      description: z.string().nullable().optional(),
      designSubject: z.string().nullable().optional()
    }),
    output: z.void()
  },
  'assets:remove': { input: z.object({ assetId: z.string() }), output: z.void() },
  /** Videos whose workflow references this asset through a studio/asset node (delete guard). */
  'assets:references': {
    input: z.object({ assetId: z.string() }),
    output: z.array(z.object({ videoId: z.string(), videoName: z.string(), nodeCount: z.number() }))
  },
  'assets:setTags': {
    input: z.object({ assetId: z.string(), tags: z.array(z.string()) }),
    output: z.void()
  },
  /** Groups (2+) of asset ids whose file content is byte-identical. */
  'assets:duplicateGroups': {
    input: z.object({ projectId: z.string() }),
    output: z.array(z.array(z.string()))
  },
  /**
   * Copies an asset's managed file to a user-picked path — native save dialog
   * in the handler; null = cancelled.
   */
  'assets:export': {
    input: z.object({ assetId: z.string() }),
    output: z.object({ path: z.string() }).nullable()
  },

  /** Casting (§6.10) — the project's named identities. */
  'casting:listByProject': {
    input: z.object({ projectId: z.string() }),
    output: z.array(castingSchema)
  },
  'casting:create': {
    input: z.object({
      projectId: z.string(),
      name: z.string().trim().min(1),
      assetId: z.string(),
      notes: z.string().nullable().optional()
    }),
    output: castingSchema
  },
  'casting:update': {
    input: z.object({
      castingId: z.string(),
      name: z.string().trim().min(1).optional(),
      /** Re-point the role at a regenerated sheet — shots keep their wiring. */
      assetId: z.string().optional(),
      notes: z.string().nullable().optional()
    }),
    output: castingSchema
  },
  /** Forgets the role. Shots already cast keep their reference and their prompt. */
  'casting:remove': { input: z.object({ castingId: z.string() }), output: z.void() },
  /** Dry run: what `casting:apply` would wire, without touching the graph. */
  'casting:plan': {
    input: z.object({
      videoId: z.string(),
      castingId: z.string(),
      nodeIds: z.array(z.string()).optional()
    }),
    output: castRolePlanSchema
  },
  'casting:apply': {
    input: z.object({
      videoId: z.string(),
      castingId: z.string(),
      /** Defaults to every shot of the video. */
      nodeIds: z.array(z.string()).optional()
    }),
    output: castRoleResultSchema
  },
  /**
   * Scenario → graph (§6.11). `plan` is free and touches nothing; `build`
   * creates one shot-preset node per shot and casts the roles the scenario
   * named, in ONE undo step.
   */
  'scenario:planGraph': {
    input: z.object({ videoId: z.string(), shotKeys: z.array(z.string()).optional() }),
    output: scenarioGraphPlanSchema
  },
  'scenario:buildGraph': {
    input: z.object({ videoId: z.string(), shotKeys: z.array(z.string()).optional() }),
    output: scenarioGraphResultSchema
  },
  /** Roles whose sheet is already on this video's canvas, by node id. */
  'casting:onVideo': {
    input: z.object({ videoId: z.string(), projectId: z.string() }),
    output: z.array(z.object({ castingId: z.string(), nodeId: z.string() }))
  },

  'graph:get': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ nodes: z.array(graphNodeSchema), edges: z.array(graphEdgeSchema) })
  },
  'graph:timelineFallbackImages': {
    // 'failed' (default) = the render's substitution scope; 'missing' = every
    // video node without a success yet (the preview's animatic mode).
    input: z.object({ videoId: z.string(), scope: z.enum(['failed', 'missing']).optional() }),
    output: z.record(z.string(), z.string())
  },
  'nodes:create': {
    input: z.object({
      videoId: z.string(),
      modelId: z.string(),
      position: positionSchema,
      key: z.string().optional(),
      params: z.unknown().optional(),
      label: z.string().optional(),
      intent: z.string().optional()
    }),
    output: graphNodeSchema
  },
  /**
   * §6.8 — create a pre-configured node from a recipe (design sheet or shot
   * preset), optionally wired to its source in ONE undo step. The renderer
   * builds the same prompt locally for the preview; only this channel writes.
   */
  'recipes:createNode': {
    input: z.object({
      videoId: z.string(),
      recipeId: z.string(),
      /** Defaults to the recipe's first mode. */
      modeId: z.string().optional(),
      /** Overrides the mode's model — must be one of the recipe's supportedModels. */
      modelId: z.string().optional(),
      values: z.record(z.string(), z.string()),
      /** The media feeding a from-image/from-video mode: an asset OR a node. */
      source: z
        .object({ assetId: z.string().optional(), nodeId: z.string().optional() })
        .optional(),
      position: positionSchema.optional()
    }),
    output: z.object({
      nodeId: z.string(),
      modelId: z.string(),
      modeId: z.string(),
      prompt: z.string(),
      sourceNodeId: z.string().nullable(),
      handleKey: z.string().nullable()
    })
  },
  'nodes:updateParams': {
    input: z.object({ nodeId: z.string(), params: z.unknown() }),
    output: z.void()
  },
  'nodes:updateLabel': {
    input: z.object({ nodeId: z.string(), label: z.string() }),
    output: z.void()
  },
  'nodes:updateIntent': {
    input: z.object({ nodeId: z.string(), intent: z.string() }),
    output: z.void()
  },
  'nodes:updatePosition': {
    input: z.object({ nodeId: z.string(), position: positionSchema }),
    output: z.void()
  },
  'nodes:updatePositions': {
    input: z.object({
      updates: z.array(z.object({ nodeId: z.string(), position: positionSchema }))
    }),
    output: z.void()
  },
  /** Timeline editing: stamps the explicit slot of every listed clip (one undo step). */
  'nodes:setTimelineOrder': {
    input: z.object({ videoId: z.string(), nodeIds: z.array(z.string()).min(1) }),
    output: z.void()
  },
  /** Trim window inside the clip's media; null clears a bound. On a SPLIT clip,
   *  segmentIndex targets one segment (omitted = the historical single clip). */
  'nodes:setTrim': {
    input: z.object({
      nodeId: z.string(),
      trimStartSec: z.number().min(0).nullable(),
      trimEndSec: z.number().positive().nullable(),
      segmentIndex: z.number().int().min(0).optional()
    }),
    output: z.void()
  },
  /** Transition into the NEXT clip at render time (a library id | null = cut). */
  'nodes:setTransition': {
    input: z.object({
      nodeId: z.string(),
      transition: clipTransitionSchema.nullable(),
      durationSec: z
        .number()
        .min(TRANSITION_MIN_SECONDS)
        .max(TRANSITION_MAX_SECONDS)
        .nullable()
        .optional(),
      segmentIndex: z.number().int().min(0).optional()
    }),
    output: z.void()
  },
  /** Split (§6.12e): cut a clip in two at a MEDIA-time point (razor). */
  'nodes:splitClip': {
    input: z.object({ nodeId: z.string(), atMediaSec: z.number().min(0) }),
    output: z.void()
  },
  /** Remove ONE segment of a split clip (the last two collapse back to one). */
  'nodes:removeSegment': {
    input: z.object({ nodeId: z.string(), segmentIndex: z.number().int().min(0) }),
    output: z.void()
  },
  /** Text layer burned over a clip at render time (null clears it). */
  'nodes:setOverlay': {
    input: z.object({ nodeId: z.string(), overlay: clipOverlaySchema.nullable() }),
    output: z.void()
  },
  /** Volume gain of an audio track (music/speech lane): 0–2, null = original. */
  'nodes:setVolume': {
    input: z.object({
      nodeId: z.string(),
      volume: z.number().min(VOLUME_MIN).max(VOLUME_MAX).nullable()
    }),
    output: z.void()
  },
  /** Clip playback speed: 0.25–4, null = original (1). */
  'nodes:setSpeed': {
    input: z.object({
      nodeId: z.string(),
      speed: z.number().min(SPEED_MIN).max(SPEED_MAX).nullable()
    }),
    output: z.void()
  },
  /** Colour look baked at render time (a CLIP_LOOKS id, null = untouched). */
  'nodes:setLook': {
    input: z.object({ nodeId: z.string(), look: z.enum(CLIP_LOOK_IDS).nullable() }),
    output: z.void()
  },
  /** Ken Burns preset of a STILL slot (a STILL_MOTIONS id, null = frozen frame). */
  'nodes:setStillMotion': {
    input: z.object({ nodeId: z.string(), motion: z.enum(STILL_MOTION_IDS).nullable() }),
    output: z.void()
  },
  /** Absolute start of an AUDIO track (null = chain after the previous track). */
  'nodes:setTimelineOffset': {
    input: z.object({ nodeId: z.string(), offsetSec: z.number().min(0).nullable() }),
    output: z.void()
  },

  // Free text layers of the timeline (§6.12b) — the title track.
  'textLayers:list': {
    input: z.object({ videoId: z.string() }),
    output: z.array(textLayerSchema)
  },
  'textLayers:create': { input: textLayerInputSchema, output: textLayerSchema },
  'textLayers:update': {
    input: z.object({
      id: z.string(),
      patch: textLayerSchema.omit({ id: true, videoId: true, createdAt: true }).partial()
    }),
    output: textLayerSchema
  },
  'textLayers:delete': { input: z.object({ id: z.string() }), output: z.void() },

  // Sticker track (§6.12d) — image overlays, same shape as the title track.
  'imageLayers:list': {
    input: z.object({ videoId: z.string() }),
    output: z.array(imageLayerSchema)
  },
  'imageLayers:create': { input: imageLayerInputSchema, output: imageLayerSchema },
  'imageLayers:update': {
    input: z.object({
      id: z.string(),
      patch: imageLayerSchema
        .omit({ id: true, videoId: true, nodeId: true, assetId: true, createdAt: true })
        .partial()
    }),
    output: imageLayerSchema
  },
  'imageLayers:delete': { input: z.object({ id: z.string() }), output: z.void() },

  // Feedback bucket (§6.13) — review notes taken while watching the timeline.
  'feedback:list': {
    input: z.object({ videoId: z.string() }),
    output: z.array(feedbackItemSchema)
  },
  'feedback:create': { input: feedbackItemInputSchema, output: feedbackItemSchema },
  'feedback:update': {
    input: z.object({
      id: z.string(),
      patch: feedbackItemSchema.omit({ id: true, videoId: true, createdAt: true }).partial()
    }),
    output: feedbackItemSchema
  },
  'feedback:delete': { input: z.object({ id: z.string() }), output: z.void() },
  'nodes:replaceModel': {
    input: z.object({ nodeId: z.string(), modelId: z.string() }),
    output: z.void()
  },
  'nodes:remove': { input: z.object({ nodeId: z.string() }), output: z.void() },
  'edges:connect': {
    input: z.object({
      videoId: z.string(),
      sourceNodeId: z.string(),
      sourceHandle: z.string(),
      targetNodeId: z.string(),
      targetHandle: z.string()
    }),
    output: graphEdgeSchema
  },
  'edges:disconnect': { input: z.object({ edgeId: z.string() }), output: z.void() },
  /** §6.5 one-click fix — move an edge to another input of the same target node. */
  'edges:rewire': {
    input: z.object({ edgeId: z.string(), targetHandle: z.string() }),
    output: graphEdgeSchema
  },
  /**
   * Reorder the connections of one input handle (§4.6): reference numbering
   * (@Image1, @Image2…) follows edge creation order, so `edgeIds` — a
   * permutation of the handle's current connections — becomes the new order.
   * One journaled (undoable) step.
   */
  'edges:reorder': {
    input: z.object({
      videoId: z.string(),
      targetNodeId: z.string(),
      targetHandle: z.string(),
      edgeIds: z.array(z.string()).min(1)
    }),
    output: z.void()
  },

  'history:state': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },
  'history:undo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },
  'history:redo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },

  'workflow:export': { input: z.object({ videoId: z.string() }), output: workflowExportSchema },
  'workflow:import': {
    input: z.object({ videoId: z.string(), json: z.string(), replace: z.boolean() }),
    output: z.object({ nodeCount: z.number(), edgeCount: z.number() })
  },

  'generations:listForNode': {
    input: z.object({ nodeId: z.string() }),
    output: z.array(generationSchema)
  },
  'generations:listForVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.array(generationSchema)
  },
  'generations:get': {
    input: z.object({ generationId: z.string() }),
    output: generationSchema.nullable()
  },
  'generations:historyForVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.array(
      generationSchema.extend({
        nodeLabel: z.string().nullable(),
        modelId: z.string(),
        isSelected: z.boolean(),
        nodeExists: z.boolean()
      })
    )
  },
  'generations:select': {
    input: z.object({ nodeId: z.string(), generationId: z.string().nullable() }),
    output: z.void()
  },

  'generations:run': {
    input: z.object({
      nodeId: z.string(),
      reuseSatisfied: z.boolean().optional(),
      /** §6.6 — claim N parallel candidates instead of one. */
      variants: variantsSchema
    }),
    output: z.object({
      generationId: z.string(),
      kieTaskId: z.string(),
      /** Every candidate claimed by this run (one entry on a plain run). */
      generationIds: z.array(z.string())
    })
  },
  'generations:refreshStatus': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ status: z.string() })
  },
  'generations:cancel': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ cancelled: z.boolean() })
  },
  'generations:setLastFrame': {
    input: z.object({ generationId: z.string(), jpegBase64: z.string() }),
    output: z.void()
  },
  /**
   * Copies a successful image generation (e.g. the chosen thumbnail) to a
   * user-picked path — native save dialog in the handler; null = cancelled.
   */
  'generations:exportImage': {
    input: z.object({ generationId: z.string(), defaultFileName: z.string().optional() }),
    output: z.object({ path: z.string() }).nullable()
  },
  /** Read-only snapshot of the run queue — pushed fresh via event:queueChanged. */
  'generations:queueState': { input: z.void(), output: queueStateSchema },
  /** OS notification summarizing a finished batch run ("4 succeeded, 1 failed"). */
  'notifications:batchSummary': {
    input: z.object({ succeeded: z.number().int().min(0), failed: z.number().int().min(0) }),
    output: z.void()
  },
  /** Indicative credit cost of running this node now (null = no rates declared). */
  'generations:estimateCost': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ credits: z.number().nullable() })
  },
  /** §4.10 phase 4 — smart-run planning in the main process: nodes that will
   *  claim a generation (deps always reuse; targets only with reuseTargets)
   *  + per-node credit estimates. Feeds the §4.4 cost modal. */
  'generations:planRun': {
    input: z.object({
      videoId: z.string(),
      targetNodeIds: z.array(z.string()).min(1),
      reuseTargets: z.boolean(),
      variants: variantsSchema
    }),
    output: z.object({
      rows: z.array(plannedRowSchema),
      total: z.number()
    })
  },
  /** Runs the same plan dependency-aware (shared upstreams once, independent
   *  branches parallel, settle-aware sequencing) and resolves when the whole
   *  batch settled. One failing branch doesn't abort the others. */
  'generations:runBatch': {
    input: z.object({
      videoId: z.string(),
      targetNodeIds: z.array(z.string()).min(1),
      reuseTargets: z.boolean(),
      variants: variantsSchema
    }),
    output: z.object({
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
      /** nodeId → generationId for every node that claimed one. */
      generations: z.record(z.string(), z.string())
    })
  },
  /** §6.1 finalize — nodes whose selected generation is a draft, with the
   *  draft cost already spent vs the estimated cost on the real models. */
  'generations:planFinalize': {
    input: z.object({ videoId: z.string() }),
    output: z.object({
      rows: z.array(
        z.object({
          nodeId: z.string(),
          label: z.string(),
          draftCredits: z.number().nullable(),
          finalCredits: z.number().nullable()
        })
      ),
      totalDraft: z.number(),
      totalFinal: z.number()
    })
  },
  /** Re-runs every draft-selected node on the real models (draft substitution
   *  bypassed for these runs; draft mode itself stays on for exploration). */
  'generations:finalizeVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
      generations: z.record(z.string(), z.string())
    })
  },
  /** §6.3 — the user's notes on one generation (region on an image, timecode on a clip). */
  'annotations:list': {
    input: z.object({ generationId: z.string() }),
    output: z.array(annotationSchema)
  },
  'annotations:add': {
    input: z.object({
      generationId: z.string(),
      comment: z.string().trim().min(1),
      region: regionSchema.nullable().optional(),
      timecodeSec: z.number().nullable().optional()
    }),
    output: annotationSchema
  },
  'annotations:delete': { input: z.object({ annotationId: z.string() }), output: z.void() },
  /** Builds the pre-wired edit node from the notes (image outputs only). */
  'annotations:createEditNode': {
    input: z.object({ generationId: z.string() }),
    output: z.object({ nodeId: z.string(), prompt: z.string() })
  },

  /** §6.4 — named graph captures. */
  'checkpoints:list': {
    input: z.object({ videoId: z.string() }),
    output: z.array(checkpointSchema)
  },
  'checkpoints:create': {
    input: z.object({ videoId: z.string(), name: z.string().trim().min(1) }),
    output: checkpointSchema
  },
  'checkpoints:delete': { input: z.object({ checkpointId: z.string() }), output: z.void() },
  'checkpoints:diff': {
    input: z.object({ checkpointId: z.string() }),
    output: checkpointDiffSchema
  },
  'checkpoints:restore': {
    input: z.object({ checkpointId: z.string() }),
    output: z.object({
      nodeCount: z.number().int().min(0),
      edgeCount: z.number().int().min(0),
      selectionsRestored: z.number().int().min(0),
      selectionsMissing: z.number().int().min(0)
    })
  },

  /** §6.2 — run (or re-run) the vision QC on one successful generation. */
  'generations:reviewGeneration': {
    input: z.object({ generationId: z.string() }),
    output: z.object({ verdict: qcVerdictSchema, notes: z.string() })
  },
  /** Estimated credits spent + attempt count across a whole project. */
  'projects:creditsUsage': {
    input: z.object({ projectId: z.string() }),
    output: z.object({ estimatedCredits: z.number(), generationCount: z.number() })
  },
  /** Remaining kie.ai account credits (live query against the kie API). */
  'kie:credits': {
    input: z.void(),
    output: z.object({ credits: z.number() })
  },
  'ai:refineImagePrompt': {
    input: z.object({
      currentPrompt: z.string(),
      imageUrl: z.string(),
      instruction: z.string()
    }),
    output: z.object({ prompt: z.string() })
  },
  'assets:promoteGeneration': {
    input: z.object({
      generationId: z.string(),
      name: z.string().trim().min(1),
      description: z.string().optional()
    }),
    output: assetWithUrlSchema
  },
  'settings:localApiInfo': {
    input: z.void(),
    output: z.object({
      running: z.boolean(),
      url: z.string().nullable(),
      token: z.string(),
      authDisabled: z.boolean()
    })
  },
  /** Opt-in tokenless MCP access — safe-ish because the server binds loopback only. */
  'settings:setLocalApiAuthDisabled': {
    input: z.object({ disabled: z.boolean() }),
    output: z.void()
  },
  'settings:setKieApiKey': { input: z.object({ key: z.string() }), output: z.void() },
  'settings:getGenerationConcurrency': { input: z.void(), output: z.number() },
  'settings:setGenerationConcurrency': {
    input: z.object({ value: z.number().int().min(1).max(16) }),
    output: z.void()
  },
  'settings:kieApiKeyStatus': {
    input: z.void(),
    output: z.object({ configured: z.boolean(), encryptionAvailable: z.boolean() })
  },
  /** Live validation of the stored kie key (cheap authenticated balance call). */
  'settings:testKieApiKey': {
    input: z.void(),
    output: z.object({ status: z.enum(['ok', 'unauthorized', 'network', 'missing']) })
  },
  'settings:getOnboardingCompleted': { input: z.void(), output: z.boolean() },
  'settings:setOnboardingCompleted': { input: z.void(), output: z.void() },
  'settings:getNotifyOnCompletion': { input: z.void(), output: z.boolean() },
  'settings:setNotifyOnCompletion': {
    input: z.object({ enabled: z.boolean() }),
    output: z.void()
  },
  'settings:getAssistantModel': { input: z.void(), output: assistantModelSchema },
  'settings:setAssistantModel': {
    input: z.object({ model: assistantModelSchema }),
    output: z.void()
  },
  'settings:getAssistantRunApproval': { input: z.void(), output: assistantRunApprovalSchema },
  'settings:setAssistantRunApproval': {
    input: z.object({ mode: assistantRunApprovalSchema }),
    output: z.void()
  },

  'settings:getUpdateChannel': { input: z.void(), output: updateChannelSchema },
  'settings:setUpdateChannel': {
    input: z.object({ channel: updateChannelSchema }),
    output: z.void()
  },

  // Renderer errors land in the same userData/logs/main.log as main's —
  // window errors, unhandled rejections and global query/mutation failures.
  'log:renderer': {
    input: z.object({
      level: z.enum(['warn', 'error']),
      scope: z.string().max(100),
      message: z.string().max(10_000)
    }),
    output: z.void()
  },

  // Auto-update (electron-updater). 'unsupported' = dev build, no feed.
  'update:getState': { input: z.void(), output: updateStateSchema },
  'update:check': { input: z.void(), output: updateStateSchema },
  'update:install': { input: z.void(), output: z.void() },

  // Full-app backup (.raccord = db + media). Outputs are nullable: null means
  // the user cancelled the native file dialog.
  'backup:export': {
    input: z.void(),
    output: z.object({ path: z.string(), files: z.number(), bytes: z.number() }).nullable()
  },
  // On success the main process relaunches the app right after responding.
  'backup:import': {
    input: z.void(),
    output: z.object({ mediaFiles: z.number() }).nullable()
  },

  // Rendered MP4 export of the timeline (ffmpeg in main). Output is nullable:
  // null means the user cancelled the native save dialog. Progress is pushed
  // via event:renderProgress; the promise resolves when the file is written.
  'render:export': {
    input: z.object({
      videoId: z.string(),
      // Optional overrides — default: probed from the first clip.
      fps: z.number().int().min(1).max(120).optional(),
      resolution: z
        .object({ width: z.number().int().min(2), height: z.number().int().min(2) })
        .optional(),
      /** Burn the scenario's quoted dialogue as subtitles. */
      burnSubtitles: z.boolean().optional(),
      /** Dynamic captions from the speech lane's transcripts (preset id; absent = off). */
      captionsPreset: z.enum(CAPTION_PRESET_IDS).optional(),
      /** Duck the music bed under the voice-over (transcript-timed windows). */
      duckMusic: z.boolean().optional(),
      /** Encoder quality (default 'standard' = the historical args). */
      quality: z.enum(RENDER_QUALITIES).optional(),
      /** Output codec (default h264; hevc forces the normalize path). */
      codec: z.enum(RENDER_CODECS).optional(),
      /** Translucent corner text over the whole film (per-render, not persisted). */
      watermark: z
        .object({
          text: z.string().trim().min(1).max(80),
          position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).optional()
        })
        .optional()
    }),
    output: z
      .object({
        path: z.string(),
        durationSeconds: z.number(),
        /** Labels of timeline slots that had no usable media and were skipped. */
        skipped: z.array(z.string())
      })
      .nullable()
  },
  // Resolves true if a render was in flight and got cancelled.
  'render:cancel': { input: z.object({ videoId: z.string() }), output: z.boolean() },

  'chat:get': { input: z.object({ threadId: z.string() }), output: chatStateSchema },
  'chat:send': {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      text: z.string().trim().min(1),
      images: z.array(chatImageSchema).max(4).optional(),
      context: appContextSchema.optional()
    }),
    output: chatStateSchema
  },
  /** Empties a thread's transcript, keeping the thread. */
  'chat:clear': { input: z.object({ threadId: z.string() }), output: z.void() },
  /** Stops the in-flight assistant turn (no-op when the thread is idle). */
  'chat:stop': { input: z.object({ threadId: z.string() }), output: z.void() },
  /** Conversation threads for the sidebar switcher, most recent first. */
  'chat:listThreads': {
    input: z.void(),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        projectId: z.string(),
        videoId: z.string().nullable(),
        videoName: z.string().nullable(),
        createdAt: z.number(),
        updatedAt: z.number()
      })
    )
  },
  /** Opens an empty conversation; returns its id. */
  'chat:newThread': {
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ threadId: z.string() })
  },
  'chat:renameThread': {
    input: z.object({ threadId: z.string(), title: z.string().trim().min(1).max(120) }),
    output: z.void()
  },
  'chat:deleteThread': { input: z.object({ threadId: z.string() }), output: z.void() },
  /** Assistant capabilities for the chat input's "/" action menu — name +
   *  first sentence of the tool description (product data, English). */
  'chat:listTools': {
    input: z.void(),
    output: z.array(z.object({ name: z.string(), description: z.string() }))
  },

  // YouTube niche research (§7). Mutations broadcast event:nichesChanged.
  'niches:list': { input: z.void(), output: z.array(nicheOverviewSchema) },
  'niches:get': {
    input: z.object({ nicheId: z.string() }),
    output: z.object({
      niche: nicheSchema,
      channels: z.array(nicheChannelSchema),
      /** Keyed by YouTube channel id. */
      aggregates: z.record(z.string(), nicheChannelAggregatesSchema),
      videoCount: z.number()
    })
  },
  'niches:create': {
    input: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().nullable().optional(),
      languageCode: z.string().trim().min(2).max(5).optional(),
      locationCode: z.number().int().positive().optional()
    }),
    output: nicheSchema
  },
  'niches:update': {
    input: z.object({
      nicheId: z.string(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().nullable().optional(),
      languageCode: z.string().trim().min(2).max(5).optional(),
      locationCode: z.number().int().positive().optional(),
      styleId: z.string().nullable().optional(),
      aspectRatio: videoAspectRatioSchema.nullable().optional(),
      targetSeconds: z.number().int().positive().nullable().optional()
    }),
    output: nicheSchema
  },
  // Roadmap (§7b): the videos to make, idea → workflow → published.
  'niches:roadmap': {
    input: z.object({ nicheId: z.string() }),
    output: z.array(nicheRoadmapItemSchema)
  },
  'niches:addRoadmapItem': {
    input: z.object({
      nicheId: z.string(),
      title: z.string().trim().min(1).max(200),
      titleVariants: z.array(z.string().trim().min(1).max(200)).max(20).nullable().optional(),
      angle: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      thumbnailBrief: z.string().nullable().optional(),
      evidence: z.string().nullable().optional(),
      videoType: z.enum(['long', 'short']).optional()
    }),
    output: nicheRoadmapItemSchema
  },
  'niches:updateRoadmapItem': {
    input: z.object({
      itemId: z.string(),
      title: z.string().trim().min(1).max(200).optional(),
      titleVariants: z.array(z.string().trim().min(1).max(200)).max(20).nullable().optional(),
      angle: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      thumbnailBrief: z.string().nullable().optional(),
      evidence: z.string().nullable().optional(),
      videoType: z.enum(['long', 'short']).optional(),
      status: z.enum(['idea', 'in_production', 'published']).optional(),
      sortOrder: z.number().int().optional()
    }),
    output: nicheRoadmapItemSchema
  },
  'niches:deleteRoadmapItem': { input: z.object({ itemId: z.string() }), output: z.void() },
  /** Creates (or links) the Raccord workflow; the thumbnail node comes with it. */
  'niches:assignRoadmapItem': {
    input: z.object({
      itemId: z.string(),
      projectId: z.string().optional(),
      videoId: z.string().optional()
    }),
    output: z.object({
      item: nicheRoadmapItemSchema,
      videoId: z.string(),
      projectId: z.string(),
      thumbnailNodeId: z.string().nullable()
    })
  },
  'niches:markRoadmapPublished': {
    input: z.object({ itemId: z.string(), url: z.string().trim().min(1) }),
    output: nicheRoadmapItemSchema
  },
  'niches:delete': { input: z.object({ nicheId: z.string() }), output: z.void() },
  /** `ref` accepts a channel id (UC…), a @handle or any youtube.com channel URL. */
  'niches:addChannel': {
    input: z.object({
      nicheId: z.string(),
      ref: z.string().trim().min(1),
      isMine: z.boolean().optional(),
      notes: z.string().nullable().optional()
    }),
    output: nicheChannelSchema
  },
  'niches:updateChannel': {
    input: z.object({
      nicheChannelId: z.string(),
      isMine: z.boolean().optional(),
      notes: z.string().nullable().optional()
    }),
    output: nicheChannelSchema
  },
  'niches:removeChannel': { input: z.object({ nicheChannelId: z.string() }), output: z.void() },
  /** Re-pulls channel stats + latest uploads + video stats for the whole niche. */
  'niches:refresh': {
    input: z.object({
      nicheId: z.string(),
      videosPerChannel: z.number().int().min(1).max(200).optional()
    }),
    output: nicheRefreshResultSchema
  },
  'niches:videos': {
    input: z.object({
      nicheId: z.string(),
      filters: nicheVideoFiltersSchema.optional(),
      limit: z.number().int().min(1).max(500).optional()
    }),
    output: z.array(nicheVideoSchema)
  },
  /** DataForSEO SERP + YouTube enrichment; `save` upserts hits into the niche. */
  'niches:keywordSearch': {
    input: z.object({
      keyword: z.string().trim().min(1),
      nicheId: z.string().optional(),
      locationCode: z.number().int().positive().optional(),
      languageCode: z.string().trim().min(2).max(5).optional(),
      depth: z.number().int().min(20).max(700).optional(),
      /** Raw/encoded sp value, a preset id from SP_PRESETS, or a YouTube URL. */
      searchParam: z.string().optional(),
      save: z.boolean().optional()
    }),
    output: z.object({
      videos: z.array(nicheScoredVideoSchema),
      quotaUsed: z.number(),
      saved: z.number(),
      /** What DataForSEO actually billed for this search (USD) — real money. */
      costUsd: z.number().nullable()
    })
  },
  /** Fetches missing transcripts, oldest tracked first. */
  'niches:fetchTranscripts': {
    input: z.object({
      nicheId: z.string(),
      videoIds: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).optional()
    }),
    output: z.object({
      fetched: z.number(),
      failed: z.array(z.string()),
      remaining: z.number()
    })
  },
  'niches:getTranscript': {
    input: z.object({ nicheVideoId: z.string() }),
    output: z.object({
      videoId: z.string(),
      title: z.string(),
      transcript: z.string().nullable()
    })
  },
  'settings:setYoutubeApiKey': { input: z.object({ key: z.string() }), output: z.void() },
  'settings:setDataForSeoLogin': { input: z.object({ value: z.string() }), output: z.void() },
  'settings:setDataForSeoPassword': { input: z.object({ value: z.string() }), output: z.void() },
  'settings:nicheKeysStatus': {
    input: z.void(),
    output: z.object({ youtubeConfigured: z.boolean(), dataForSeoConfigured: z.boolean() })
  },
  'settings:setElevenLabsApiKey': { input: z.object({ value: z.string() }), output: z.void() },
  'settings:elevenLabsKeyStatus': {
    input: z.void(),
    output: z.object({ configured: z.boolean() })
  },
  'speech:listVoices': {
    input: z.object({ search: z.string().optional() }),
    output: z.object({ voices: z.array(elevenLabsVoiceSchema), hasMore: z.boolean() })
  },
  'voicePersonas:list': {
    input: z.object({ nicheId: z.string().optional() }),
    output: z.array(voicePersonaSchema)
  },
  'voicePersonas:create': {
    input: z.object({
      name: z.string().trim().min(1),
      voiceId: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      nicheId: z.string().nullable().optional()
    }),
    output: voicePersonaSchema
  },
  'voicePersonas:update': {
    input: z.object({
      personaId: z.string(),
      name: z.string().trim().min(1).optional(),
      voiceId: z.string().trim().min(1).optional(),
      description: z.string().nullable().optional(),
      nicheId: z.string().nullable().optional()
    }),
    output: voicePersonaSchema
  },
  'voicePersonas:remove': { input: z.object({ personaId: z.string() }), output: z.void() }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

/** Main→renderer push events the preload is allowed to subscribe to. */
export const ipcEvents = [
  'event:generationsChanged',
  'event:workflowChanged',
  'event:chatUpdate',
  'event:creditsChanged',
  'event:renderProgress',
  'event:queueChanged',
  'event:focusNode',
  'event:navigate',
  'event:nichesChanged',
  'event:voicePersonasChanged'
] as const
export type IpcEvent = (typeof ipcEvents)[number]

export interface GenerationsChangedPayload {
  videoId: string
  nodeId: string
}

/** Clicking a completion notification asks the editor to center this node. */
export interface FocusNodePayload {
  videoId: string
  nodeId: string
}

/** The assistant (open_video tool) asks the app to navigate to a route. */
export interface NavigatePayload {
  path: string
}

/** Progress of an MP4 render. One terminal event is always sent: done or error. */
export interface RenderProgressPayload {
  videoId: string
  /** 0–100 across the whole pipeline (probe → normalize → transition → concat → subtitles → overlay → mux). */
  percent: number
  step: 'probe' | 'normalize' | 'transition' | 'concat' | 'subtitles' | 'overlay' | 'mux'
  done?: boolean
  /** Set on the terminal event when the render failed (or was cancelled). */
  error?: string
}

export type IpcContracts = typeof ipcContracts
export type IpcChannel = keyof IpcContracts
export type IpcInput<C extends IpcChannel> = z.infer<IpcContracts[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContracts[C]['output']>

export const ipcChannels = Object.keys(ipcContracts) as IpcChannel[]

export function isIpcChannel(channel: string): channel is IpcChannel {
  return channel in ipcContracts
}
