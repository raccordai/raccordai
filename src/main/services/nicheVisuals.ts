import { nicheRatio } from '@shared/niches'
import type { NicheVideo } from '@shared/ipc/contracts'
import type { ToolMediaResult } from '../mcp/registry'
import { previewImageBase64 } from './mediaPreview'
import { localMediaPath } from './timelineInfo'
import { getRoadmapContextForVideo, listNicheVideos } from './niches'
import * as graphService from './graph'

/**
 * Packaging-first, made visible to agents (§7c): competitor thumbnails and the
 * feed-preview ingredients as inline image content, so an agent can judge a
 * candidate thumbnail against the niche's real feed instead of working blind
 * on briefs. Thin fetch shell (i.ytimg thumbnails), out of unit coverage like
 * the other network clients.
 */

const THUMBNAILS_DEFAULT = 8
const THUMBNAILS_MAX = 12
/** A YouTube thumbnail is ~30-80 KB; anything past this is not a thumbnail. */
const THUMBNAIL_BYTES_MAX = 2 * 1024 * 1024

async function fetchThumbnail(url: string): Promise<{ mediaType: string; base64: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg'
    if (!mediaType.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > THUMBNAIL_BYTES_MAX) return null
    return { mediaType, base64: buf.toString('base64') }
  } catch {
    return null
  }
}

const competitorRow = (video: NicheVideo, imageIndex: number | null): Record<string, unknown> => {
  const ratio = nicheRatio(video.views, video.channelSubscribers)
  return {
    image: imageIndex,
    title: video.title,
    channel: video.channelTitle,
    views: video.views,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null
  }
}

/**
 * get_niche_thumbnails — the strongest tracked videos' thumbnails as images,
 * best signal first: the visual language the niche actually clicks on.
 */
export async function nicheThumbnails(
  nicheId: string,
  opts: { limit?: number; format?: 'all' | 'long' | 'short' } = {}
): Promise<ToolMediaResult> {
  const limit = Math.min(THUMBNAILS_MAX, Math.max(1, opts.limit ?? THUMBNAILS_DEFAULT))
  const videos = listNicheVideos(
    nicheId,
    { sort: 'ratio', ...(opts.format ? { format: opts.format } : {}) },
    limit * 2
  )
  const images: ToolMediaResult['images'] = []
  const rows: Array<Record<string, unknown>> = []
  for (const video of videos) {
    if (images.length >= limit) break
    const thumb = video.thumbnail ? await fetchThumbnail(video.thumbnail) : null
    if (!thumb) continue
    images.push(thumb)
    rows.push(competitorRow(video, images.length))
  }
  if (images.length === 0) {
    throw new Error('No competitor thumbnail could be fetched — refresh_niche first?')
  }
  return {
    kind: 'tool-media',
    // `image` is the 1-based index of the row's thumbnail in the content above.
    text: JSON.stringify({ nicheId, thumbnails: rows }),
    images
  }
}

/**
 * get_feed_preview — the FeedPreviewModal for agents: image 1 is the video's
 * candidate thumbnail (the workflow's thumbnail recipe node), the following
 * images are the niche's strongest competitor thumbnails, and the text part
 * carries the title variants to judge against the competitors' titles.
 */
export async function feedPreview(
  videoId: string,
  opts: { competitors?: number } = {}
): Promise<ToolMediaResult> {
  const ctx = getRoadmapContextForVideo(videoId)
  if (!ctx) {
    throw new Error('This video is not linked to a roadmap item — assign_roadmap_item first.')
  }
  const { nodes } = graphService.listGraph(videoId)
  const thumbNode = nodes.find(
    (n) => (n.params as Record<string, unknown> | null)?.designId === 'thumbnail'
  )
  const path = thumbNode ? localMediaPath(thumbNode) : null
  if (!path) {
    throw new Error('No generated thumbnail yet — run the video’s thumbnail node first.')
  }
  const candidate = await previewImageBase64(path, { maxDim: 480 })

  const limit = Math.min(THUMBNAILS_MAX, Math.max(1, opts.competitors ?? 6))
  const competitors = listNicheVideos(ctx.niche.id, { sort: 'ratio' }, limit * 2)
  const images: ToolMediaResult['images'] = [{ mediaType: 'image/jpeg', base64: candidate }]
  const rows: Array<Record<string, unknown>> = []
  for (const video of competitors) {
    if (images.length >= limit + 1) break
    const thumb = video.thumbnail ? await fetchThumbnail(video.thumbnail) : null
    if (!thumb) continue
    images.push(thumb)
    rows.push(competitorRow(video, images.length))
  }
  return {
    kind: 'tool-media',
    text: JSON.stringify({
      note: 'Image 1 is YOUR candidate thumbnail; the following images are the niche’s strongest competitors. Judge legibility, contrast and differentiation at feed size.',
      title: ctx.item.title,
      titleVariants: ctx.item.titleVariants ?? [],
      competitors: rows
    }),
    images
  }
}
