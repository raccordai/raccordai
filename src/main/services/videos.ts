import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Video } from '@shared/ipc/contracts'
import { isStyleId } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { videos } from '../db/schema'
import { unbindThreadsOfVideo } from './chatStore'

export type VideoRow = typeof videos.$inferSelect

/** DB row → DTO: the toggles are nullable columns (additive migration), booleans in the contract. */
export function toVideo(row: VideoRow): Video {
  return { ...row, draftMode: row.draftMode ?? false, qcEnabled: row.qcEnabled ?? false }
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
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(videos).values(video).run()
  return video
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
  // chat_threads.video_id has no FK (a conversation outlives its video), so the
  // demotion to "unbound" is explicit — otherwise a bound thread would keep
  // injecting a dead videoId into every tool call.
  unbindThreadsOfVideo(id)
  getDb().delete(videos).where(eq(videos.id, id)).run()
}

export function touchVideo(id: string): void {
  getDb().update(videos).set({ updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}
