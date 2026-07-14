import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
