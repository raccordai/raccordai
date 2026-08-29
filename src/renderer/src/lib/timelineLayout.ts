/**
 * Pure layout & gesture math of the timeline (TimelineV2 and its popovers).
 * Extracted so the coordinate conversions and drag clamps — the code that
 * silently corrupts an edit when it drifts — are unit-tested instead of
 * living inline in a 3000-line component.
 */

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Clamp a centred popover's `left` so the island stays fully on screen: the
 * anchors are clip centres, so on the timeline's last clips half the popover
 * would overflow the window edge. Works on centres because every popover
 * carries `-translate-x-1/2`.
 */
export function popoverLeft(anchorX: number, widthPx: number, windowWidth: number): number {
  const half = widthPx / 2 + 8
  return Math.min(Math.max(anchorX, half), Math.max(half, windowWidth - half))
}

/** CSS transform that puts a layer's ANCHOR point on its (x, y) position. */
export function anchorTransform(anchor: number): string {
  const col = (anchor - 1) % 3
  const tx = col === 0 ? '0%' : col === 1 ? '-50%' : '-100%'
  const ty = anchor >= 7 ? '0%' : anchor >= 4 ? '-50%' : '-100%'
  return `translate(${tx}, ${ty})`
}

/** ASS numpad alignment laid out as the 3×3 position grid the picker shows. */
export const ALIGN_GRID = [
  [7, 8, 9],
  [4, 5, 6],
  [1, 2, 3]
] as const

/** Flexbox placement of the player's overlay preview for an ASS alignment. */
export function overlayPlacement(align: number): {
  alignItems: 'flex-start' | 'center' | 'flex-end'
  justifyContent: 'flex-start' | 'center' | 'flex-end'
  textAlign: 'left' | 'center' | 'right'
} {
  const col = ((align - 1) % 3) as 0 | 1 | 2
  const row = align >= 7 ? 'flex-start' : align >= 4 ? 'center' : 'flex-end'
  const x = (['flex-start', 'center', 'flex-end'] as const)[col]
  return {
    alignItems: row,
    justifyContent: x,
    textAlign: (['left', 'center', 'right'] as const)[col]
  }
}

/** Sensible ruler tick spacing: ~8 ticks over the whole edit. */
export function rulerTicks(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => total / s <= 8) ?? 600
  const ticks: number[] = []
  for (let t = 0; t < total; t += step) ticks.push(t)
  return ticks
}

/**
 * Drop-to-reorder: `orderedIds` is the CURRENT node order (deduplicated —
 * reordering stays node-grained, dragging any segment of a split clip moves
 * the whole clip); the dragged node lands beside the drop target, shifted one
 * slot when it comes from before it. Returns null on a no-op drop (same node,
 * or an id the order doesn't contain).
 */
export function reorderTimelineIds(
  orderedIds: string[],
  fromId: string,
  toId: string
): string[] | null {
  if (fromId === toId) return null
  const fromIdx = orderedIds.indexOf(fromId)
  const toIdx = orderedIds.indexOf(toId)
  if (fromIdx === -1 || toIdx === -1) return null
  const ids = orderedIds.filter((id) => id !== fromId)
  const insertAt = ids.indexOf(toId) + (fromIdx < toIdx ? 1 : 0)
  ids.splice(insertAt, 0, fromId)
  return ids
}

/**
 * Edge-grip trim math. Drag deltas arrive in TIMELINE seconds while the trim
 * window is MEDIA time — the delta scales by the clip's baked speed before it
 * moves an edge, and each edge is clamped so the window keeps `minSeconds` of
 * media and never leaves [0, raw].
 */
export function trimInAt(
  deltaSec: number,
  args: { origStart: number; origEnd: number; speed: number; minSeconds: number }
): number {
  return clamp(args.origStart + deltaSec * args.speed, 0, args.origEnd - args.minSeconds)
}

export function trimOutAt(
  deltaSec: number,
  args: { origStart: number; origEnd: number; raw: number; speed: number; minSeconds: number }
): number {
  return clamp(args.origEnd + deltaSec * args.speed, args.origStart + args.minSeconds, args.raw)
}

/**
 * A still has no media: either grip just changes its hold time. The LEFT grip
 * grows the hold when dragged left (the block's start moves earlier), hence
 * the sign flip.
 */
export function stillHoldAt(
  deltaSec: number,
  side: 'left' | 'right',
  origSeconds: number,
  bounds: { min: number; max: number }
): number {
  const next = side === 'right' ? origSeconds + deltaSec : origSeconds - deltaSec
  return clamp(next, bounds.min, bounds.max)
}
