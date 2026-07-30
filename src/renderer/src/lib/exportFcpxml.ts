import type { GraphNode } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import { clipDuration, clipTrim, isStillClip, stillClipSeconds } from '@shared/timeline'

/**
 * FCPXML 1.8 timeline export, bundled with its media into a ZIP.
 *
 * The ZIP contains:
 *   - `<video>.fcpxml`        — the timeline
 *   - `media/NN-<label>.<ext>` — the actual generated clip for each slot
 *
 * Each timeline clip with a downloaded media becomes an `<asset-clip>` pointing
 * at the relative `media/…` path, so Final Cut / DaVinci relinks the files
 * straight out of the extracted folder. Clips with no usable output yet fall
 * back to a `<gap>` carrying a `<note>` — the slot keeps its place and timing.
 *
 * The "sections" of the timeline are the video-kind nodes in visual layout
 * order (see `collectTimelineClips`).
 */

const DEFAULT_FPS = 25
const DEFAULT_CLIP_SECONDS = 5 // fallback when a node carries no `duration` param

/**
 * Standard frame-rate timebases as exact rationals (seconds-per-frame = p/q).
 * Picking the table entry nearest the detected fps keeps `frameDuration` and all
 * derived times exact (e.g. 29.97 → 1001/30000s, never a rounded decimal).
 */
const FRAME_DURATIONS: ReadonlyArray<{ p: number; q: number }> = [
  { p: 1001, q: 24000 }, // 23.976
  { p: 100, q: 2400 }, // 24
  { p: 100, q: 2500 }, // 25
  { p: 1001, q: 30000 }, // 29.97
  { p: 100, q: 3000 }, // 30
  { p: 100, q: 4800 }, // 48
  { p: 100, q: 5000 }, // 50
  { p: 1001, q: 60000 }, // 59.94
  { p: 100, q: 6000 } // 60
]

function frameDurationFor(fps: number): { p: number; q: number } {
  let best = FRAME_DURATIONS[2] ?? { p: 100, q: 2500 } // 25
  let bestErr = Infinity
  for (const fd of FRAME_DURATIONS) {
    const err = Math.abs(fd.q / fd.p - fps)
    if (err < bestErr) {
      bestErr = err
      best = fd
    }
  }
  return best
}

/** Standard 16:9 pixel width for a frame height — used to name built-in FCP formats. */
const STD_16x9_WIDTH: Record<number, number> = { 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }
const FCP_RATE_CODES: ReadonlyArray<{ fps: number; code: string }> = [
  { fps: 23.976, code: '2398' },
  { fps: 24, code: '24' },
  { fps: 25, code: '25' },
  { fps: 29.97, code: '2997' },
  { fps: 30, code: '30' },
  { fps: 50, code: '50' },
  { fps: 59.94, code: '5994' },
  { fps: 60, code: '60' }
]

/**
 * FCP's built-in format name for a standard 16:9 resolution + rate, e.g.
 * 1280×720@24 → "FFVideoFormat720p24". Returns undefined for non-standard sizes,
 * leaving a nameless custom format — FCP accepts those for source assets but
 * warns ("unexpected value") when an unnamed custom format is a sequence format.
 */
function fcpFormatName(width: number, height: number, fps: number): string | undefined {
  if (STD_16x9_WIDTH[height] !== width) return undefined
  let code: string | undefined
  let bestErr = Infinity
  for (const r of FCP_RATE_CODES) {
    const err = Math.abs(r.fps - fps)
    if (err < bestErr) {
      bestErr = err
      code = r.code
    }
  }
  return code && bestErr <= 0.2 ? `FFVideoFormat${height}p${code}` : undefined
}

/** Real, probed properties of a clip's bundled media (see probeMedia). */
export interface ClipMedia {
  width: number
  height: number
  /** Real media duration in seconds. */
  duration: number
}

/** One timeline slot: the node plus the relative path of its media inside the ZIP (if any). */
export interface FcpxmlClip {
  node: GraphNode
  /** e.g. "media/01-intro.mp4". Undefined → no usable output, rendered as a placeholder gap. */
  mediaPath?: string
  /**
   * When true, `mediaPath` is a still image standing in for a video that failed
   * to generate (the node's input image). It's held for the full clip duration.
   */
  isStill?: boolean
  /** Probed real resolution/duration of the bundled video, when available. */
  media?: ClipMedia
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clipFormat(node: GraphNode): string | undefined {
  const params = node.params as { resolution?: unknown; aspect_ratio?: unknown } | undefined
  const r = typeof params?.resolution === 'string' ? params.resolution : undefined
  const a = typeof params?.aspect_ratio === 'string' ? params.aspect_ratio : undefined
  if (r && a) return `${r} · ${a}`
  return r ?? a
}

function clipPrompt(node: GraphNode): string | undefined {
  const p = (node.params as { prompt?: unknown } | undefined)?.prompt
  return typeof p === 'string' && p.trim() ? p.trim() : undefined
}

export function clipLabel(node: GraphNode): string {
  return node.label ?? getModel(node.modelId)?.label ?? node.modelId.split('/').pop() ?? 'clip'
}

/** Slug safe for a filename, derived from a clip's label. */
export function clipSlug(node: GraphNode): string {
  return (
    clipLabel(node)
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase() || 'clip'
  )
}

/** Map a media MIME type to a file extension for the bundled file. */
export function extForMime(mime: string | undefined): string {
  switch (mime) {
    case 'video/mp4':
      return 'mp4'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return mime?.startsWith('image/') ? 'img' : 'mp4'
  }
}

function buildNote(node: GraphNode, index: number, dur: number, isStill: boolean): string {
  const model = getModel(node.modelId)
  return [
    `Shot ${index + 1} — ${model?.label ?? node.modelId} | ${dur.toFixed(1)}s`,
    isStill && 'STILL: video generation failed — input image held as placeholder',
    clipPrompt(node) && `Prompt: ${clipPrompt(node)}`,
    clipFormat(node) && `Format: ${clipFormat(node)}`
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Build the FCPXML document for a video's timeline.
 * `clips` must already be in timeline order (use `collectTimelineClips`).
 *
 * `opts.fps` is the detected source frame rate; the sequence canvas (resolution)
 * is taken from the first clip's probed media. Both fall back to 25fps / 1080p
 * when nothing could be probed.
 */
export function buildFcpxml(
  videoName: string,
  clips: FcpxmlClip[],
  opts: { fps?: number } = {}
): string {
  const name = escapeXml(videoName || 'Untitled')

  const fps = opts.fps && opts.fps > 0 ? opts.fps : DEFAULT_FPS
  const fd = frameDurationFor(fps)
  const toFrames = (seconds: number) => Math.round((seconds * fd.q) / fd.p)
  const fromFrames = (frames: number) => `${frames * fd.p}/${fd.q}s`
  const frameDuration = `${fd.p}/${fd.q}s`

  // Each distinct probed resolution becomes a <format> resource that assets
  // reference, exactly like a real FCP export. A video asset with no `format`
  // (or one that lies about resolution/fps) crashes the import — so every asset
  // points at a format whose width/height/frameDuration match the real file.
  const formats = new Map<string, { id: string; width: number; height: number }>()
  const ensureFormat = (width: number, height: number): string => {
    const key = `${width}x${height}`
    const existing = formats.get(key)
    if (existing) return existing.id
    const id = `r${formats.size + 1}`
    formats.set(key, { id, width, height })
    return id
  }
  // r1 = the sequence canvas: first probed resolution, else 1080p.
  const first = clips.find((c) => c.media)?.media
  const sequenceFormatId = ensureFormat(first?.width ?? 1920, first?.height ?? 1080)

  const assets: string[] = []
  const spine: string[] = []
  // Accumulate in whole frames so spine offsets stay gapless and frame-aligned
  // (summing rounded per-clip durations, never raw floats).
  let offsetFrames = 0

  clips.forEach(({ node, mediaPath, isStill, media }, i) => {
    // Prefer the real probed media duration; fall back to the node's configured
    // length — a user-placed still's length being its trim window.
    const raw =
      media?.duration ??
      (isStillClip(node) ? stillClipSeconds(node) : (clipDuration(node) ?? DEFAULT_CLIP_SECONDS))
    // Timeline trim: the clip plays [start, end] of its media. Stills ignore it
    // (their hold time is the declared clip duration, there is no in-point).
    const trim = isStill ? { start: 0, end: raw } : clipTrim(node, raw)
    const dur = (trim.end ?? raw) - trim.start
    const frames = Math.max(1, toFrames(dur))
    const duration = fromFrames(frames)
    const off = fromFrames(offsetFrames)
    const mediaStart = fromFrames(toFrames(trim.start))
    const clipName = escapeXml(`${String(i + 1).padStart(2, '0')} - ${clipLabel(node)}`)
    const note = escapeXml(buildNote(node, i, dur, !!(mediaPath && isStill)))
    const assetId = `a${i + 1}`
    // A clip's asset uses its own real resolution's format; stills/unknowns reuse the canvas.
    const formatId = media ? ensureFormat(media.width, media.height) : sequenceFormatId

    if (mediaPath && isStill) {
      // Still image standing in for a failed video: image asset + a <video> element
      // (FCP's still/generator clip) held for the whole clip duration.
      assets.push(
        `<asset id="${assetId}" name="${clipName}" src="${escapeXml(mediaPath)}" start="0s" duration="${duration}" hasVideo="1" format="${formatId}"/>`
      )
      spine.push(
        `<video ref="${assetId}" offset="${off}" name="${clipName}" duration="${duration}" start="0s"><note>${note}</note></video>`
      )
    } else if (mediaPath) {
      // No `hasAudio`: these AI clips are silent, and claiming audio makes FCP
      // conform a track that doesn't exist. `format` matches the real media.
      // The asset covers the WHOLE media; the spine clip's `start` is the
      // trim in-point, so FCP keeps the discarded head available for slipping.
      assets.push(
        `<asset id="${assetId}" name="${clipName}" src="${escapeXml(mediaPath)}" start="0s" duration="${fromFrames(Math.max(1, toFrames(raw)))}" hasVideo="1" format="${formatId}"/>`
      )
      spine.push(
        `<asset-clip ref="${assetId}" offset="${off}" name="${clipName}" duration="${duration}" start="${mediaStart}"><note>${note}</note></asset-clip>`
      )
    } else {
      spine.push(
        `<gap name="${clipName}" offset="${off}" duration="${duration}"><note>${note}</note></gap>`
      )
    }

    offsetFrames += frames
  })

  const formatEls = [...formats.values()].map((f) => {
    const fname = fcpFormatName(f.width, f.height, fps)
    const nameAttr = fname ? ` name="${fname}"` : ''
    return `<format id="${f.id}"${nameAttr} frameDuration="${frameDuration}" width="${f.width}" height="${f.height}"/>`
  })

  // Wrap the project in <library><event> — the structure FCP itself exports.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
    ${formatEls.join('\n    ')}
    ${assets.join('\n    ')}
  </resources>
  <library>
    <event name="${name}">
      <project name="${name}">
        <sequence format="${sequenceFormatId}" tcStart="0s" tcFormat="NDF" duration="${fromFrames(offsetFrames)}">
          <spine>${spine.join('')}</spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
}

/** Filesystem-safe base name (no extension) derived from the video name. */
export function sanitizeName(videoName: string, fallback: string): string {
  const cleaned = (videoName || fallback).replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '_')
  return cleaned || fallback
}
