import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ffmpegPath, ffprobePath } from '../media/ffbin'
import { mediaKindFor } from '../media/files'
import { getGeneration } from './generations'
import { entryAtTimecode } from '@shared/timeline'
import { getTimelineInfo, localMediaPath } from './timelineInfo'
import * as graphService from './graph'
import { buildPreviewArgs, resolvePreviewSeek, type PreviewPosition } from './renderPlan'
import type { ToolMediaResult } from '../mcp/registry'

/**
 * Agent vision (get_generation_media) — turns a generation's cached media into
 * a small inline JPEG the model can actually look at. Thin ffmpeg shell like
 * render.ts: every decision (seek resolution, argv) is pure in renderPlan.ts;
 * this file only spawns and reads files (E2E scope, not unit coverage).
 */

const exec = promisify(execFile)

export async function probeDurationSec(path: string): Promise<number | null> {
  try {
    const { stdout } = await exec(ffprobePath(), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      path
    ])
    const n = Number.parseFloat(stdout.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Renders one media file to a downscaled base64 JPEG (shared by the tools). */
export async function previewImageBase64(
  mediaPath: string,
  seek: { atSec?: number; fromEnd?: boolean; maxDim?: number } = {}
): Promise<string> {
  const dir = join(tmpdir(), 'raccord-preview')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${randomUUID()}.jpg`)
  try {
    await exec(ffmpegPath(), buildPreviewArgs(mediaPath, out, seek))
    return readFileSync(out).toString('base64')
  } finally {
    rmSync(out, { force: true })
  }
}

export async function generationMediaPreview(
  generationId: string,
  opts: { position?: PreviewPosition; atSec?: number } = {}
): Promise<ToolMediaResult> {
  const gen = getGeneration(generationId)
  if (!gen) throw new Error(`Unknown generation: ${generationId}`)
  if (gen.status !== 'success') {
    throw new Error(`Generation is ${gen.status} — only successful generations have media.`)
  }
  if (!gen.resultPath) {
    throw new Error(
      'The result is not cached locally yet — call refresh_generation_status, then retry.'
    )
  }
  const kind = mediaKindFor(gen.resultPath)
  if (kind !== 'image' && kind !== 'video') {
    throw new Error('This generation is audio — it has no visual preview; use get_transcript.')
  }
  const seek =
    kind === 'video'
      ? opts.atSec !== undefined
        ? { atSec: Math.max(0, opts.atSec) }
        : resolvePreviewSeek(opts.position ?? 'middle', await probeDurationSec(gen.resultPath))
      : {}
  const base64 = await previewImageBase64(gen.resultPath, seek)
  const frame =
    kind === 'video'
      ? opts.atSec !== undefined
        ? `${Math.max(0, opts.atSec)}s`
        : (opts.position ?? 'middle')
      : undefined
  return {
    kind: 'tool-media',
    text: JSON.stringify({ generationId, mediaKind: kind, ...(frame ? { frame } : {}) }),
    images: [{ mediaType: 'image/jpeg', base64 }]
  }
}

/**
 * get_frame_at — the frame of the FINAL timeline under a timecode: trims,
 * speed and transition overlaps applied by the shared resolveTimeline, media
 * time mapped by the pure entryAtTimecode.
 */
export async function timelineFrame(videoId: string, atSec: number): Promise<ToolMediaResult> {
  const timeline = await getTimelineInfo(videoId)
  const hit = entryAtTimecode(timeline.entries, atSec)
  if (!hit) {
    throw new Error(
      `No clip under ${atSec}s — the film runs 0..${timeline.totalSeconds.toFixed(2)}s.`
    )
  }
  const { nodes } = graphService.listGraph(videoId)
  const node = nodes.find((n) => n.id === hit.entry.nodeId)
  const path = node ? localMediaPath(node) : null
  if (!path) {
    throw new Error(
      `The clip under ${atSec}s ("${hit.entry.label ?? hit.entry.nodeKey}") has no local media yet — run the node first.`
    )
  }
  const base64 = await previewImageBase64(path, hit.entry.still ? {} : { atSec: hit.mediaSec })
  return {
    kind: 'tool-media',
    text: JSON.stringify({
      atSec,
      nodeId: hit.entry.nodeId,
      nodeKey: hit.entry.nodeKey,
      label: hit.entry.label,
      entryStartSec: hit.entry.startSec,
      entryEndSec: hit.entry.endSec,
      mediaSec: Number(hit.mediaSec.toFixed(3))
    }),
    images: [{ mediaType: 'image/jpeg', base64 }]
  }
}

const CONTACT_SHEET_MAX = 16

/**
 * get_timeline_contact_sheet — one small frame per timeline entry (its
 * midpoint), in order: the cheapest way for an agent to "watch" the film and
 * spot a broken shot, a continuity break or a wrong order. Entries without
 * local media are listed in the text part instead of an image.
 */
export async function timelineContactSheet(
  videoId: string,
  opts: { maxEntries?: number } = {}
): Promise<ToolMediaResult> {
  const timeline = await getTimelineInfo(videoId)
  const limit = Math.min(CONTACT_SHEET_MAX, Math.max(1, opts.maxEntries ?? 12))
  const entries = timeline.entries.slice(0, limit)
  const { nodes } = graphService.listGraph(videoId)
  const nodesById = new Map(nodes.map((n) => [n.id, n]))

  const images: ToolMediaResult['images'] = []
  const rows: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    const midpoint = entry.startSec + entry.durationSec / 2
    const hit = entryAtTimecode(timeline.entries, midpoint)
    const node = nodesById.get(entry.nodeId)
    const path = node ? localMediaPath(node) : null
    const row: Record<string, unknown> = {
      image: null as number | null,
      nodeKey: entry.nodeKey,
      label: entry.label,
      startSec: Number(entry.startSec.toFixed(2)),
      endSec: Number(entry.endSec.toFixed(2)),
      durationSource: entry.durationSource
    }
    if (path && hit) {
      const base64 = await previewImageBase64(
        path,
        entry.still ? { maxDim: 384 } : { atSec: hit.mediaSec, maxDim: 384 }
      )
      images.push({ mediaType: 'image/jpeg', base64 })
      row.image = images.length
    } else {
      row.missing = 'no local media yet'
    }
    rows.push(row)
  }
  return {
    kind: 'tool-media',
    text: JSON.stringify({
      totalSeconds: timeline.totalSeconds,
      entriesShown: entries.length,
      entriesTotal: timeline.entries.length,
      // `image` is the 1-based index of the row's frame in the content above.
      entries: rows
    }),
    images
  }
}
