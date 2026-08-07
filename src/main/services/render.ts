import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { app } from 'electron'
import { ffmpegPath, ffprobePath } from '../media/ffbin'
import type { GraphNode } from '@shared/ipc/contracts'
import {
  audioLaneStarts,
  bestGeneration,
  clipDuration,
  clipLook,
  clipSpeed,
  clipTimelineOffset,
  clipTransitionAfter,
  clipTransitionSeconds,
  clipTrim,
  clipVolume,
  collectAudioNodes,
  collectTimelineClips,
  isStillClip,
  stillClipSeconds,
  stillMotionOf
} from '@shared/timeline'
import { xfadeNameFor } from '@shared/transitions'
import type { SpeechTranscript } from '@shared/speech'
import { broadcastRenderProgress } from '../events'
import { resolveMediaUrlToFile } from '../media/protocol'
import {
  listGenerationsForNode,
  resolveSelectedOutputUrl,
  timelineFallbackImages,
  type GenerationRow
} from './generations'
import { listTextLayers } from './textLayers'
import { listImageLayers } from './imageLayers'
import { getAsset } from './assets'
import * as graphService from './graph'
import * as videosService from './videos'
import {
  buildAssContent,
  buildCaptionEvents,
  buildConcatArgs,
  buildConcatListContent,
  buildCrossfadeArgs,
  buildMuxArgs,
  buildNormalizeArgs,
  buildOverlayArgs,
  buildSubtitleBurnArgs,
  canConcatLosslessly,
  clipEffectiveDuration,
  computeStageSpans,
  encodeArgsFor,
  crossfadeGroups,
  CROSSFADE_DURATION,
  decideSequenceSpec,
  DEFAULT_STILL_SECONDS,
  extractDialogue,
  hasCrossfades,
  overallPercent,
  parseFfprobeJson,
  parseProgressLine,
  renderedDurationSeconds,
  sequenceDurationSeconds,
  speechActivityWindows,
  type CaptionTrackInput,
  type MusicTrack,
  type PlannedOverlay,
  type PlannedClip,
  type RenderStep,
  type StageSpan,
  type AssEvent
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
): Promise<{ path: string; row: GenerationRow } | null> {
  const rows = listGenerationsForNode(node.id)
  const best = bestGeneration(
    node,
    rows.map((r) => ({ id: r.id, status: r.status, url: r.resultPath ?? r.resultUrl, row: r }))
  )
  if (!best || best.row.status !== 'success') return null
  if (best.row.resultPath) return { path: best.row.resultPath, row: best.row }
  if (best.row.resultUrl) {
    return { path: await downloadTo(workDir, name, best.row.resultUrl), row: best.row }
  }
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
  /** Burn the scenario's quoted dialogue as subtitles (nothing without quotes). */
  burnSubtitles?: boolean
  /** Dynamic captions from the speech lane's transcripts (a CAPTION_PRESETS id). */
  captionsPreset?: string
  /** Duck the music bed under the voice-over (transcript-timed windows). */
  duckMusic?: boolean
  /** Encoder quality ('standard' default = the historical args). */
  quality?: string
  /** Output codec ('h264' default; 'hevc' forces the normalize path). */
  codec?: string
  /** Translucent corner text over the whole film (per-render, never persisted). */
  watermark?: {
    text: string
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  }
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
      // User-placed still (image node or asset): held for its trim-window length.
      if (isStillClip(node)) {
        const url = resolveSelectedOutputUrl(node, 'output')
        try {
          const local = url ? resolveMediaUrlToFile(url) : null
          const stillPath =
            local?.path ?? (url ? await downloadTo(workDir, `${name}-still`, url) : null)
          if (stillPath) {
            clips.push({
              path: stillPath,
              isStill: true,
              stillDurationSeconds: stillClipSeconds(node),
              probe: null
            })
            clipNodes.push(node)
            continue
          }
        } catch {
          // Unfetchable still → skip the slot like any other missing media.
        }
        skipped.push(label(node))
        continue
      }
      const media = await resolveNodeMedia(workDir, node, name)
      if (media) {
        clips.push({ path: media.path, isStill: false, stillDurationSeconds: 0, probe: null })
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

    // Audio lanes (music = Suno bed, speech = ElevenLabs voice-over), each in
    // timeline order, each carrying its journaled trim window (the preview
    // honours the same bounds). Nodes without output are reported as skipped
    // rather than silently dropped.
    interface LaneEntry {
      track: MusicTrack
      transcript: SpeechTranscript | null
      /** Explicit absolute start (clipTimelineOffset), null = chain. */
      offsetSec: number | null
    }
    const collectLane = async (role: 'music' | 'speech'): Promise<LaneEntry[]> => {
      const lane: LaneEntry[] = []
      for (const [i, node] of collectAudioNodes(graph.nodes, role).entries()) {
        const media = await resolveNodeMedia(workDir, node, `${role}-${i + 1}`)
        if (media) {
          // Infinity = media length unknown here (audio is never probed): an
          // untrimmed track must NOT inherit the node's declared duration as an
          // out-point — only an explicit trim survives the Infinity fallback.
          const { start, end } = clipTrim(node, Number.POSITIVE_INFINITY)
          const volume = clipVolume(node)
          lane.push({
            transcript: (media.row.transcript ?? null) as SpeechTranscript | null,
            offsetSec: clipTimelineOffset(node),
            track: {
              path: media.path,
              ...(start > 0 ? { trimStartSec: start } : {}),
              ...(end !== undefined && Number.isFinite(end) ? { trimEndSec: end } : {}),
              ...(volume !== 1 ? { volume } : {})
            }
          })
        } else skipped.push(label(node))
      }
      return lane
    }
    // Free audio placement: a lane where any track carries an explicit offset
    // switches to absolute starts (shared audioLaneStarts — the same layout the
    // preview shows). That needs measured durations, so the lane gets probed;
    // an offset-less lane keeps the historical probe-free concatenation.
    const layoutLane = async (lane: LaneEntry[]): Promise<void> => {
      if (!lane.some((t) => t.offsetSec !== null)) return
      const durations: number[] = []
      for (const t of lane) {
        const probe = await probeFile(active, t.track.path)
        const trimStart = t.track.trimStartSec ?? 0
        const mediaEnd =
          t.track.trimEndSec !== undefined
            ? Math.min(t.track.trimEndSec, probe.durationSeconds ?? t.track.trimEndSec)
            : (probe.durationSeconds ?? trimStart)
        durations.push(Math.max(0, mediaEnd - trimStart))
      }
      const starts = audioLaneStarts(
        lane.map((t, i) => ({ offsetSec: t.offsetSec, durationSeconds: durations[i]! }))
      )
      lane.forEach((t, i) => {
        t.track.startSec = starts[i]!
      })
    }
    const musicLane = await collectLane('music')
    const speechLane = await collectLane('speech')
    await layoutLane(musicLane)
    await layoutLane(speechLane)
    const musicTracks = musicLane.map((t) => t.track)
    const speechTracks = speechLane.map((t) => t.track)
    const hasAudioLane = musicTracks.length > 0 || speechTracks.length > 0

    // ── Probe ────────────────────────────────────────────────────────────
    const probeSpansGuess = computeStageSpans(true, hasAudioLane)
    progress(probeSpansGuess, 'probe', 0)
    for (const [i, clip] of clips.entries()) {
      if (!clip.isStill) clip.probe = await probeFile(active, clip.path)
      progress(probeSpansGuess, 'probe', (i + 1) / clips.length)
    }

    // Timeline editing state: trim windows (clamped against the probed
    // duration), transitions, speed, look and still motion travel from the
    // nodes onto the planned clips. Effects are only stamped when set, so an
    // untouched timeline keeps the historical argv byte-identical.
    for (const [i, clip] of clips.entries()) {
      const node = clipNodes[i]!
      if (!clip.isStill) {
        const { start, end } = clipTrim(node, clip.probe?.durationSeconds ?? undefined)
        if (start > 0) clip.trimStartSec = start
        if (end !== undefined) clip.trimEndSec = end
        const speed = clipSpeed(node)
        if (speed !== 1) clip.speed = speed
      } else {
        const motion = stillMotionOf(node)
        if (motion) clip.stillMotion = motion
      }
      const look = clipLook(node)
      if (look) clip.look = look
      clip.transitionAfter = clipTransitionAfter(node)
      clip.transitionDurationSec = clipTransitionSeconds(node)
    }

    // The scenario's dialogue, resolved per clip BEFORE rendering: subtitles
    // only exist where a shot wrote quoted lines.
    const scenarioShots = new Map(
      (video.scenario?.shots ?? []).map((s) => [s.key, `${s.action} ${s.sound ?? ''}`])
    )
    const wantSubtitles = options.burnSubtitles === true
    const wantCaptions = options.captionsPreset !== undefined
    const wantDucking =
      options.duckMusic === true && musicTracks.length > 0 && speechTracks.length > 0

    // Captions & ducking both need the speech lane resolved on the FINAL
    // timeline: each track's measured length (audio is otherwise never probed)
    // places the next one, and its transcript carries the spoken windows.
    const captionTracks: CaptionTrackInput[] = []
    if (wantCaptions || wantDucking) {
      let at = 0
      for (const { track, transcript } of speechLane) {
        const probe = await probeFile(active, track.path)
        const trimStart = track.trimStartSec ?? 0
        const mediaEnd =
          track.trimEndSec !== undefined
            ? Math.min(track.trimEndSec, probe.durationSeconds ?? track.trimEndSec)
            : (probe.durationSeconds ?? undefined)
        // An offset-positioned lane already computed each track's start.
        const start = track.startSec ?? at
        captionTracks.push({
          startSec: start,
          ...(track.trimStartSec !== undefined ? { trimStartSec: track.trimStartSec } : {}),
          ...(track.trimEndSec !== undefined ? { trimEndSec: track.trimEndSec } : {}),
          ...(probe.durationSeconds != null ? { durationSeconds: probe.durationSeconds } : {}),
          segments: transcript?.segments ?? []
        })
        at = start + Math.max(0, (mediaEnd ?? trimStart) - trimStart)
      }
    }

    const spec = decideSequenceSpec(clips, {
      fps: options.fps,
      resolution: options.resolution
    })
    // spec already reflects the overrides, so this stays correct with them.
    // An explicit hevc request forces the normalize path (copy can't transcode);
    // a quality choice alone keeps lossless — stream copy beats any re-encode.
    const lossless = canConcatLosslessly(clips, spec) && options.codec !== 'hevc'
    const encodeArgs = encodeArgsFor(options.quality, options.codec)
    const totalDuration = sequenceDurationSeconds(clips)
    const finalDuration = renderedDurationSeconds(clips)

    // Burned text layers, timed on the FINAL timeline (overlaps subtracted):
    // scenario dialogue (opt-in), per-clip title layers, watermark.
    const assEvents: AssEvent[] = []
    {
      let at = 0
      for (const [i, clip] of clips.entries()) {
        const node = clipNodes[i]!
        const dur = clipEffectiveDuration(clip)
        if (dur > 0) {
          if (wantSubtitles) {
            const lines = extractDialogue(scenarioShots.get(node.key) ?? '')
            if (lines.length > 0) {
              assEvents.push({
                kind: 'subtitle',
                startSec: at,
                endSec: Math.min(at + dur, finalDuration),
                text: lines.join('\n')
              })
            }
          }
          if (node.overlay?.text) {
            assEvents.push({
              kind: 'title',
              startSec: at,
              endSec: Math.min(at + dur, finalDuration),
              text: node.overlay.text,
              align: node.overlay.align,
              size: node.overlay.size
            })
          }
        }
        at += dur - (clip.transitionAfter ? (clip.transitionDurationSec ?? CROSSFADE_DURATION) : 0)
      }
      if (options.watermark?.text) {
        const WATERMARK_ALIGN = {
          'top-left': 7,
          'top-right': 9,
          'bottom-left': 1,
          'bottom-right': 3
        }
        assEvents.push({
          kind: 'watermark',
          startSec: 0,
          endSec: finalDuration,
          text: options.watermark.text,
          align: WATERMARK_ALIGN[options.watermark.position ?? 'bottom-right']
        })
      }
      // Dynamic captions (§8): the speech transcripts' timed segments, burned
      // with the chosen preset — real timings, nothing invented.
      if (wantCaptions && options.captionsPreset) {
        assEvents.push(...buildCaptionEvents(captionTracks, options.captionsPreset, finalDuration))
      }
      // The title track (§6.12b): free layers live in final-timeline seconds
      // already — clamp to the film and drop the ones entirely outside it.
      for (const layer of listTextLayers(videoId)) {
        if (layer.startSec >= finalDuration) continue
        assEvents.push({
          kind: 'layer',
          startSec: layer.startSec,
          endSec: Math.min(layer.endSec, finalDuration),
          text: layer.content,
          align: layer.anchor,
          x: layer.x,
          y: layer.y,
          fontFamily: layer.fontFamily,
          sizePct: layer.sizePct,
          bold: layer.bold,
          italic: layer.italic,
          colorHex: layer.colorHex,
          animation: layer.animation
        })
      }
    }
    // Sticker track (§6.12d): resolve each layer's image — a node's best
    // generation, or a project asset's stored file. Unresolvable stickers are
    // reported in `skipped` like any other missing media.
    const overlays: PlannedOverlay[] = []
    for (const [i, row] of listImageLayers(videoId).entries()) {
      if (row.startSec >= finalDuration) continue
      let path: string | null = null
      let sourceLabel = `Sticker ${i + 1}`
      if (row.nodeId) {
        const node = graph.nodes.find((n) => n.id === row.nodeId)
        if (node) {
          sourceLabel = label(node)
          path = (await resolveNodeMedia(workDir, node, `sticker-${i + 1}`))?.path ?? null
        }
      } else if (row.assetId) {
        const asset = getAsset(row.assetId)
        if (asset) {
          sourceLabel = asset.name
          path = asset.filePath
        }
      }
      if (!path) {
        skipped.push(sourceLabel)
        continue
      }
      overlays.push({
        path,
        startSec: row.startSec,
        endSec: Math.min(row.endSec, finalDuration),
        x: row.x,
        y: row.y,
        widthFraction: row.widthPct / 100
      })
    }

    const hasBurnPass = assEvents.length > 0
    const spans = computeStageSpans(!lossless, hasAudioLane, {
      hasTransitions: hasCrossfades(clips),
      hasSubtitles: hasBurnPass,
      hasOverlays: overlays.length > 0
    })

    // ── Normalize (heterogeneous clips only) ─────────────────────────────
    let segmentPaths: string[]
    if (lossless) {
      segmentPaths = clips.map((c) => c.path)
    } else {
      segmentPaths = []
      let doneDuration = 0
      for (const [i, clip] of clips.entries()) {
        const clipDur = clipEffectiveDuration(clip)
        const segment = join(workDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`)
        const base = doneDuration
        await run(
          active,
          ffmpegPath(),
          [...buildNormalizeArgs(clip, spec, segment, encodeArgs), '-progress', 'pipe:1'],
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

    // ── Transitions (crossfade groups → one merged segment each) ─────────
    if (hasCrossfades(clips)) {
      const groups = crossfadeGroups(clips)
      const merged: string[] = []
      for (const [g, group] of groups.entries()) {
        if (group.length === 1) {
          merged.push(segmentPaths[group[0]!]!)
          continue
        }
        // Measured durations: xfade offsets must match the encoded segments,
        // not the plan (encoder rounding drifts a declared value).
        const segments = [] as Array<{ path: string; durationSeconds: number }>
        for (const idx of group) {
          const path = segmentPaths[idx]!
          const probe = await probeFile(active, path)
          segments.push({
            path,
            durationSeconds: probe.durationSeconds ?? clipEffectiveDuration(clips[idx]!)
          })
        }
        const groupOut = join(workDir, `fade-${String(g + 1).padStart(2, '0')}.mp4`)
        const groupDuration = segments.reduce((acc, s) => acc + s.durationSeconds, 0)
        const fades = group.slice(0, -1).map((idx) => ({
          xfade: xfadeNameFor(clips[idx]!.transitionAfter ?? 'crossfade'),
          durationSec: clips[idx]!.transitionDurationSec ?? CROSSFADE_DURATION
        }))
        await run(
          active,
          ffmpegPath(),
          [...buildCrossfadeArgs(segments, fades, groupOut, encodeArgs), '-progress', 'pipe:1'],
          (line) => {
            const seconds = parseProgressLine(line)
            if (seconds !== null && groupDuration > 0) {
              progress(
                spans,
                'transition',
                (g + Math.min(1, seconds / groupDuration)) / groups.length
              )
            }
          }
        )
        merged.push(groupOut)
      }
      segmentPaths = merged
      progress(spans, 'transition', 1)
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

    // ── Burned text layers (dialogue + titles + watermark, one libass pass) ─
    let stagePath = concatOut
    if (hasBurnPass) {
      const assPath = join(workDir, 'layers.ass')
      writeFileSync(assPath, buildAssContent(spec, assEvents), 'utf8')
      const subbedOut = join(workDir, 'subtitled.mp4')
      await run(
        active,
        ffmpegPath(),
        [
          ...buildSubtitleBurnArgs(stagePath, assPath, subbedOut, encodeArgs),
          '-progress',
          'pipe:1'
        ],
        (line) => {
          const seconds = parseProgressLine(line)
          if (seconds !== null && finalDuration > 0) {
            progress(spans, 'subtitles', seconds / finalDuration)
          }
        }
      )
      stagePath = subbedOut
      progress(spans, 'subtitles', 1)
    }

    // ── Sticker track (image overlays, one compositing pass) ─────────────
    if (overlays.length > 0) {
      const overlayOut = join(workDir, 'stickers.mp4')
      await run(
        active,
        ffmpegPath(),
        [
          ...buildOverlayArgs(stagePath, overlays, spec, overlayOut, encodeArgs),
          '-progress',
          'pipe:1'
        ],
        (line) => {
          const seconds = parseProgressLine(line)
          if (seconds !== null && finalDuration > 0) {
            progress(spans, 'overlay', seconds / finalDuration)
          }
        }
      )
      stagePath = overlayOut
      progress(spans, 'overlay', 1)
    }

    // ── Mux the audio lanes (music bed + speech) ─────────────────────────
    let finalPath = stagePath
    if (hasAudioLane) {
      const concatProbe = await probeFile(active, stagePath)
      const muxOut = join(workDir, 'final.mp4')
      const muxDuration = concatProbe.durationSeconds ?? finalDuration
      const duckWindows = wantDucking ? speechActivityWindows(captionTracks) : []
      await run(
        active,
        ffmpegPath(),
        [
          ...buildMuxArgs(
            stagePath,
            musicTracks,
            speechTracks,
            concatProbe.hasAudio,
            muxDuration,
            muxOut,
            duckWindows.length > 0 ? { duckMusic: { windows: duckWindows } } : undefined
          ),
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
    return { durationSeconds: finalDuration, skipped }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcastRenderProgress({ videoId, percent: 0, step: 'probe', done: true, error: message })
    throw err
  } finally {
    activeRenders.delete(videoId)
    rmSync(workDir, { recursive: true, force: true })
  }
}
