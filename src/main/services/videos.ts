import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Video } from '@shared/ipc/contracts'
import { isStyleId } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { videos } from '../db/schema'

export function listVideos(projectId: string): Video[] {
  return getDb()
    .select()
    .from(videos)
    .where(eq(videos.projectId, projectId))
    .orderBy(desc(videos.updatedAt))
    .all()
}

export function getVideo(id: string): Video | null {
  return getDb().select().from(videos).where(eq(videos.id, id)).get() ?? null
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

export function renameVideo(id: string, name: string): void {
  getDb().update(videos).set({ name, updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}

export function deleteVideo(id: string): void {
  getDb().delete(videos).where(eq(videos.id, id)).run()
}

export function touchVideo(id: string): void {
  getDb().update(videos).set({ updatedAt: Date.now() }).where(eq(videos.id, id)).run()
}
