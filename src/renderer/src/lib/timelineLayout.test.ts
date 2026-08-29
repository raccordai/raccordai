import { describe, expect, it } from 'vitest'
import {
  ALIGN_GRID,
  anchorTransform,
  clamp,
  overlayPlacement,
  popoverLeft,
  reorderTimelineIds,
  rulerTicks,
  stillHoldAt,
  trimInAt,
  trimOutAt
} from './timelineLayout'

describe('clamp', () => {
  it('bounds a value on both sides', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('popoverLeft', () => {
  it('keeps a centred popover fully on screen', () => {
    // width 288 → half footprint 152 (144 + 8px margin).
    expect(popoverLeft(500, 288, 1000)).toBe(500)
    expect(popoverLeft(10, 288, 1000)).toBe(152)
    expect(popoverLeft(995, 288, 1000)).toBe(848)
  })

  it('degrades gracefully on a window narrower than the popover', () => {
    expect(popoverLeft(50, 288, 100)).toBe(152)
  })
})

describe('anchorTransform / overlayPlacement', () => {
  it('maps the 9 ASS numpad anchors onto their translate pair', () => {
    expect(anchorTransform(1)).toBe('translate(0%, -100%)') // bottom-left
    expect(anchorTransform(5)).toBe('translate(-50%, -50%)') // centre
    expect(anchorTransform(9)).toBe('translate(-100%, 0%)') // top-right
  })

  it('places the overlay preview like the ASS alignment', () => {
    expect(overlayPlacement(2)).toEqual({
      alignItems: 'flex-end',
      justifyContent: 'center',
      textAlign: 'center'
    })
    expect(overlayPlacement(7)).toEqual({
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      textAlign: 'left'
    })
    expect(overlayPlacement(6)).toEqual({
      alignItems: 'center',
      justifyContent: 'flex-end',
      textAlign: 'right'
    })
  })

  it('grid rows render top-to-bottom while ASS numbers grow bottom-up', () => {
    expect(ALIGN_GRID[0]).toEqual([7, 8, 9])
    expect(ALIGN_GRID[2]).toEqual([1, 2, 3])
  })
})

describe('rulerTicks', () => {
  it('keeps roughly 8 ticks whatever the total', () => {
    expect(rulerTicks(10)).toEqual([0, 2, 4, 6, 8])
    expect(rulerTicks(60)).toEqual([0, 10, 20, 30, 40, 50])
    expect(rulerTicks(3600).length).toBeLessThanOrEqual(9)
  })

  it('falls back to 10-minute ticks on absurd totals', () => {
    expect(rulerTicks(6000)[1]).toBe(600)
  })
})

describe('reorderTimelineIds', () => {
  it('moves a clip after the target when dragged forward', () => {
    expect(reorderTimelineIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })

  it('moves a clip before the target when dragged backward', () => {
    expect(reorderTimelineIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('returns null on a no-op drop', () => {
    expect(reorderTimelineIds(['a', 'b'], 'a', 'a')).toBeNull()
    expect(reorderTimelineIds(['a', 'b'], 'ghost', 'a')).toBeNull()
  })
})

describe('trim drag math', () => {
  const base = { origStart: 1, origEnd: 5, speed: 1, minSeconds: 0.2 }

  it('scales timeline deltas into media time by the clip speed', () => {
    expect(trimInAt(1, { ...base, speed: 2 })).toBe(3)
    expect(trimOutAt(-1, { ...base, raw: 6, speed: 2 })).toBe(3)
  })

  it('never lets the window collapse below the minimum', () => {
    expect(trimInAt(100, base)).toBe(4.8)
    expect(trimOutAt(-100, { ...base, raw: 6 })).toBe(1.2)
  })

  it('never leaves the media bounds', () => {
    expect(trimInAt(-100, base)).toBe(0)
    expect(trimOutAt(100, { ...base, raw: 6 })).toBe(6)
  })
})

describe('stillHoldAt', () => {
  const bounds = { min: 0.5, max: 120 }

  it('grows with a right-grip drag to the right', () => {
    expect(stillHoldAt(2, 'right', 5, bounds)).toBe(7)
  })

  it('grows with a left-grip drag to the left (sign flip)', () => {
    expect(stillHoldAt(-2, 'left', 5, bounds)).toBe(7)
  })

  it('clamps to the hold bounds', () => {
    expect(stillHoldAt(-100, 'right', 5, bounds)).toBe(0.5)
    expect(stillHoldAt(1000, 'right', 5, bounds)).toBe(120)
  })
})
