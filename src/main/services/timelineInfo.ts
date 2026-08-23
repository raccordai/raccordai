import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ffprobePath } from '../media/ffbin'
import type { GraphNode } from '@shared/ipc/contracts'
import {
  bestGeneration,
  collectAudioNodes,
  collectTimelineClips,
  isStillClip,
  resolveTimeline,
  type ResolvedTimeline
} from '@shared/timeline'
import { parseFfprobeJson } from './renderPlan'
import { listGenerationsForNode } from './generations'
import * as graphService from './graph'
import * as videosService from './videos'

/**
 * Read-only resolved timeline for agents (MCP `get_timeline`): every decision
 * lives in the pure `resolveTimeline` (shared/timeline.ts, tested); this file
 * only probes local media for real durations — a thin shell out of unit
 * coverage, like render.ts. Nodes whose media has no local file fall back to
 * their declared params duration (the resolver reports the provenance).
 */

/** Measured media length in seconds, or null (missing/unreadable file). */
async function probeDurationSeconds(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          resolve(parseFfprobeJson(JSON.parse(stdout)).durationSeconds ?? null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/** Local file of the node's best successful output (never downloads). */
export function localMediaPath(node: GraphNode): string | null {
  const rows = listGenerationsForNode(node.id)
  const best = bestGeneration(
    node,
    rows.map((r) => ({ id: r.id, status: r.status, url: r.resultPath ?? r.resultUrl }))
  )
  if (best?.status !== 'success') return null
  const row = rows.find((r) => r.id === best.id)
  return row?.resultPath && existsSync(row.resultPath) ? row.resultPath : null
}

export async function getTimelineInfo(videoId: string): Promise<ResolvedTimeline> {
  if (!videosService.getVideo(videoId)) throw new Error(`Unknown videoId "${videoId}".`)
  const { nodes } = graphService.listGraph(videoId)

  // Probe every playable node that has a local result — measured durations
  // are what make sub-second audio sync trustworthy (declared params drift).
  const playable = [...collectTimelineClips(nodes), ...collectAudioNodes(nodes)].filter(
    (n) => !isStillClip(n)
  )
  const mediaDurations: Record<string, number> = {}
  await Promise.all(
    playable.map(async (node) => {
      const path = localMediaPath(node)
      if (!path) return
      const duration = await probeDurationSeconds(path)
      if (duration !== null && duration > 0) mediaDurations[node.id] = duration
    })
  )

  return resolveTimeline(nodes, mediaDurations)
}
