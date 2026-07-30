/**
 * The curated transition library — standalone module (no imports) because BOTH
 * `timeline.ts` and `ipc/contracts.ts` need it and timeline already depends on
 * the contracts (a registry living in either would cycle).
 *
 * Each entry maps a stable Raccord id to the ffmpeg `xfade` transition that
 * implements it. Audio always crossfades (`acrossfade`) whatever the visual
 * is — an audible hard cut under a visual wipe reads as a glitch.
 */

export interface ClipTransitionDef {
  id: string
  /** ffmpeg xfade `transition=` value. */
  xfade: string
}

export const CLIP_TRANSITIONS: readonly ClipTransitionDef[] = [
  // 'crossfade' predates the library and keeps its historical id.
  { id: 'crossfade', xfade: 'fade' },
  { id: 'fadeblack', xfade: 'fadeblack' },
  { id: 'fadewhite', xfade: 'fadewhite' },
  { id: 'wipeleft', xfade: 'wipeleft' },
  { id: 'wiperight', xfade: 'wiperight' },
  { id: 'slideleft', xfade: 'slideleft' },
  { id: 'slideright', xfade: 'slideright' },
  { id: 'circleopen', xfade: 'circleopen' },
  { id: 'dissolve', xfade: 'dissolve' },
  { id: 'pixelize', xfade: 'pixelize' }
] as const

export const CLIP_TRANSITION_IDS = CLIP_TRANSITIONS.map((t) => t.id) as [string, ...string[]]

export function isClipTransitionId(id: unknown): id is string {
  return typeof id === 'string' && CLIP_TRANSITIONS.some((t) => t.id === id)
}

/** The xfade name for a transition id (unknown ids fall back to a plain fade). */
export function xfadeNameFor(id: string): string {
  return CLIP_TRANSITIONS.find((t) => t.id === id)?.xfade ?? 'fade'
}

/** Transition length bounds (seconds) — shared by zod, the UI and the clamp. */
export const TRANSITION_MIN_SECONDS = 0.1
export const TRANSITION_MAX_SECONDS = 2
export const TRANSITION_DEFAULT_SECONDS = 0.5

export function clampTransitionSeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : TRANSITION_DEFAULT_SECONDS
  return Math.min(TRANSITION_MAX_SECONDS, Math.max(TRANSITION_MIN_SECONDS, n))
}
