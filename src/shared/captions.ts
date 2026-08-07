/**
 * Dynamic caption presets — standalone module (no imports), same doctrine as
 * transitions.ts: contracts, the export dialog, the MCP registry and the
 * render plan all read this one list.
 *
 * Captions are burned from the SPEECH lane's stored transcripts (ElevenLabs
 * character alignment, §8) — real timings, nothing invented. The preset only
 * decides how a segment appears; the ASS assembly lives in renderPlan.ts.
 */

export interface CaptionPresetDef {
  id: string
}

export const CAPTION_PRESETS: readonly CaptionPresetDef[] = [
  // Plain bold bottom-center line per transcript segment.
  { id: 'classic' },
  // Each segment pops in with a quick scale-up + fade (the short-form staple).
  { id: 'pop' },
  // Word-by-word highlight over the segment (ASS karaoke timing).
  { id: 'karaoke' }
] as const

export const CAPTION_PRESET_IDS = CAPTION_PRESETS.map((p) => p.id) as [string, ...string[]]

export type CaptionPresetId = (typeof CAPTION_PRESETS)[number]['id']

export function isCaptionPresetId(id: unknown): id is string {
  return typeof id === 'string' && CAPTION_PRESETS.some((p) => p.id === id)
}
