/**
 * Magnetic snapping for timeline drags (pure, tested): a dragged block sticks
 * to clip boundaries / the playhead when it lands within a pixel-derived
 * tolerance, and moves freely otherwise.
 */

/** The tolerance in SECONDS worth `px` pixels at the current track scale. */
export function snapTolerance(totalSeconds: number, trackWidthPx: number, px = 8): number {
  if (trackWidthPx <= 0 || totalSeconds <= 0) return 0
  return (totalSeconds / trackWidthPx) * px
}

/** The nearest target within tolerance, or the value untouched. */
export function snapTime(value: number, targets: number[], tolerance: number): number {
  let best = value
  let bestDist = tolerance
  for (const t of targets) {
    const d = Math.abs(t - value)
    if (d < bestDist) {
      bestDist = d
      best = t
    }
  }
  return best
}

/**
 * Snap a SPAN by whichever edge lands closer to a target: dragging a block
 * should stick when its START or its END meets a boundary. Returns the
 * snapped start (never negative).
 */
export function snapSpan(
  start: number,
  durationSeconds: number,
  targets: number[],
  tolerance: number
): number {
  const end = start + durationSeconds
  const byStart = snapTime(start, targets, tolerance)
  const byEnd = snapTime(end, targets, tolerance)
  // An edge that found no target keeps an infinite distance — otherwise its
  // zero displacement would always beat the edge that actually snapped.
  const startDist = byStart === start ? Number.POSITIVE_INFINITY : Math.abs(byStart - start)
  const endDist = byEnd === end ? Number.POSITIVE_INFINITY : Math.abs(byEnd - end)
  if (startDist === Number.POSITIVE_INFINITY && endDist === Number.POSITIVE_INFINITY) {
    return Math.max(0, start)
  }
  if (endDist < startDist) return Math.max(0, byEnd - durationSeconds)
  return Math.max(0, byStart)
}
