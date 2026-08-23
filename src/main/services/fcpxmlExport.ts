import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app } from 'electron'
import { ffprobePath } from '../media/ffbin'
import {
  buildFcpxml,
  clipSlug,
  sanitizeName,
  type FcpxmlAudioTrack,
  type FcpxmlClip
} from '@shared/fcpxml'
import {
  audioLaneStarts,
  audioRoleOf,
  bestGeneration,
  clipDuration,
  clipTimelineOffset,
  clipTrim,
  collectAudioNodes,
  collectTimelineClips,
  isStillClip
} from '@shared/timeline'
import type { GraphNode } from '@shared/ipc/contracts'
import { parseFfprobeJson, type ClipProbe } from './renderPlan'
import {
  listGenerationsForNode,
  resolveSelectedOutputUrl,
  timelineFallbackImages
} from './generations'
import { resolveMediaUrlToFile } from '../media/protocol'
import * as graphService from './graph'
import * as videosService from './videos'

/**
 * Headless FCPXML export (export_fcpxml) — the renderer's ZIP flow rebuilt on
 * main so agents can hand a cut to a human editor without opening the app:
 * one folder with `<video>.fcpxml` + `media/…`, every decision in the shared
 * pure `buildFcpxml` (tested). Local media only — never downloads; slots
 * without a usable local output become placeholder gaps, like the UI export.
 */

const exec = promisify(execFile)

async function probe(path: string): Promise<ClipProbe | null> {
  try {
    const { stdout } = await exec(ffprobePath(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path
    ])
    return parseFfprobeJson(JSON.parse(stdout))
  } catch {
    return null
  }
}

/** Local path of the node's best successful output (video/audio/image). */
function localOutputPath(node: GraphNode): string | null {
  const rows = listGenerationsForNode(node.id)
  const best = bestGeneration(
    node,
    rows.map((r) => ({ id: r.id, status: r.status, url: r.resultPath ?? r.resultUrl }))
  )
  if (best?.status !== 'success') return null
  const row = rows.find((r) => r.id === best.id)
  return row?.resultPath && existsSync(row.resultPath) ? row.resultPath : null
}

function freshDir(base: string): string {
  let candidate = base
  for (let i = 2; existsSync(candidate); i++) candidate = `${base}-${i}`
  return candidate
}

export async function exportFcpxmlBundle(
  videoId: string,
  opts: { outputDir?: string } = {}
): Promise<{
  dir: string
  fcpxmlPath: string
  mediaCount: number
  /** Slots exported as placeholder gaps (no usable local output). */
  gaps: string[]
}> {
  const video = videosService.getVideo(videoId)
  if (!video) throw new Error('Video not found')
  const graph = graphService.listGraph(videoId)
  const { nodes } = graph
  const timelineClips = collectTimelineClips(nodes)
  if (timelineClips.length === 0) throw new Error('The timeline has no clip to export')
  const fallbacks = timelineFallbackImages(videoId, graph)

  const baseName = sanitizeName(video.name, 'timeline')
  const dir = opts.outputDir ?? freshDir(join(app.getPath('downloads'), `${baseName}-fcpxml`))
  mkdirSync(join(dir, 'media'), { recursive: true })

  const gaps: string[] = []
  let mediaCount = 0
  const copyInto = (source: string, relPath: string): void => {
    copyFileSync(source, join(dir, relPath))
    mediaCount += 1
  }

  const clips: FcpxmlClip[] = []
  let fps: number | undefined
  for (const [i, node] of timelineClips.entries()) {
    const prefix = `media/${String(i + 1).padStart(2, '0')}-${clipSlug(node)}`
    if (isStillClip(node)) {
      const url = resolveSelectedOutputUrl(node, 'output')
      const local = url ? resolveMediaUrlToFile(url) : null
      if (local?.path && existsSync(local.path)) {
        const rel = `${prefix}-still${extname(local.path) || '.jpg'}`
        copyInto(local.path, rel)
        clips.push({ node, mediaPath: rel, isStill: true })
      } else {
        gaps.push(node.label ?? node.key)
        clips.push({ node })
      }
      continue
    }
    const source = localOutputPath(node)
    if (source) {
      const rel = `${prefix}${extname(source) || '.mp4'}`
      copyInto(source, rel)
      const probed = await probe(source)
      fps ??= probed?.fps ?? undefined
      clips.push({
        node,
        mediaPath: rel,
        ...(probed?.width && probed.height && probed.durationSeconds
          ? {
              media: {
                width: probed.width,
                height: probed.height,
                duration: probed.durationSeconds
              }
            }
          : {})
      })
      continue
    }
    const fallbackUrl = fallbacks[node.id]
    const local = fallbackUrl ? resolveMediaUrlToFile(fallbackUrl) : null
    if (local?.path && existsSync(local.path)) {
      const rel = `${prefix}-still${extname(local.path) || '.jpg'}`
      copyInto(local.path, rel)
      clips.push({ node, mediaPath: rel, isStill: true })
    } else {
      gaps.push(node.label ?? node.key)
      clips.push({ node })
    }
  }

  // §8 audio lanes — same layout as the preview/render (audioLaneStarts).
  const audioResolved: Array<{ node: GraphNode; path: string; duration?: number }> = []
  for (const [i, node] of collectAudioNodes(nodes).entries()) {
    const source = localOutputPath(node)
    if (!source) continue
    const rel = `media/audio-${String(i + 1).padStart(2, '0')}-${clipSlug(node)}${extname(source) || '.mp3'}`
    copyInto(source, rel)
    const probed = await probe(source)
    audioResolved.push({
      node,
      path: rel,
      ...(probed?.durationSeconds ? { duration: probed.durationSeconds } : {})
    })
  }
  const audioTracks: FcpxmlAudioTrack[] = []
  for (const role of ['music', 'speech'] as const) {
    const lane = audioResolved.filter((track) => audioRoleOf(track.node) === role)
    const starts = audioLaneStarts(
      lane.map((track) => {
        const raw = track.duration ?? clipDuration(track.node) ?? 5
        const trim = clipTrim(track.node, raw)
        return {
          offsetSec: clipTimelineOffset(track.node),
          durationSeconds: Math.max(0, (trim.end ?? raw) - trim.start)
        }
      })
    )
    lane.forEach((track, i) =>
      audioTracks.push({
        node: track.node,
        mediaPath: track.path,
        role,
        ...(track.duration !== undefined ? { duration: track.duration } : {}),
        startSec: starts[i] ?? 0
      })
    )
  }

  const xml = buildFcpxml(video.name, clips, {
    ...(fps !== undefined ? { fps } : {}),
    audio: audioTracks
  })
  const fcpxmlPath = join(dir, `${baseName}.fcpxml`)
  writeFileSync(fcpxmlPath, xml)
  return { dir, fcpxmlPath, mediaCount, gaps }
}
