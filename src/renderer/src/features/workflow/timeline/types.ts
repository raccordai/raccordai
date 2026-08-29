import type { GraphNode, TimelineSegment } from '@shared/ipc/contracts'

/**
 * Shared vocabulary of the timeline modules (engine, track, popovers) —
 * extracted from the historical single-file TimelineV2.
 */

export interface EngineClip {
  node: GraphNode
  /** The entry's SEGMENT (§6.12e): its own trim + transition. */
  segment: TimelineSegment
  segmentIndex: number
  /** Stable identity ("nodeId#segmentIndex") for lists and live-resize state. */
  entryId: string
  url: string | null
  /** Declared duration (params), replaced by real media duration once probed. */
  declared: number
  /** Still image slot (image/asset node): no media clock, held for `declared`. */
  still?: boolean
  /** Animatic slot: an ungenerated VIDEO clip playing its INPUT image as a
   *  still. Playback-only — editing gestures keep treating the node as video. */
  placeholder?: boolean
}

/** Shortest length a resize handle can leave (clip trim window, text layer). */
export const MIN_RESIZE_SECONDS = 0.2
/** Bounds of a still's hold time when resized by its handles. */
export const MIN_STILL_SECONDS = 0.5
export const MAX_STILL_SECONDS = 120
