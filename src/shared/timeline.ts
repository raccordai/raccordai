import type { GraphNode, TimelineSegment } from './ipc/contracts'
import { SPEED_MAX, SPEED_MIN, VOLUME_MAX, VOLUME_MIN } from './config'
import { isClipLookId } from './looks'
import { getModel } from './models'
import { isStillMotionId } from './stillMotion'
import { clampTransitionSeconds, isClipTransitionId } from './transitions'

/**
 * Timeline sequence resolution — the single source of truth for "what clips
 * make up the video, in what order, playing which generation". Shared by the
 * renderer preview (TimelineV2), the FCPXML export and the MP4 render so the
 * three can never disagree on what the sequence is.
 */

/**
 * Extracts the shot number from a node's title — the first number found in the
 * label (e.g. "Clip — Shot 28" → 28, "03 - finale" → 3), falling back to the
 * node key. Undefined when neither contains a number.
 */
export function shotNumber(node: GraphNode): number | undefined {
  for (const s of [node.label, node.key]) {
    if (typeof s === 'string') {
      const m = s.match(/\d+/)
      if (m) return parseInt(m[0], 10)
    }
  }
  return undefined
}

/**
 * Timeline display order. An explicit `timelineOrder` (the user dragged a clip,
 * or an agent called set_timeline_order) wins outright — reordered clips come
 * first, by their slot. Everything else keeps the historical rule: the shot
 * number in the node's title (01, 02, 03…), because when a shot fails and the
 * user renames another node to take its place, the timeline follows the
 * rename. Numbered nodes come before unnumbered ones (sorted numerically, so
 * 2 < 12); the final fallback is canvas position (Y, then X).
 *
 * We deliberately don't use topological order here: parallel chains (e.g. four
 * independent shots with no cross-edges) all sit at the same dependency depth
 * and would be returned in whatever order Kahn's queue popped them.
 *
 * Execution order is still topological — see `topologicalOrder` in WorkflowEditor.tsx
 * which is what `Run all` relies on.
 */
export function timelineOrder(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => {
    const oa = a.timelineOrder ?? null
    const ob = b.timelineOrder ?? null
    if (oa !== null && ob !== null && oa !== ob) return oa - ob
    if ((oa !== null) !== (ob !== null)) return oa !== null ? -1 : 1
    const na = shotNumber(a)
    const nb = shotNumber(b)
    if (na !== undefined && nb !== undefined && na !== nb) return na - nb
    if ((na !== undefined) !== (nb !== undefined)) return na !== undefined ? -1 : 1
    return a.position.y - b.position.y || a.position.x - b.position.x
  })
}

/** Default hold time of a still clip (image placed on the timeline). */
export const DEFAULT_STILL_SECONDS = 5

/** Fallback length of a clip whose media and params give no duration. */
export const DEFAULT_CLIP_SECONDS = 5

/**
 * True when the node's timeline slot holds a STILL: an image-kind node, or a
 * `studio/asset` node (uploaded media held as a picture). Stills only enter
 * the timeline through an explicit `timelineOrder` (see collectTimelineClips)
 * and their duration is their trim window (see stillClipSeconds).
 */
export function isStillClip(node: GraphNode): boolean {
  if (node.modelId === 'studio/asset') return true
  return getModel(node.modelId)?.kind === 'image'
}

/**
 * Hold time of a still on the timeline. A still has no media duration, so its
 * trim window IS its length (resize handles write trimEndSec); without one it
 * holds for the default.
 */
export function stillClipSeconds(node: GraphNode): number {
  const start = Math.max(0, node.trimStartSec ?? 0)
  const end = node.trimEndSec
  if (typeof end === 'number' && end > start) return end - start
  return DEFAULT_STILL_SECONDS
}

/**
 * The ordered list of clips that make up the timeline: every video-kind node
 * (asset nodes excluded), ordered by shot number — plus the stills the user
 * explicitly placed (image/asset nodes carrying a `timelineOrder`; opt-in, so
 * the graph's working images never leak into the edit).
 *
 * Replacement workflow: when a shot fails, the user renames another node to
 * take over its number — leaving two nodes with the same shot number. Only one
 * gets the slot: the node with a usable output wins (`selectedGenerationId` is
 * only set once a generation succeeded or the user picked one), then the most
 * recently updated. Unnumbered clips are all kept.
 */
export function collectTimelineClips(nodes: GraphNode[]): GraphNode[] {
  const videos = nodes.filter((n) => {
    if (isStillClip(n)) return typeof n.timelineOrder === 'number'
    return getModel(n.modelId)?.kind === 'video'
  })

  const score = (n: GraphNode) => (n.selectedGenerationId ? 1 : 0)
  const byNumber = new Map<number, GraphNode>()
  const keptAsIs: GraphNode[] = []
  for (const n of videos) {
    const num = shotNumber(n)
    // Explicitly ordered clips are all kept: the user placed them, so the
    // same-number replacement rule (which drops a node) must not apply.
    if (num === undefined || typeof n.timelineOrder === 'number') {
      keptAsIs.push(n)
      continue
    }
    const current = byNumber.get(num)
    if (
      !current ||
      score(n) - score(current) > 0 ||
      (score(n) === score(current) && n.updatedAt > current.updatedAt)
    ) {
      byNumber.set(num, n)
    }
  }
  return timelineOrder([...byNumber.values(), ...keptAsIs])
}

/** Which final-mix lane an audio node belongs to (model-declared, music default). */
export function audioRoleOf(node: GraphNode): 'music' | 'speech' {
  return getModel(node.modelId)?.audioRole ?? 'music'
}

/**
 * The audio lanes, in timeline order. `music` (Suno) concatenates as the music
 * bed; `speech` (ElevenLabs voice-over/dialogue) is its own lane, mixed OVER
 * the bed at render time. Omit `role` for the historical "every audio node"
 * list (used where the lanes behave identically, e.g. duration probing).
 */
export function collectAudioNodes(nodes: GraphNode[], role?: 'music' | 'speech'): GraphNode[] {
  return timelineOrder(
    nodes.filter(
      (n) =>
        n.modelId !== 'studio/asset' &&
        getModel(n.modelId)?.kind === 'audio' &&
        (role === undefined || audioRoleOf(n) === role)
    )
  )
}

/**
 * The generation a timeline slot should display/export: the node's selected
 * generation when it's a playable success, otherwise the most recent successful
 * one (covers selections pointing at a failed retry or a stale id). `gens` must
 * be newest-first — the order `generations.listForNode` returns.
 */
export function bestGeneration<T extends { id: string; status: string; url?: string | null }>(
  node: GraphNode,
  gens: T[] | undefined
): T | undefined {
  if (!gens) return undefined
  const selected = node.selectedGenerationId
    ? gens.find((g) => g.id === node.selectedGenerationId)
    : undefined
  if (selected?.status === 'success' && selected.url) return selected
  return gens.find((g) => g.status === 'success' && !!g.url) ?? selected
}

/** Best-effort duration extraction from a video node's params (Seedance & Grok both use `duration` seconds). */
export function clipDuration(node: GraphNode): number | undefined {
  const d = (node.params as { duration?: unknown } | undefined)?.duration
  return typeof d === 'number' ? d : undefined
}

/**
 * A segment's trim window inside its media, clamped so bad data can never
 * produce a negative or inverted range: in-point ≥ 0, out-point > in-point and
 * (when the raw duration is known) ≤ raw. All three consumers derive playback
 * and export bounds from this — never read the raw trim values directly.
 */
export function segmentTrim(
  segment: TimelineSegment,
  rawDurationSec?: number
): { start: number; end: number | undefined } {
  const raw = rawDurationSec
  const start = Math.max(0, segment.trimStartSec ?? 0)
  let end = segment.trimEndSec ?? raw
  if (end !== undefined && raw !== undefined) end = Math.min(end, raw)
  if (end !== undefined && end <= start) return { start: 0, end: raw }
  return { start, end }
}

/** The clip's trim window (single-clip view — the implicit segment). */
export function clipTrim(
  node: GraphNode,
  rawDurationSec?: number
): { start: number; end: number | undefined } {
  return segmentTrim(
    { trimStartSec: node.trimStartSec, trimEndSec: node.trimEndSec },
    rawDurationSec ?? clipDuration(node)
  )
}

// ── Split clips (§6.12e) — segments & timeline entries ──────────────────────

/**
 * The node's timeline segments, normalized: the materialized `segments` array
 * when the clip was split, else ONE implicit segment read from the historical
 * trim/transition columns. Every consumer resolves through this — reading the
 * columns directly on a split clip would replay the pre-split window.
 */
export function clipSegments(node: GraphNode): TimelineSegment[] {
  const segs = node.segments
  if (Array.isArray(segs) && segs.length > 0) return segs
  return [
    {
      trimStartSec: node.trimStartSec ?? null,
      trimEndSec: node.trimEndSec ?? null,
      transitionAfter: node.transitionAfter ?? null,
      transitionDurationSec: node.transitionDurationSec ?? null
    }
  ]
}

/** One playable timeline slot: a node + one of its segments. */
export interface TimelineEntry {
  node: GraphNode
  segment: TimelineSegment
  /** Index into clipSegments(node) — the mutation surface's addressing. */
  segmentIndex: number
  /** Stable identity for lists/players ("nodeId#segmentIndex"). */
  entryId: string
}

/**
 * The ordered timeline as ENTRIES: collectTimelineClips' node order, each node
 * expanded into its segments (adjacent — a split never reorders). With no
 * split anywhere this is exactly one entry per clip.
 */
export function collectTimelineEntries(nodes: GraphNode[]): TimelineEntry[] {
  return collectTimelineClips(nodes).flatMap((node) =>
    clipSegments(node).map((segment, segmentIndex) => ({
      node,
      segment,
      segmentIndex,
      entryId: `${node.id}#${segmentIndex}`
    }))
  )
}

/** Transition of a SEGMENT into the next entry (a CLIP_TRANSITIONS id) or null. */
export function segmentTransitionAfter(segment: TimelineSegment): string | null {
  return isClipTransitionId(segment.transitionAfter) ? segment.transitionAfter : null
}

/** The segment transition's length in seconds (clamped; default when unset). */
export function segmentTransitionSeconds(segment: TimelineSegment): number {
  return clampTransitionSeconds(segment.transitionDurationSec ?? undefined)
}

/** The clip's effective duration once trimmed (undefined when unknowable). */
export function trimmedClipDuration(node: GraphNode, rawDurationSec?: number): number | undefined {
  const { start, end } = clipTrim(node, rawDurationSec)
  return end === undefined ? undefined : end - start
}

/**
 * The track's volume gain, clamped (null/undefined = 1, untouched). Applied to
 * the audio lanes by the MP4 render (ffmpeg `volume=`) and by the preview
 * player (capped at 1 there — an HTMLMediaElement cannot amplify).
 */
export function clipVolume(node: GraphNode): number {
  const v = node.volume
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, v))
}

/**
 * The clip's playback speed, clamped (null/undefined = 1). The rendered slot
 * lasts `trimmed duration / speed`; preview parity via `playbackRate`.
 */
export function clipSpeed(node: GraphNode): number {
  const s = node.speed
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 1
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, s))
}

/** The clip's colour look (a CLIP_LOOKS id) or null (untouched). */
export function clipLook(node: GraphNode): string | null {
  return isClipLookId(node.look) ? node.look : null
}

/** The still slot's Ken Burns preset (a STILL_MOTIONS id) or null (frozen frame). */
export function stillMotionOf(node: GraphNode): string | null {
  return isStillMotionId(node.stillMotion) ? node.stillMotion : null
}

/**
 * Absolute start of an AUDIO track on the final timeline, or null (the
 * historical layout: chained after the previous lane track).
 */
export function clipTimelineOffset(node: GraphNode): number | null {
  const v = node.timelineOffsetSec
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v
}

/**
 * Start seconds of each lane track on the final timeline — THE lane layout,
 * shared by the preview player and the MP4 render. A track with an explicit
 * offset sits there; a track without chains after the previous track's end.
 * With no offsets anywhere this is the historical pure concatenation from 0.
 */
export function audioLaneStarts(
  tracks: Array<{ offsetSec: number | null; durationSeconds: number }>
): number[] {
  const starts: number[] = []
  let cursor = 0
  for (const t of tracks) {
    const start = t.offsetSec ?? cursor
    starts.push(start)
    cursor = start + Math.max(0, t.durationSeconds)
  }
  return starts
}

/** Transition into the NEXT clip (a CLIP_TRANSITIONS id) or null (plain cut). */
export function clipTransitionAfter(node: GraphNode): string | null {
  return isClipTransitionId(node.transitionAfter) ? node.transitionAfter : null
}

/** The transition's length in seconds (clamped; default when unset). */
export function clipTransitionSeconds(node: GraphNode): number {
  return clampTransitionSeconds(node.transitionDurationSec ?? undefined)
}

/** Default crossfade length — kept for callers that predate per-cut durations. */
export const CROSSFADE_SECONDS = 0.5

/**
 * Sequence duration with transition overlaps subtracted: each transition
 * between clip N and N+1 overlaps them by its own length. The last clip's
 * transition (nothing follows) is ignored.
 */
export function transitionOverlapSeconds(clips: GraphNode[]): number {
  return clips
    .slice(0, -1)
    .reduce((sum, c) => sum + (clipTransitionAfter(c) !== null ? clipTransitionSeconds(c) : 0), 0)
}

// ── Resolved timeline (MCP `get_timeline`) ──────────────────────────────────

/** Where a resolved duration came from — agents weigh 'measured' higher. */
export type DurationSource = 'measured' | 'declared' | 'default'

/** One playable slot with its FINAL-timeline placement fully computed. */
export interface ResolvedTimelineEntry {
  nodeId: string
  nodeKey: string
  label: string | null
  modelId: string
  segmentIndex: number
  still: boolean
  /** FINAL-timeline seconds (transition overlaps already subtracted). */
  startSec: number
  endSec: number
  /** The slot's exclusive length (trimmed, speed-adjusted, minus overlap). */
  durationSec: number
  trimStartSec: number
  trimEndSec: number | null
  speed: number
  transitionAfter: string | null
  transitionSec: number
  durationSource: DurationSource
}

/** One audio-lane track with its computed start (audioLaneStarts layout). */
export interface ResolvedAudioTrack {
  nodeId: string
  nodeKey: string
  label: string | null
  modelId: string
  role: 'music' | 'speech'
  /** FINAL-timeline start: the explicit offset, or chained after the previous track. */
  startSec: number
  endSec: number
  durationSec: number
  /** The stored explicit offset (null = chained) — what set_audio_offset wrote. */
  offsetSec: number | null
  volume: number
  trimStartSec: number
  trimEndSec: number | null
  durationSource: DurationSource
}

export interface ResolvedTimeline {
  entries: ResolvedTimelineEntry[]
  /** The film's length — equals the render's renderedDurationSeconds. */
  totalSeconds: number
  music: ResolvedAudioTrack[]
  speech: ResolvedAudioTrack[]
}

/** Raw media length + provenance for one node (measured beats declared). */
function rawDurationOf(
  node: GraphNode,
  mediaDurations: Record<string, number>
): { raw: number; source: DurationSource } {
  const measured = mediaDurations[node.id]
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
    return { raw: measured, source: 'measured' }
  }
  const declared = clipDuration(node)
  if (declared !== undefined) return { raw: declared, source: 'declared' }
  return { raw: DEFAULT_CLIP_SECONDS, source: 'default' }
}

/**
 * The whole timeline resolved to FINAL-timeline seconds — the same math as the
 * preview player and the MP4 render (trim windows, speed division, transition
 * overlaps, audioLaneStarts), packaged for agents: `get_timeline` is how an
 * agent knows where shot N starts before calling set_audio_offset to sync a
 * voice-over. `mediaDurations` maps nodeId → measured media seconds (ffprobe
 * in main, HTMLMediaElement in the renderer); nodes absent from it fall back
 * to their declared params duration.
 */
export function resolveTimeline(
  nodes: GraphNode[],
  mediaDurations: Record<string, number> = {}
): ResolvedTimeline {
  const entries: ResolvedTimelineEntry[] = []
  const timelineEntries = collectTimelineEntries(nodes)
  let cursor = 0
  timelineEntries.forEach((entry, i) => {
    const still = isStillClip(entry.node)
    const { raw, source } = rawDurationOf(entry.node, mediaDurations)
    const trim = segmentTrim(entry.segment, still ? undefined : raw)
    const speed = clipSpeed(entry.node)
    // A still's declared length IS its trim window (stillClipSeconds).
    const effective = still
      ? stillClipSeconds(entry.node)
      : Math.max(0, (trim.end ?? raw) - trim.start) / speed
    const isLast = i === timelineEntries.length - 1
    const transitionAfter = isLast ? null : segmentTransitionAfter(entry.segment)
    const transitionSec = transitionAfter !== null ? segmentTransitionSeconds(entry.segment) : 0
    const slot = Math.max(0, effective - transitionSec)
    entries.push({
      nodeId: entry.node.id,
      nodeKey: entry.node.key,
      label: entry.node.label,
      modelId: entry.node.modelId,
      segmentIndex: entry.segmentIndex,
      still,
      startSec: cursor,
      endSec: cursor + slot,
      durationSec: slot,
      trimStartSec: trim.start,
      trimEndSec: trim.end ?? null,
      speed,
      transitionAfter,
      transitionSec,
      durationSource: still ? 'declared' : source
    })
    cursor += slot
  })

  const lane = (role: 'music' | 'speech'): ResolvedAudioTrack[] => {
    const tracks = collectAudioNodes(nodes, role)
    const durations = tracks.map((node) => {
      const { raw, source } = rawDurationOf(node, mediaDurations)
      const trim = clipTrim(node, raw)
      return { duration: Math.max(0, (trim.end ?? raw) - trim.start), trim, source }
    })
    const starts = audioLaneStarts(
      tracks.map((node, i) => ({
        offsetSec: clipTimelineOffset(node),
        durationSeconds: durations[i]!.duration
      }))
    )
    return tracks.map((node, i) => ({
      nodeId: node.id,
      nodeKey: node.key,
      label: node.label,
      modelId: node.modelId,
      role,
      startSec: starts[i]!,
      endSec: starts[i]! + durations[i]!.duration,
      durationSec: durations[i]!.duration,
      offsetSec: clipTimelineOffset(node),
      volume: clipVolume(node),
      trimStartSec: durations[i]!.trim.start,
      trimEndSec: durations[i]!.trim.end ?? null,
      durationSource: durations[i]!.source
    }))
  }

  return { entries, totalSeconds: cursor, music: lane('music'), speech: lane('speech') }
}

export function clipResolution(node: GraphNode): string | undefined {
  const params = node.params as { resolution?: unknown; aspect_ratio?: unknown } | undefined
  const r = params?.resolution
  const a = params?.aspect_ratio
  if (typeof r === 'string' && typeof a === 'string') return `${r} · ${a}`
  if (typeof r === 'string') return r
  if (typeof a === 'string') return a
  return undefined
}

/**
 * Locates the timeline entry under a FINAL-timeline timecode and maps it back
 * to MEDIA time (trim window + speed applied) — what a frame grab must seek.
 * The film's exact end resolves to the last entry's final frame; outside the
 * film → null. Media time is clamped inside the entry's trim window.
 */
export function entryAtTimecode(
  entries: ResolvedTimelineEntry[],
  atSec: number
): { entry: ResolvedTimelineEntry; mediaSec: number } | null {
  if (atSec < 0) return null
  const last = entries.at(-1)
  const entry =
    entries.find((e) => atSec >= e.startSec && atSec < e.endSec) ??
    (last && atSec <= last.endSec + 1e-6 ? last : null)
  if (!entry) return null
  const along = Math.max(0, Math.min(atSec, entry.endSec) - entry.startSec)
  const mediaSec = entry.still ? 0 : entry.trimStartSec + along * entry.speed
  const mediaEnd = entry.trimEndSec ?? Number.POSITIVE_INFINITY
  return { entry, mediaSec: Math.min(mediaSec, Math.max(entry.trimStartSec, mediaEnd - 0.05)) }
}
