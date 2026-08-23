import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app } from 'electron'
import { renderVideo, type RenderOptions } from './render'
import { localMediaPath } from './timelineInfo'
import { getRoadmapContextForVideo } from './niches'
import * as graphService from './graph'
import * as videosService from './videos'

/**
 * export_publish_kit — everything needed to upload, in ONE folder: the
 * rendered MP4, the exported thumbnail (the workflow's thumbnail recipe node)
 * and a metadata.md carrying the roadmap item's packaging (title, variants,
 * description draft). Thin composition over render.ts (E2E scope); after the
 * upload, mark_roadmap_published closes the loop.
 */

const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'video'

function freshDir(base: string): string {
  let candidate = base
  for (let i = 2; existsSync(candidate); i++) candidate = `${base}-${i}`
  return candidate
}

/** The upload-ready sidecar, written from the roadmap item's packaging. */
function buildMetadataMarkdown(
  ctx: NonNullable<ReturnType<typeof getRoadmapContextForVideo>>
): string {
  const { item, niche } = ctx
  const lines: string[] = [`# ${item.title}`, '']
  if (item.titleVariants?.length) {
    lines.push('## Title variants', '', ...item.titleVariants.map((t) => `- ${t}`), '')
  }
  if (item.angle) lines.push('## Angle', '', item.angle, '')
  if (item.description) lines.push('## Description draft', '', item.description, '')
  if (item.thumbnailBrief) lines.push('## Thumbnail brief', '', item.thumbnailBrief, '')
  if (item.evidence) lines.push('## Evidence', '', item.evidence, '')
  lines.push('---', `Niche: ${niche.name}`)
  return lines.join('\n')
}

export async function exportPublishKit(
  videoId: string,
  opts: {
    outputDir?: string
  } & Pick<
    RenderOptions,
    'quality' | 'codec' | 'captionsPreset' | 'burnSubtitles' | 'duckMusic'
  > = {}
): Promise<{
  dir: string
  videoPath: string
  thumbnailPath: string | null
  metadataPath: string | null
  durationSeconds: number
  skipped: string[]
}> {
  const video = videosService.getVideo(videoId)
  if (!video) throw new Error('Video not found')
  const base = sanitize(video.name)
  const dir = opts.outputDir ?? freshDir(join(app.getPath('downloads'), `${base}-publish`))
  mkdirSync(dir, { recursive: true })

  const videoPath = join(dir, `${base}.mp4`)
  const { durationSeconds, skipped } = await renderVideo({
    videoId,
    outputPath: videoPath,
    ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.captionsPreset !== undefined ? { captionsPreset: opts.captionsPreset } : {}),
    ...(opts.burnSubtitles !== undefined ? { burnSubtitles: opts.burnSubtitles } : {}),
    ...(opts.duckMusic !== undefined ? { duckMusic: opts.duckMusic } : {})
  })

  // Thumbnail: the workflow's thumbnail recipe node's best local output.
  let thumbnailPath: string | null = null
  const { nodes } = graphService.listGraph(videoId)
  const thumbNode = nodes.find(
    (n) => (n.params as Record<string, unknown> | null)?.designId === 'thumbnail'
  )
  const thumbSource = thumbNode ? localMediaPath(thumbNode) : null
  if (thumbSource) {
    thumbnailPath = join(dir, `thumbnail${extname(thumbSource) || '.png'}`)
    copyFileSync(thumbSource, thumbnailPath)
  }

  // Packaging metadata: only when the video is linked to a roadmap item.
  let metadataPath: string | null = null
  const ctx = getRoadmapContextForVideo(videoId)
  if (ctx) {
    metadataPath = join(dir, 'metadata.md')
    writeFileSync(metadataPath, buildMetadataMarkdown(ctx))
  }

  return { dir, videoPath, thumbnailPath, metadataPath, durationSeconds, skipped }
}
