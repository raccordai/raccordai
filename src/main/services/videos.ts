import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Video } from '@shared/ipc/contracts'
import type { Scenario } from '@shared/scenario'
import { isStyleId } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { generations, nodes, videos } from '../db/schema'
import { deleteMediaFile } from '../media/files'
import { unbindThreadsOfVideo } from './chatStore'

export type VideoRow = typeof videos.$inferSelect

/** DB row → DTO: the toggles are nullable columns (additive migration), booleans in the contract. */
export function toVideo(row: VideoRow): Video {
  return {
    ...row,
    draftMode: row.draftMode ?? false,
    qcEnabled: row.qcEnabled ?? false,
    scenario: row.scenario ?? null
  }
}

export function listVideos(projectId: string): Video[] {
  return getDb()
    .select()
    .from(videos)
    .where(eq(videos.projectId, projectId))
    .orderBy(desc(videos.updatedAt))
    .all()
    .map(toVideo)
}

export function getVideo(id: string): Video | null {
  const row = getDb().select().from(videos).where(eq(videos.id, id)).get()
  return row ? toVideo(row) : null
}

export function createVideo(projectId: string, name: string): Video {
  const now = Date.now()
  const video: Video = {
    id: randomUUID(),
    projectId,
    name,
    styleId: null,
    defaultAspectRatio: null,
    defaultResolution: null,
    draftMode: false,
    qcEnabled: false,
    scenario: null,
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(videos).values(video).run()
  return video
}

/**
 * Scenario (§6.7) — the shot list the graph is built from. Replaced wholesale
 * (the assistant rewrites it from the beats), null clears it. Normalization
 * belongs to `planScenario`; this only stores what it produced.
 */
export function setVideoScenario(id: string, scenario: Scenario | null): void {
  getDb().update(videos).set({ scenario, updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}

export function getVideoScenario(id: string): Scenario | null {
  return getDb().select().from(videos).where(eq(videos.id, id)).get()?.scenario ?? null
}

/** Attach a style template to a video (null clears it). Validated against the style registry. */
export function setVideoStyle(id: string, styleId: string | null): void {
  if (styleId !== null && !isStyleId(styleId)) throw new Error(`Unknown style: ${styleId}`)
  getDb().update(videos).set({ styleId, updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}

/**
 * Video-level generation defaults (null clears, omitted leaves untouched).
 * Only pre-fills future nodes — existing nodes change through the explicit
 * graph-service bulk apply, never here.
 */
export function setVideoDefaults(
  id: string,
  defaults: { defaultAspectRatio?: string | null; defaultResolution?: string | null }
): void {
  const patch: Partial<typeof defaults> = {}
  if (defaults.defaultAspectRatio !== undefined)
    patch.defaultAspectRatio = defaults.defaultAspectRatio
  if (defaults.defaultResolution !== undefined) patch.defaultResolution = defaults.defaultResolution
  if (Object.keys(patch).length === 0) return
  getDb()
    .update(videos)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(videos.id, id))
    .run()
}

/** Draft mode (§6.1): while on, prepareRun substitutes each model's draftEquivalent. */
export function setDraftMode(id: string, enabled: boolean): void {
  getDb()
    .update(videos)
    .set({ draftMode: enabled, updatedAt: Date.now() })
    .where(eq(videos.id, id))
    .run()
}

/** Vision QC (§6.2): while on, successful image generations get one cheap vision check. */
export function setQcEnabled(id: string, enabled: boolean): void {
  getDb()
    .update(videos)
    .set({ qcEnabled: enabled, updatedAt: Date.now() })
    .where(eq(videos.id, id))
    .run()
}

export function renameVideo(id: string, name: string): void {
  getDb().update(videos).set({ name, updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}

export function deleteVideo(id: string): void {
  const db = getDb()
  // The cascade only removes the generation ROWS — their media files are
  // collected first and deleted once the rows are gone (assets are
  // project-scoped and survive the video).
  const media = db
    .select({ resultPath: generations.resultPath, lastFramePath: generations.lastFramePath })
    .from(generations)
    .innerJoin(nodes, eq(generations.nodeId, nodes.id))
    .where(eq(nodes.videoId, id))
    .all()
  // chat_threads.video_id has no FK (a conversation outlives its video), so the
  // demotion to "unbound" is explicit — otherwise a bound thread would keep
  // injecting a dead videoId into every tool call.
  unbindThreadsOfVideo(id)
  db.delete(videos).where(eq(videos.id, id)).run()
  for (const m of media) {
    deleteMediaFile(m.resultPath)
    deleteMediaFile(m.lastFramePath)
  }
}

export function touchVideo(id: string): void {
  getDb().update(videos).set({ updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}
