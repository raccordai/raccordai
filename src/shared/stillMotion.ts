/**
 * Ken Burns presets for STILL timeline slots — standalone module (no imports),
 * same doctrine as transitions.ts. A still with a motion preset is rendered
 * through ffmpeg's `zoompan` instead of a frozen frame; the exact filter is
 * assembled in renderPlan.ts (it needs the sequence spec and the hold time).
 */

export interface StillMotionDef {
  id: string
}

export const STILL_MOTIONS: readonly StillMotionDef[] = [
  { id: 'zoom-in' },
  { id: 'zoom-out' },
  { id: 'pan-left' },
  { id: 'pan-right' }
] as const

export const STILL_MOTION_IDS = STILL_MOTIONS.map((m) => m.id) as [string, ...string[]]

export function isStillMotionId(id: unknown): id is string {
  return typeof id === 'string' && STILL_MOTIONS.some((m) => m.id === id)
}
