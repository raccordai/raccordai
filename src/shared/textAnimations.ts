/**
 * Text-layer animation presets — standalone module (no imports), same doctrine
 * as transitions.ts. The ASS override assembly lives in renderPlan.ts
 * (buildAssContent): `fade` = \fad in/out, `pop` = scale-in + fade, `slide-up`
 * = \move from below + fade. All ride the existing libass pass — no new
 * ffmpeg stage.
 */

export interface TextAnimationDef {
  id: string
}

export const TEXT_ANIMATIONS: readonly TextAnimationDef[] = [
  { id: 'fade' },
  { id: 'pop' },
  { id: 'slide-up' }
] as const

export const TEXT_ANIMATION_IDS = TEXT_ANIMATIONS.map((a) => a.id) as [string, ...string[]]

export function isTextAnimationId(id: unknown): id is string {
  return typeof id === 'string' && TEXT_ANIMATIONS.some((a) => a.id === id)
}
