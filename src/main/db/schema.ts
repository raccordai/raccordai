import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { Scenario } from '@shared/scenario'

/**
 * Schema evolutions are additive only: new tables/columns via drizzle-kit
 * migrations, never destructive changes — user databases must survive
 * every app update.
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Graph data model (mirrors video-studio's Convex schema):
 *   Project ──┬── Asset[]   (project-scoped media library)
 *             └── Video[]
 *                    ├── Node[] ── Generation[]
 *                    └── Edge[]  (targetHandle = kie.ai input field name;
 *                                 sourceHandle = "output" | "lastFrame")
 * Foreign keys cascade so deleting a project/video cleans up its whole tree.
 */

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Project-scoped slug used in importable workflow JSONs (e.g. "main-character"). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: ['image', 'video', 'audio'] }).notNull(),
    /** Media lives either as a local file (managed copy) or a referenced public URL. */
    filePath: text('file_path'),
    sourceUrl: text('source_url'),
    mimeType: text('mime_type'),
    size: integer('size'),
    /** kie.ai upload cache — uploaded files expire after ~3 days, so we re-upload past the TTL. */
    uploadedUrl: text('uploaded_url'),
    uploadedAt: integer('uploaded_at'),
    /** User-defined labels for filtering the library (normalized lowercase). */
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    /** Design-recipe category when this asset is a published design sheet (e.g. 'character'). */
    designId: text('design_id'),
    /** The subject the sheet was built from — identity for reuse and agent context. */
    designSubject: text('design_subject'),
    /** SHA-256 of the managed file — duplicate detection within a project. */
    contentHash: text('content_hash'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at')
  },
  (table) => [
    index('assets_by_project').on(table.projectId),
    uniqueIndex('assets_by_project_key').on(table.projectId, table.key),
    index('assets_by_project_hash').on(table.projectId, table.contentHash)
  ]
)

/**
 * Casting (§6.10) — the film's named identities, project-scoped.
 *
 * A published design sheet says WHAT it is (`assets.design_id`) and what it
 * depicts (`design_subject`); it never says who that is for the film. This is
 * the missing sentence: "Léa IS that sheet". It buys two things the library
 * alone cannot — a name the prompts can carry between shots, and a single
 * place to re-point when the sheet is regenerated.
 *
 * `asset_id` cascades: a role whose sheet was deleted has nothing left to mean.
 */
export const castings = sqliteTable(
  'castings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The name the film calls this role, e.g. "Léa" — unique within the project. */
    name: text('name').notNull(),
    /** The published design sheet this role IS. */
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    /** Standing direction appended to every role sentence ("always wears the red scarf"). */
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('castings_by_project').on(table.projectId),
    uniqueIndex('castings_by_project_name').on(table.projectId, table.name)
  ]
)

export const videos = sqliteTable(
  'videos',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Active style template (src/shared/styles/registry.ts) — art direction shared by every shot. */
    styleId: text('style_id'),
    /**
     * Video-level generation defaults. New nodes pre-fill matching params from
     * them; changing one never rewrites existing nodes silently (the UI offers
     * an explicit, journaled "apply to N nodes" instead).
     */
    defaultAspectRatio: text('default_aspect_ratio'),
    defaultResolution: text('default_resolution'),
    /**
     * Draft mode (§6.1): while on, prepareRun substitutes each model's
     * draftEquivalent — explore cheap, then "finalize" re-runs the keepers on
     * the real models. Null/false = off.
     */
    draftMode: integer('draft_mode', { mode: 'boolean' }),
    /**
     * Vision QC (§6.2): while on, every successful image generation gets one
     * cheap vision check (verdict stored on the generation row). Null/false = off.
     */
    qcEnabled: integer('qc_enabled', { mode: 'boolean' }),
    /**
     * Scenario (§6.7): the shot list written from the brief BEFORE the graph —
     * durations already legal for the target model, each shot chained to the
     * next by its opening/closing frame. Stored as the shared `Scenario` JSON;
     * null until the assistant writes one.
     */
    scenario: text('scenario', { mode: 'json' }).$type<Scenario>(),
    /**
     * The niche roadmap item this video was created from (§7b) — the back-link
     * that lets the editor and the assistant see the channel strategy behind
     * the workflow. Plain text on purpose (an FK would cycle with
     * niche_roadmap_items.video_id); deleteRoadmapItem clears it.
     */
    roadmapItemId: text('roadmap_item_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('videos_by_project').on(table.projectId)]
)

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** Stable identifier used in JSON imports (e.g. "node_intro"). */
    key: text('key').notNull(),
    modelId: text('model_id').notNull(),
    label: text('label'),
    /** Creative intent — shown next to the output, never sent to the model. */
    intent: text('intent'),
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
    /** Model-specific params (validated by the model registry at run time). */
    params: text('params', { mode: 'json' }).notNull(),
    /** Active output for downstream nodes. No FK: generations reference nodes already. */
    selectedGenerationId: text('selected_generation_id'),
    /** Explicit timeline slot (0-based). Null = legacy label-number ordering. */
    timelineOrder: integer('timeline_order'),
    /** Timeline trim: in/out points in seconds within the clip's media. */
    trimStartSec: real('trim_start_sec'),
    trimEndSec: real('trim_end_sec'),
    /** Transition INTO the next clip at render time: a CLIP_TRANSITIONS id | null (cut). */
    transitionAfter: text('transition_after'),
    /** Transition length in seconds (null = TRANSITION_DEFAULT_SECONDS). */
    transitionDurationSec: real('transition_duration_sec'),
    /** Text layer burned over this clip at render time: { text, align, size }. */
    overlay: text('overlay', { mode: 'json' }).$type<{
      text: string
      align: number
      size: 'sm' | 'md' | 'lg'
    } | null>(),
    /** Audio-lane volume gain (0–2, null = 1). Read through the shared clipVolume. */
    volume: real('volume'),
    /** Clip playback speed (0.25–4, null = 1). Read through the shared clipSpeed. */
    speed: real('speed'),
    /** Colour look baked at render time (a CLIP_LOOKS id, null = untouched). */
    look: text('look'),
    /** Ken Burns preset of a STILL slot (a STILL_MOTIONS id, null = frozen frame). */
    stillMotion: text('still_motion'),
    /**
     * Absolute start of an AUDIO track on the final timeline (seconds).
     * Null = the historical layout: chained after the previous lane track.
     */
    timelineOffsetSec: real('timeline_offset_sec'),
    /**
     * Split clip (§6.12e): materialized timeline segments, each with its own
     * trim window + transition. Null = one implicit segment read from the
     * trim/transition columns above (which stay synced to the segments'
     * envelope for legacy readers).
     */
    segments: text('segments', { mode: 'json' }).$type<Array<{
      trimStartSec?: number | null
      trimEndSec?: number | null
      transitionAfter?: string | null
      transitionDurationSec?: number | null
    }> | null>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('nodes_by_video').on(table.videoId),
    uniqueIndex('nodes_by_video_key').on(table.videoId, table.key)
  ]
)

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    sourceHandle: text('source_handle').notNull(),
    targetNodeId: text('target_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    targetHandle: text('target_handle').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('edges_by_video').on(table.videoId)]
)

/**
 * Free text layers of a video's timeline (§6.12b): titles, captions, credits.
 * Independent of the clips — they live in absolute FINAL-timeline seconds,
 * like an NLE title track — positioned anywhere on the frame (normalized
 * x/y + ASS numpad anchor) with their own typography. Burned at render time
 * through the same libass pass as subtitles and the watermark.
 */
export const textLayers = sqliteTable(
  'text_layers',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    /** Normalized anchor position on the frame (0–1). */
    x: real('x').notNull(),
    y: real('y').notNull(),
    /** ASS numpad alignment: which corner of the text sits on (x, y). */
    anchor: integer('anchor').notNull(),
    /** Font family name (null = the renderer's default sans). */
    fontFamily: text('font_family'),
    /** Font size as a percentage of the output height (resolution-independent). */
    sizePct: real('size_pct').notNull(),
    bold: integer('bold', { mode: 'boolean' }).notNull(),
    italic: integer('italic', { mode: 'boolean' }).notNull(),
    /** #RRGGBB fill color (outline stays automatic for readability). */
    colorHex: text('color_hex').notNull(),
    /** Entrance animation preset (a TEXT_ANIMATIONS id, null = static). */
    animation: text('animation'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('text_layers_by_video').on(table.videoId)]
)

/**
 * Sticker track (§6.12d): image overlays composited over the film at render
 * time, in absolute FINAL-timeline seconds like text_layers. The image comes
 * from an image NODE's output or a project ASSET (exactly one of the two; no
 * FK, like nodes.selected_generation_id — a deleted source just skips the
 * sticker at render). Same doctrine as text_layers: not in the graph journal.
 */
export const imageLayers = sqliteTable(
  'image_layers',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** Image node whose best generation is composited (null when assetId set). */
    nodeId: text('node_id'),
    /** Project asset composited as-is (null when nodeId set). */
    assetId: text('asset_id'),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    /** Normalized CENTER position on the frame (0–1). */
    x: real('x').notNull(),
    y: real('y').notNull(),
    /** Sticker width as a percentage of the output width (height follows). */
    widthPct: real('width_pct').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('image_layers_by_video').on(table.videoId)]
)

export const generations = sqliteTable(
  'generations',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'running', 'success', 'failed'] }).notNull(),
    kieTaskId: text('kie_task_id'),
    /** Snapshot of params + resolved input URLs at the moment of execution. */
    inputSnapshot: text('input_snapshot', { mode: 'json' }),
    /** Remote kie.ai URL — kept for initial display while the media downloads. */
    resultUrl: text('result_url'),
    /** Local file once downloaded (replaces Convex storage). */
    resultPath: text('result_path'),
    resultMimeType: text('result_mime_type'),
    /** Extracted last frame for video generations (image), fed to 'lastFrame' edges. */
    lastFramePath: text('last_frame_path'),
    /** kie.ai upload cache for locally-stored media used as downstream inputs. */
    resultUploadedUrl: text('result_uploaded_url'),
    resultUploadedAt: integer('result_uploaded_at'),
    lastFrameUploadedUrl: text('last_frame_uploaded_url'),
    lastFrameUploadedAt: integer('last_frame_uploaded_at'),
    /** Indicative kie.ai credit cost, computed from the model's declared rates at claim time. */
    creditsEstimated: real('credits_estimated'),
    /** True when the run was substituted to the model's draftEquivalent (§6.1). */
    draft: integer('draft', { mode: 'boolean' }),
    /** Vision-QC verdict (§6.2): 'pass' | 'warn' | 'error' (QC call itself failed). Null = not checked. */
    qcVerdict: text('qc_verdict', { enum: ['pass', 'warn', 'error'] }),
    /** Human-readable QC issues, shown on the card and fed to "Fix with assistant". */
    qcNotes: text('qc_notes'),
    /** Speech runs (§8): SpeechTranscript JSON — what was spoken, with timestamps. */
    transcript: text('transcript', { mode: 'json' }),
    errorMessage: text('error_message'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at')
  },
  (table) => [
    index('generations_by_node').on(table.nodeId),
    index('generations_by_video').on(table.videoId),
    index('generations_by_kie_task').on(table.kieTaskId)
  ]
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull()
})

export const flagOverrides = sqliteTable('flag_overrides', {
  key: text('key').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull()
})

/**
 * Persisted assistant conversations — one row per video. The whole transcript
 * (Anthropic history + rendered items + watched generation ids) is stored as
 * JSON so a restart resumes exactly where the session left off.
 */
export const chatSessions = sqliteTable('chat_sessions', {
  videoId: text('video_id')
    .primaryKey()
    .references(() => videos.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  history: text('history', { mode: 'json' }).notNull(),
  items: text('items', { mode: 'json' }).notNull(),
  watched: text('watched', { mode: 'json' }).$type<string[]>().notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * The home (project-level) assistant session — a single row keyed by the
 * 'home' sentinel. Separate table because chat_sessions.video_id has a FK to
 * videos; the home session is not tied to any video.
 */
export const chatHomeSession = sqliteTable('chat_home_session', {
  id: text('id').primaryKey(),
  history: text('history', { mode: 'json' }).notNull(),
  items: text('items', { mode: 'json' }).notNull(),
  watched: text('watched', { mode: 'json' }).$type<string[]>().notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Assistant conversations as first-class THREADS: the user can open a new chat
 * at any time instead of erasing the single global one. Supersedes
 * chat_sessions / chat_home_session, which stay in the schema (migrations are
 * additive) and are read once by `backfillChatThreads` so existing transcripts
 * carry over.
 *
 * `video_id` deliberately carries NO foreign key: a thread outlives the video
 * it was started from (deleting the video demotes the thread to unbound rather
 * than silently destroying the conversation). Unbound threads (`video_id` null)
 * use the home prompt + explicit-id toolset.
 */
export const chatThreads = sqliteTable('chat_threads', {
  id: text('id').primaryKey(),
  /** Display name, derived from the first user message (renameable). */
  title: text('title'),
  /** '' when the thread is not tied to a project. */
  projectId: text('project_id').notNull(),
  videoId: text('video_id'),
  history: text('history', { mode: 'json' }).notNull(),
  items: text('items', { mode: 'json' }).notNull(),
  watched: text('watched', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

/**
 * Regional feedback (§6.3) — the user's judgment on one generation, captured
 * where they saw the problem: a normalized region on an image, or a timecode
 * on a video, plus a plain-language comment. They compose the prompt of a
 * pre-wired edit node (or an assistant request) and are the raw signal the
 * taste memory (§6.7) will distill.
 */
export const generationAnnotations = sqliteTable(
  'generation_annotations',
  {
    id: text('id').primaryKey(),
    generationId: text('generation_id')
      .notNull()
      .references(() => generations.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** Normalized {x,y,w,h} in [0,1] — null for a whole-frame or timecode note. */
    region: text('region', { mode: 'json' }).$type<{
      x: number
      y: number
      w: number
      h: number
    }>(),
    /** Seconds into the clip (video notes); null on images. */
    timecodeSec: real('timecode_sec'),
    comment: text('comment').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('annotations_by_generation').on(table.generationId)]
)

/**
 * Named checkpoints (§6.4) — the safety net that authorizes boldness.
 *
 * Two representations of the same capture, on purpose: `snapshot` holds the
 * raw node/edge rows and is what a restore replays (same diff-restore as undo,
 * so nodes that survive keep their identity AND their generations), while
 * `workflow` holds the portable workflow-JSON v1 export used for the diff and
 * for exporting a checkpoint elsewhere. `selections` records the chosen output
 * per node KEY — ids alone would not survive a graph rebuilt from JSON.
 */
export const videoCheckpoints = sqliteTable(
  'video_checkpoints',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Workflow JSON v1, the exact shape import_workflow accepts (diff + export). */
    workflow: text('workflow', { mode: 'json' }).notNull(),
    /** Raw {nodes, edges} rows — the restore payload. */
    snapshot: text('snapshot', { mode: 'json' }).notNull(),
    /** node key → generation id selected at capture time. */
    selections: text('selections', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('checkpoints_by_video').on(table.videoId)]
)

/**
 * YouTube niche research (§7) — a niche is a watchlist: competitor channels,
 * the user's own channels, and the videos tracked for both, refreshed on
 * demand through DataForSEO (SERP) + the YouTube Data API (stats/metadata).
 * App-level, not project-scoped — one niche can feed several projects.
 */
export const niches = sqliteTable('niches', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Free positioning notes / brief — the assistant reads AND writes this. */
  description: text('description'),
  /** Defaults for keyword searches (DataForSEO location + language codes). */
  languageCode: text('language_code').notNull(),
  locationCode: integer('location_code').notNull(),
  /**
   * Production profile — what "a video of this niche" looks like. Applied to
   * every workflow created from the roadmap (style, format, target length).
   */
  styleId: text('style_id'),
  aspectRatio: text('aspect_ratio'),
  targetSeconds: integer('target_seconds'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const nicheChannels = sqliteTable(
  'niche_channels',
  {
    id: text('id').primaryKey(),
    nicheId: text('niche_id')
      .notNull()
      .references(() => niches.id, { onDelete: 'cascade' }),
    /** YouTube channel id (UC…). */
    channelId: text('channel_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    handle: text('handle'),
    url: text('url').notNull(),
    thumbnail: text('thumbnail'),
    /** -1 = hidden subscriber count (HIDDEN_SUBSCRIBERS sentinel). */
    subscribers: integer('subscribers').notNull(),
    videoCount: integer('video_count').notNull(),
    viewCount: integer('view_count').notNull(),
    /** Channel creation date (ISO), for the age filter. */
    channelCreatedAt: text('channel_created_at'),
    uploadsPlaylistId: text('uploads_playlist_id'),
    /** True for the user's own channels — the ones the niche analysis compares against. */
    isMine: integer('is_mine', { mode: 'boolean' }).notNull(),
    notes: text('notes'),
    lastRefreshedAt: integer('last_refreshed_at'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('niche_channels_by_niche').on(table.nicheId),
    uniqueIndex('niche_channels_unique').on(table.nicheId, table.channelId)
  ]
)

/**
 * The niche's video roadmap (§7b): ideas backed by tracked-data evidence,
 * carried through production. `video_id` links the Raccord workflow the item
 * was assigned to (SET NULL when that video is deleted — the idea survives);
 * `published_video_id` is the real YouTube id once live, which ties the item
 * back to the niche's tracked stats (the channel is usually one of "mine").
 */
export const nicheRoadmapItems = sqliteTable(
  'niche_roadmap_items',
  {
    id: text('id').primaryKey(),
    nicheId: text('niche_id')
      .notNull()
      .references(() => niches.id, { onDelete: 'cascade' }),
    /** Working title — becomes the Raccord video name on assignment. */
    title: text('title').notNull(),
    /**
     * Packaging-first (§7c): the candidate YouTube titles written BEFORE
     * production — the pros write 8-20 title+thumbnail pairs and only script
     * ideas whose click is already earned. Promoting one moves it to `title`.
     */
    titleVariants: text('title_variants', { mode: 'json' }).$type<string[]>(),
    /** One-line pitch. */
    angle: text('angle'),
    /** YouTube description draft (assistant-generated, user-edited). */
    description: text('description'),
    /** Prompt brief for the thumbnail — seeds the `thumbnail` recipe node. */
    thumbnailBrief: text('thumbnail_brief'),
    /** Why this video: the tracked videos that prove demand, with numbers. */
    evidence: text('evidence'),
    videoType: text('video_type').$type<'long' | 'short'>().notNull(),
    status: text('status').$type<'idea' | 'in_production' | 'published'>().notNull(),
    videoId: text('video_id').references(() => videos.id, { onDelete: 'set null' }),
    publishedVideoId: text('published_video_id'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('roadmap_by_niche').on(table.nicheId)]
)

export const nicheVideos = sqliteTable(
  'niche_videos',
  {
    id: text('id').primaryKey(),
    nicheId: text('niche_id')
      .notNull()
      .references(() => niches.id, { onDelete: 'cascade' }),
    /** YouTube ids — the video may belong to a channel we don't track. */
    videoId: text('video_id').notNull(),
    channelId: text('channel_id').notNull(),
    channelTitle: text('channel_title').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    thumbnail: text('thumbnail'),
    publishedAt: text('published_at'),
    views: integer('views').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    madeForKids: integer('made_for_kids', { mode: 'boolean' }).notNull(),
    /** Channel stats frozen at ingest time — the niche-score denominator. */
    channelSubscribers: integer('channel_subscribers').notNull(),
    channelCreatedAt: text('channel_created_at'),
    /** Engagement stats (videos.list `statistics`) — null on rows ingested before they were tracked. */
    likeCount: integer('like_count'),
    commentCount: integer('comment_count'),
    /** The competitor's own SEO: `snippet.tags` + `snippet.categoryId`. */
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    categoryId: text('category_id'),
    /** BCP-47 from defaultAudioLanguage/defaultLanguage — the reliable language filter. */
    language: text('language'),
    /** `contentDetails.caption` — false means a transcript fetch is pointless. */
    hasCaptions: integer('has_captions', { mode: 'boolean' }),
    /** SERP position (rank_absolute) when the video came from a keyword search. */
    serpRank: integer('serp_rank'),
    /** How the video entered the niche: a tracked channel or a keyword search. */
    source: text('source').$type<'channel' | 'search'>().notNull(),
    /** The keyword that surfaced it (search source only). */
    keyword: text('keyword'),
    transcript: text('transcript'),
    /** Language + ASR flag of the fetched caption track (null = unknown/legacy). */
    transcriptLanguage: text('transcript_language'),
    transcriptIsAsr: integer('transcript_is_asr', { mode: 'boolean' }),
    transcriptFetchedAt: integer('transcript_fetched_at'),
    statsRefreshedAt: integer('stats_refreshed_at'),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    index('niche_videos_by_niche').on(table.nicheId),
    index('niche_videos_by_channel').on(table.nicheId, table.channelId),
    uniqueIndex('niche_videos_unique').on(table.nicheId, table.videoId)
  ]
)

/**
 * Time series under the niche score (§7): one row per (tracked video, refresh)
 * whenever the numbers moved — refreshes used to overwrite `views`, which made
 * velocity, growth and "this video is taking off" structurally impossible.
 * Cascade-deleted with the tracked video.
 */
export const nicheVideoSnapshots = sqliteTable(
  'niche_video_snapshots',
  {
    id: text('id').primaryKey(),
    nicheVideoId: text('niche_video_id')
      .notNull()
      .references(() => nicheVideos.id, { onDelete: 'cascade' }),
    views: integer('views').notNull(),
    likeCount: integer('like_count'),
    channelSubscribers: integer('channel_subscribers').notNull(),
    capturedAt: integer('captured_at').notNull()
  },
  (table) => [index('niche_video_snapshots_by_video').on(table.nicheVideoId, table.capturedAt)]
)

/**
 * Voice personas (§8): the channel's NAMED voice identities — "Narrateur IS
 * ElevenLabs voice X". App-level like niches (the same narrator serves every
 * video, which is what keeps a channel's voice consistent); optionally pinned
 * to one niche. The casting table names who appears on screen — this names who
 * speaks. Deleting a niche keeps its personas (SET NULL): the voice outlives
 * the watchlist.
 */
export const voicePersonas = sqliteTable(
  'voice_personas',
  {
    id: text('id').primaryKey(),
    /** The name scripts call this voice — unique app-wide, case-insensitive. */
    name: text('name').notNull(),
    /** ElevenLabs voice id (custom clone or premade). */
    voiceId: text('voice_id').notNull(),
    /** Delivery notes folded into speech direction ("calm, warm, slow"). */
    description: text('description'),
    nicheId: text('niche_id').references(() => niches.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('voice_personas_by_niche').on(table.nicheId)]
)
