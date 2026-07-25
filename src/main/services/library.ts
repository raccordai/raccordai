import { desc, eq, inArray } from 'drizzle-orm'
import { getModel } from '@shared/models'
import type { MediaKind } from './libraryTypes'
import { toVideo } from './videos'
import { getDb } from '../db/client'
import { generations, nodes, projects, videos } from '../db/schema'

/**
 * Library overviews — the data behind the project/video card screens:
 * counts plus a thumbnail derived from the most recent successful generation.
 */

export interface Thumbnail {
  thumbnailUrl: string | null
  thumbnailKind: MediaKind | null
}

function kindForMime(mime: string | null): MediaKind | null {
  if (!mime) return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

/** Latest successful, locally-available generation among the given videos. */
function thumbnailForVideos(videoIds: string[]): Thumbnail {
  if (videoIds.length === 0) return { thumbnailUrl: null, thumbnailKind: null }
  const rows = getDb()
    .select()
    .from(generations)
    .where(inArray(generations.videoId, videoIds))
    .orderBy(desc(generations.createdAt))
    .all()
  for (const gen of rows) {
    if (gen.status !== 'success') continue
    const kind = kindForMime(gen.resultMimeType)
    if (kind === 'audio') continue
    const url = gen.resultPath ? `media://generation/${gen.id}/result` : (gen.resultUrl ?? null)
    if (url) return { thumbnailUrl: url, thumbnailKind: kind ?? 'image' }
  }
  return { thumbnailUrl: null, thumbnailKind: null }
}

export function projectsOverview() {
  const db = getDb()
  return db
    .select()
    .from(projects)
    .orderBy(desc(projects.updatedAt))
    .all()
    .map((project) => {
      const vids = db
        .select({ id: videos.id })
        .from(videos)
        .where(eq(videos.projectId, project.id))
        .all()
      return {
        ...project,
        videoCount: vids.length,
        ...thumbnailForVideos(vids.map((v) => v.id))
      }
    })
}

export function videosOverview(projectId: string) {
  const db = getDb()
  return db
    .select()
    .from(videos)
    .where(eq(videos.projectId, projectId))
    .orderBy(desc(videos.updatedAt))
    .all()
    .map((video) => {
      const nodeRows = db
        .select({ modelId: nodes.modelId })
        .from(nodes)
        .where(eq(nodes.videoId, video.id))
        .all()
      return {
        ...toVideo(video),
        nodeCount: nodeRows.length,
        clipCount: nodeRows.filter((n) => getModel(n.modelId)?.kind === 'video').length,
        ...thumbnailForVideos([video.id])
      }
    })
}
