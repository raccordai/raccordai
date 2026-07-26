/**
 * Regional feedback (§6.3) — the pure half: turning the user's marks on an
 * output into a prompt an image/video model can act on. The gesture is
 * Cursor's select + Cmd+K transposed to a frame: circle what is wrong, say why
 * in one sentence, and get a pre-wired edit node (or an assistant request).
 *
 * The wording matters more than it looks: models follow spatial instructions
 * far better in plain language ("in the upper-left area") than in coordinates,
 * so regions are described, not dumped as numbers.
 */

/** Normalized rectangle over the frame — every value in [0, 1]. */
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface Annotation {
  id: string
  /** Region on the frame; null for a note about the whole image or a timecode. */
  region: Region | null
  /** Seconds into the clip (video notes); null on images. */
  timecodeSec: number | null
  comment: string
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** Normalizes a drawn rectangle (any drag direction) into a [0,1] region. */
export function normalizeRegion(raw: Region): Region {
  const x1 = clamp01(Math.min(raw.x, raw.x + raw.w))
  const y1 = clamp01(Math.min(raw.y, raw.y + raw.h))
  const x2 = clamp01(Math.max(raw.x, raw.x + raw.w))
  const y2 = clamp01(Math.max(raw.y, raw.y + raw.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** True when the drag was so small it is a mis-click rather than a selection. */
export function isDegenerateRegion(region: Region): boolean {
  return region.w < 0.02 || region.h < 0.02
}

const COLUMNS = ['left', 'center', 'right'] as const
const ROWS = ['upper', 'middle', 'lower'] as const

/** Third of the frame a coordinate falls into (0, 1 or 2). */
function third(value: number): 0 | 1 | 2 {
  return value < 1 / 3 ? 0 : value < 2 / 3 ? 1 : 2
}

/**
 * Plain-language placement of a region: "the upper-left area", "the center",
 * "the lower third", or "the whole frame" when the box covers nearly all of it.
 */
export function describeRegion(region: Region): string {
  const { x, y, w, h } = normalizeRegion(region)
  if (w >= 0.9 && h >= 0.9) return 'the whole frame'
  const cx = x + w / 2
  const cy = y + h / 2
  const spansWidth = w >= 0.75
  const spansHeight = h >= 0.75
  const row = ROWS[third(cy)] as string
  const column = COLUMNS[third(cx)] as string
  if (spansWidth) return `the ${row} third of the frame`
  if (spansHeight) return `the ${column === 'center' ? 'central' : column} side of the frame`
  if (row === 'middle' && column === 'center') return 'the center of the frame'
  if (row === 'middle') return `the ${column} of the frame`
  if (column === 'center') return `the ${row} center of the frame`
  return `the ${row}-${column} area of the frame`
}

/** `93` → "1:33" — the timecode the user actually saw under the player. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** One annotation rendered as an instruction line. */
export function describeAnnotation(annotation: Annotation): string {
  const comment = annotation.comment.trim()
  if (annotation.region) return `In ${describeRegion(annotation.region)}: ${comment}`
  if (annotation.timecodeSec !== null) {
    return `At ${formatTimecode(annotation.timecodeSec)}: ${comment}`
  }
  return comment
}

/**
 * The edit prompt built from the notes on one output. Images get an explicit
 * "change only this" clause — the whole point of a regional edit is that the
 * rest of the frame survives. Video notes feed a regeneration prompt instead
 * (no model edits a clip in place), so they stay descriptive.
 */
export function buildEditPrompt(annotations: Annotation[], kind: 'image' | 'video'): string {
  const lines = annotations
    .map(describeAnnotation)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return ''
  const body = lines.length === 1 ? (lines[0] as string) : lines.map((l) => `- ${l}`).join('\n')
  return kind === 'image'
    ? `${body}\nApply these corrections and change nothing else: keep the same framing, composition, colors and style as the source image.`
    : `Regenerate this shot with the following corrections:\n${body}`
}

/** Draft handed to the assistant when the user asks it to fix the output. */
export function buildAssistantRequest(
  nodeLabel: string,
  annotations: Annotation[],
  kind: 'image' | 'video'
): string {
  const lines = annotations.map(describeAnnotation).filter((l) => l.trim().length > 0)
  return [
    `On the "${nodeLabel}" ${kind === 'image' ? 'image' : 'shot'}, I noted:`,
    ...lines.map((l) => `- ${l}`),
    'Propose a fix (edit node or a new prompt) and tell me what it will cost before running anything.'
  ].join('\n')
}
