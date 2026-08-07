/**
 * Per-clip colour looks — standalone module (no imports), same doctrine as
 * transitions.ts: one curated list read by contracts, the clip inspector, the
 * MCP registry and the render plan.
 *
 * Each look declares BOTH sides of the preview contract: the ffmpeg filter
 * fragment baked into the normalize pass, and the CSS `filter` approximation
 * the timeline player shows live. Only core ffmpeg filters (eq, hue,
 * colorbalance, curves) — no external LUT files, so every platform build of
 * ffmpeg-static renders them.
 */

export interface ClipLookDef {
  id: string
  /** ffmpeg filter fragment, chained into the per-clip normalize filter. */
  ffmpeg: string
  /** CSS `filter` value approximating the look in the preview player. */
  css: string
}

export const CLIP_LOOKS: readonly ClipLookDef[] = [
  { id: 'warm', ffmpeg: 'colorbalance=rs=.08:ms=.04:bs=-.06', css: 'sepia(0.18) saturate(1.12)' },
  {
    id: 'cool',
    ffmpeg: 'colorbalance=rs=-.05:ms=-.02:bs=.08',
    css: 'hue-rotate(-8deg) saturate(1.05)'
  },
  {
    id: 'faded',
    ffmpeg: 'eq=contrast=0.9:saturation=0.82:brightness=0.03',
    css: 'contrast(0.9) saturate(0.82) brightness(1.06)'
  },
  { id: 'vivid', ffmpeg: 'eq=contrast=1.08:saturation=1.35', css: 'contrast(1.08) saturate(1.35)' },
  { id: 'mono', ffmpeg: 'hue=s=0', css: 'grayscale(1)' },
  {
    id: 'noir',
    ffmpeg: 'hue=s=0,eq=contrast=1.25:brightness=-0.03',
    css: 'grayscale(1) contrast(1.25) brightness(0.95)'
  },
  { id: 'vintage', ffmpeg: 'curves=preset=vintage', css: 'sepia(0.35) contrast(0.95)' }
] as const

export const CLIP_LOOK_IDS = CLIP_LOOKS.map((l) => l.id) as [string, ...string[]]

export function isClipLookId(id: unknown): id is string {
  return typeof id === 'string' && CLIP_LOOKS.some((l) => l.id === id)
}

/** The ffmpeg fragment for a look id (null for unknown/none — no filter). */
export function lookFfmpegFilter(id: string | null | undefined): string | null {
  if (!id) return null
  return CLIP_LOOKS.find((l) => l.id === id)?.ffmpeg ?? null
}

/** The CSS approximation for the preview player ('none' when no look). */
export function lookCssFilter(id: string | null | undefined): string {
  if (!id) return 'none'
  return CLIP_LOOKS.find((l) => l.id === id)?.css ?? 'none'
}
