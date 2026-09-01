import { existsSync } from 'node:fs'
import type { Asset, Video } from '@shared/ipc/contracts'
import { mediaKindFor } from '../media/files'
import { importAssetFromFile } from './assets'
import { createNode, setClipFraming, setClipTrim, setTimelineOrder } from './graph'
import { withGraphHistoryGroup } from './graphHistory'
import { createVideo, getVideo, setVideoDefaults, setVideoStyle } from './videos'

/** One excerpt of the source film, in MEDIA seconds of the rendered MP4. */
export interface ShortSegment {
  startSec: number
  endSec: number
}

export interface DeriveShortResult {
  video: Video
  asset: Asset
  nodeIds: string[]
}

/** Enough for a Short — and one asset node per segment keeps the graph readable. */
const MAX_SHORT_SEGMENTS = 20
/** Below this a slot is a flash frame, not a cut. */
const MIN_SEGMENT_SECONDS = 0.1

/**
 * Validate the caller's excerpt list. Order is preserved on purpose — the
 * Short's narrative order is the caller's call, not the source chronology.
 * Out-points past the media's real end are NOT rejected here (the file is
 * never probed): the shared clipTrim clamps them at read time, so an
 * optimistic end degrades to "play until the end of the excerpt's media".
 */
export function normalizeShortSegments(segments: ShortSegment[]): ShortSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('At least one segment is required.')
  }
  if (segments.length > MAX_SHORT_SEGMENTS) {
    throw new Error(`Too many segments (max ${MAX_SHORT_SEGMENTS}).`)
  }
  return segments.map((s, i) => {
    const start = Number(s.startSec)
    const end = Number(s.endSec)
    if (!Number.isFinite(start) || start < 0) {
      throw new Error(`Segment ${i + 1}: startSec must be ≥ 0.`)
    }
    if (!Number.isFinite(end) || end - start < MIN_SEGMENT_SECONDS) {
      throw new Error(
        `Segment ${i + 1}: endSec must be at least ${MIN_SEGMENT_SECONDS}s after startSec.`
      )
    }
    return { startSec: start, endSec: end }
  })
}

/**
 * Derive a 9:16 Short from a FINISHED 16:9 video (§4 of the product pitch):
 * the rendered MP4 is imported as a project VIDEO ASSET, and a new 9:16 video
 * is built next to the source with one `studio/asset` clip per requested
 * excerpt — trimmed to its window and framed 'fill' so the 16:9 picture
 * center-crops into the vertical frame instead of letterboxing. All graph
 * mutations land in ONE undo step on the new video.
 *
 * The source MP4's media time IS the source video's final-timeline time
 * (a render is 1:1), so segments can be read straight off get_timeline or a
 * speech transcript. Render the result with a vertical resolution override
 * (e.g. 1080×1920) — the sequence spec still follows the first clip's probe.
 */
export function deriveShort(args: {
  videoId: string
  sourcePath: string
  segments: ShortSegment[]
  title?: string
}): DeriveShortResult {
  const source = getVideo(args.videoId)
  if (!source) throw new Error(`Unknown videoId: ${args.videoId}`)
  const segments = normalizeShortSegments(args.segments)
  if (!existsSync(args.sourcePath)) {
    throw new Error(`Source file not found: ${args.sourcePath}`)
  }
  if (mediaKindFor(args.sourcePath) !== 'video') {
    throw new Error('The source must be a video file (the rendered MP4 of the finished video).')
  }

  const asset = importAssetFromFile(source.projectId, args.sourcePath)
  const video = createVideo(source.projectId, args.title?.trim() || `${source.name} — Short`)
  // The Short inherits the film's art direction; its own defaults go vertical.
  if (source.styleId) setVideoStyle(video.id, source.styleId)
  setVideoDefaults(video.id, { defaultAspectRatio: '9:16' })

  const nodeIds = withGraphHistoryGroup(video.id, () => {
    const ids = segments.map((segment, i) => {
      const node = createNode({
        videoId: video.id,
        modelId: 'studio/asset',
        key: `short_${i + 1}`,
        label: `Short ${i + 1}`,
        params: { assetId: asset.id }
      })
      setClipTrim(node.id, { trimStartSec: segment.startSec, trimEndSec: segment.endSec })
      setClipFraming(node.id, 'fill')
      return node.id
    })
    setTimelineOrder(video.id, ids)
    return ids
  })

  return { video: getVideo(video.id) ?? video, asset, nodeIds }
}
