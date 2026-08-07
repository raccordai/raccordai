import { describe, expect, it } from 'vitest'
import { snapSpan, snapTime, snapTolerance } from './timelineSnap'

describe('timeline snapping', () => {
  it('derives the tolerance from the track scale (8 px worth of seconds)', () => {
    // 60 s over 600 px → 0.1 s/px → 8 px = 0.8 s.
    expect(snapTolerance(60, 600)).toBeCloseTo(0.8)
    expect(snapTolerance(0, 600)).toBe(0)
    expect(snapTolerance(60, 0)).toBe(0)
  })

  it('snaps to the nearest target inside the tolerance only', () => {
    expect(snapTime(9.7, [0, 10, 20], 0.5)).toBe(10)
    expect(snapTime(9.4, [0, 10, 20], 0.5)).toBe(9.4)
    // Nearest wins when two targets compete.
    expect(snapTime(10.4, [10, 10.5], 0.5)).toBe(10.5)
  })

  it('snapSpan sticks by whichever edge lands closer, never below 0', () => {
    // Start near 5: snap the start.
    expect(snapSpan(4.8, 3, [5], 0.5)).toBe(5)
    // End near 10: snap the end (start = 10 - 3).
    expect(snapSpan(6.8, 3, [10], 0.5)).toBeCloseTo(7)
    // Both in range: the closer edge wins (end is closer here).
    expect(snapSpan(4.7, 5.2, [5, 10], 0.5)).toBeCloseTo(4.8)
    expect(snapSpan(0.2, 10, [0], 0.5)).toBe(0)
  })
})
