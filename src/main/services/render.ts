import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { app } from 'electron'
import { ffmpegPath, ffprobePath } from '../media/ffbin'
import type { GraphNode } from '@shared/ipc/contracts'
import {
  bestGeneration,
  clipDuration,
  collectAudioNodes,
  collectTimelineClips
} from '@shared/timeline'
import { broadcastRenderProgress } from '../events'
import { resolveMediaUrlToFile } from '../media/protocol'
import { listGenerationsForNode, timelineFallbackImages } from './generations'
import * as graphService from './graph'
import * as videosService from './videos'
import {
  buildConcatArgs,
  buildConcatListContent,
  buildMuxArgs,
  buildNormalizeArgs,
  canConcatLosslessly,
  computeStageSpans,
  decideSequenceSpec,
  DEFAULT_STILL_SECONDS,
  overallPercent,
  parseFfprobeJson,
  parseProgressLine,
  sequenceDurationSeconds,
  type PlannedClip,
  type RenderStep,
  type StageSpan
} from './renderPlan'

/**
 * Rendered MP4 export: resolves the timeline (same shared selection logic as
 * the preview and the FCPXML export), probes every clip, then either
 * stream-copy concatenates homogeneous clips or normalizes each one first,
 * and finally muxes the audio lane (Suno nodes) over the result.
 *
 * Deliberately outside the unit-test scope (like runEngine): every decision
 * lives in renderPlan.ts (unit-tested); this file owns processes and files,
 * covered by the mocked E2E harness.
 */

export class RenderCancelledError extends Error {
  constructor() {
    super('Render cancelled')
    this.name = 'RenderCancelledError'
  }
}

interface ActiveRender {
  proc: ChildProcess | null
  cancelled: boolean
}

const activeRenders = new Map<string, ActiveRender>()

/** Kills the in-flight ffmpeg process (if any) and marks the render cancelled. */
export function cancelRender(videoId: string): boolean {
  const active = activeRenders.get(videoId)
  if (!active) return false
  active.cancelled = true
  active.proc?.kill('SIGKILL')
  return true
}

export function isRendering(videoId: string): boolean {
  return activeRenders.has(videoId)
}

/**
 * Default destination for headless callers (MCP) that have no save dialog:
 * Downloads/<video name>.mp4, suffixed instead of overwriting an existing file.
 */
export function defaultOutputPath(videoId: string): string {
  const name = videosService.getVideo(videoId)?.name ?? 'video'
  const base = name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'video'
  const dir = app.getPath('downloads')
  let candidate = join(dir, `${base}.mp4`)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}.mp4`)
  return candidate
}

function run(
  active: ActiveRender,
  bin: string,
  args: string[],
  onStdoutLine?: (line: string) => void
): Promise<string> {
  if (active.cancelled) return Promise.reject(new RenderCancelledError())
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    active.proc = proc
    let stdout = ''
    let stderrTail = ''
    let lineBuffer = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      if (!onStdoutLine) return
      lineBuffer += text
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) onStdoutLine(line)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      active.proc = null
      if (active.cancelled) return reject(new RenderCancelledError())
      if (code !== 0) {
        const lastLines = stderrTail.trim().split('\n').slice(-4).join('\n')
        return reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`))
      }
      resolve(stdout)
    })
  })
}

async function probeFile(active: ActiveRender, path: string) {
  const out = await run(active, ffprobePath(), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    path
  ])
  return parseFfprobeJson(JSON.parse(out))
}

/** Downloads a remote result that was never cached locally into the work dir. */
async function downloadTo(workDir: string, name: string, url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`)
  const ext = extname(new URL(url).pathname) || '.mp4'
  const target = join(workDir, `${name}${ext}`)
  writeFileSync(target, new Uint8Array(await res.arrayBuffer()))
  return target
}

/** Local path of a node's best output (generation rows carry absolute paths). */
async function resolveNodeMedia(
  workDir: string,
  node: GraphNode,
  name: string
): Promise<string | null> {
  const rows = listGenerationsForNode(node.id)
  const best = bestGeneration(
    node,
    rows.map((r) => ({ id: r.id, status: r.status, url: r.resultPath ?? r.resultUrl, row: r }))
  )
  if (!best || best.row.status !== 'success') return null
  if (best.row.resultPath) return best.row.resultPath
  if (best.row.resultUrl) return downloadTo(workDir, name, best.row.resultUrl)
  return null
}

export interface RenderResult {
  durationSeconds: number
  skipped: string[]
}

export interface RenderOptions {
  videoId: string
  outputPath: string
  fps?: number
  resolution?: { width: number; height: number }
}

const label = (node: GraphNode) => node.label ?? node.key

export async function renderVideo(options: RenderOptions): Promise<RenderResult> {
  const { videoId, outputPath } = options
  if (activeRenders.has(videoId)) throw new Error('A render is already in progress for this video')
  const video = videosService.getVideo(videoId)
  if (!video) throw new Error('Video not found')

  const active: ActiveRender = { proc: null, cancelled: false }
  activeRenders.set(videoId, active)
  const workDir = mkdtempSync(join(tmpdir(), 'raccord-render-'))

  const progress = (spans: StageSpan[], step: RenderStep, fraction: number) =>
    broadcastRenderProgress({ videoId, percent: overallPercent(spans, step, fraction), step })

  try {
    const graph = graphService.listGraph(videoId)
    const timelineNodes = collectTimelineClips(graph.nodes)
    if (timelineNodes.length === 0) throw new Error('The timeline has no video clip to render')

    // Still fallbacks — same policy as the FCPXML export: a failed shot is
    // replaced by its input image for the clip's declared duration.
    const fallbacks = timelineFallbackImages(videoId, graph)

    const skipped: string[] = []
    const clips: PlannedClip[] = []
    const clipNodes: GraphNode[] = []
    let index = 0
    for (const node of timelineNodes) {
      index += 1
      const name = `src-${String(index).padStart(2, '0')}`
      const videoPath = await resolveNodeMedia(workDir, node, name)
      if (videoPath) {
        clips.push({ path: videoPath, isStill: false, stillDurationSeconds: 0, probe: null })
        clipNodes.push(node)
        continue
      }
      const fallbackUrl = fallbacks[node.id]
      if (fallbackUrl) {
        const local = resolveMediaUrlToFile(fallbackUrl)
        try {
          const stillPath = local?.path ?? (await downloadTo(workDir, `${name}-still`, fallbackUrl))
          clips.push({
            path: stillPath,
            isStill: true,
            stillDurationSeconds: clipDuration(node) ?? DEFAULT_STILL_SECONDS,
            probe: null
          })
          clipNodes.push(node)
          continue
        } catch {
          // Unfetchable still → skip the slot like any other missing media.
        }
      }
      skipped.push(label(node))
    }
    if (clips.length === 0) throw new Error('No timeline clip has a usable output to render')

    // Audio lane (Suno nodes), in timeline order. Nodes without output are
    // reported as skipped rather than silently dropped.
    const musicPaths: string[] = []
    for (const [i, node] of collectAudioNodes(graph.nodes).entries()) {
      const path = await resolveNodeMedia(workDir, node, `music-${i + 1}`)
      if (path) musicPaths.push(path)
      else skipped.push(label(node))
    }

    // ── Probe ────────────────────────────────────────────────────────────
    const probeSpansGuess = computeStageSpans(true, musicPaths.length > 0)
    progress(probeSpansGuess, 'probe', 0)
    for (const [i, clip] of clips.entries()) {
      if (!clip.isStill) clip.probe = await probeFile(active, clip.path)
      progress(probeSpansGuess, 'probe', (i + 1) / clips.length)
    }

    const spec = decideSequenceSpec(clips, {
      fps: options.fps,
      resolution: options.resolution
    })
    // spec already reflects the overrides, so this stays correct with them.
    const lossless = canConcatLosslessly(clips, spec)
    const totalDuration = sequenceDurationSeconds(clips)
    const spans = computeStageSpans(!lossless, musicPaths.length > 0)

    // ── Normalize (heterogeneous clips only) ─────────────────────────────
    let segmentPaths: string[]
    if (lossless) {
      segmentPaths = clips.map((c) => c.path)
    } else {
      segmentPaths = []
      let doneDuration = 0
      for (const [i, clip] of clips.entries()) {
        const clipDur = clip.isStill
          ? clip.stillDurationSeconds
          : (clip.probe?.durationSeconds ?? 0)
        const segment = join(workDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`)
        const base = doneDuration
        await run(
          active,
          ffmpegPath(),
          [...buildNormalizeArgs(clip, spec, segment), '-progress', 'pipe:1'],
          (line) => {
            const seconds = parseProgressLine(line)
            if (seconds !== null && totalDuration > 0) {
              progress(spans, 'normalize', (base + Math.min(seconds, clipDur)) / totalDuration)
            }
          }
        )
        doneDuration += clipDur
        segmentPaths.push(segment)
        progress(spans, 'normalize', totalDuration > 0 ? doneDuration / totalDuration : 1)
      }
    }

    // ── Concat ───────────────────────────────────────────────────────────
    const listPath = join(workDir, 'concat.txt')
    writeFileSync(listPath, buildConcatListContent(segmentPaths), 'utf8')
    const concatOut = join(workDir, 'concat.mp4')
    await run(
      active,
      ffmpegPath(),
      [...buildConcatArgs(listPath, concatOut), '-progress', 'pipe:1'],
      (line) => {
        const seconds = parseProgressLine(line)
        if (seconds !== null && totalDuration > 0) {
          progress(spans, 'concat', seconds / totalDuration)
        }
      }
    )
    progress(spans, 'concat', 1)

    // ── Mux the music lane ───────────────────────────────────────────────
    let finalPath = concatOut
    if (musicPaths.length > 0) {
      const concatProbe = await probeFile(active, concatOut)
      const muxOut = join(workDir, 'final.mp4')
      const muxDuration = concatProbe.durationSeconds ?? totalDuration
      await run(
        active,
        ffmpegPath(),
        [
          ...buildMuxArgs(concatOut, musicPaths, concatProbe.hasAudio, muxDuration, muxOut),
          '-progress',
          'pipe:1'
        ],
        (line) => {
          const seconds = parseProgressLine(line)
          if (seconds !== null && muxDuration > 0) progress(spans, 'mux', seconds / muxDuration)
        }
      )
      finalPath = muxOut
    }

    if (active.cancelled) throw new RenderCancelledError()
    copyFileSync(finalPath, outputPath)
    broadcastRenderProgress({ videoId, percent: 100, step: 'mux', done: true })
    return { durationSeconds: totalDuration, skipped }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcastRenderProgress({ videoId, percent: 0, step: 'probe', done: true, error: message })
    throw err
  } finally {
    activeRenders.delete(videoId)
    rmSync(workDir, { recursive: true, force: true })
  }
}
