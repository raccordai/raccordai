import type { GraphNode } from './ipc/contracts'
import { getModel } from './models'
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

/**
 * The ordered list of clips that make up the timeline: every video-kind node
 * (asset nodes excluded), ordered by shot number.
 *
 * Replacement workflow: when a shot fails, the user renames another node to
 * take over its number — leaving two nodes with the same shot number. Only one
 * gets the slot: the node with a usable output wins (`selectedGenerationId` is
 * only set once a generation succeeded or the user picked one), then the most
 * recently updated. Unnumbered clips are all kept.
 */
export function collectTimelineClips(nodes: GraphNode[]): GraphNode[] {
  const videos = nodes.filter((n) => {
    if (n.modelId === 'studio/asset') return false
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

/**
 * The audio lane: every audio-kind node (Suno music), in timeline order. The
 * MP4 render muxes their outputs over the concatenated video track.
 */
export function collectAudioNodes(nodes: GraphNode[]): GraphNode[] {
  return timelineOrder(
    nodes.filter((n) => n.modelId !== 'studio/asset' && getModel(n.modelId)?.kind === 'audio')
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
 * The clip's trim window inside its media, clamped so bad data can never
 * produce a negative or inverted range: in-point ≥ 0, out-point > in-point and
 * (when the raw duration is known) ≤ raw. All three consumers derive playback
 * and export bounds from this — never read trimStartSec/trimEndSec directly.
 */
export function clipTrim(
  node: GraphNode,
  rawDurationSec?: number
): { start: number; end: number | undefined } {
  const raw = rawDurationSec ?? clipDuration(node)
  const start = Math.max(0, node.trimStartSec ?? 0)
  let end = node.trimEndSec ?? raw
  if (end !== undefined && raw !== undefined) end = Math.min(end, raw)
  if (end !== undefined && end <= start) return { start: 0, end: raw }
  return { start, end }
}

/** The clip's effective duration once trimmed (undefined when unknowable). */
export function trimmedClipDuration(node: GraphNode, rawDurationSec?: number): number | undefined {
  const { start, end } = clipTrim(node, rawDurationSec)
  return end === undefined ? undefined : end - start
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

export function clipResolution(node: GraphNode): string | undefined {
  const params = node.params as { resolution?: unknown; aspect_ratio?: unknown } | undefined
  const r = params?.resolution
  const a = params?.aspect_ratio
  if (typeof r === 'string' && typeof a === 'string') return `${r} · ${a}`
  if (typeof r === 'string') return r
  if (typeof a === 'string') return a
  return undefined
}
