import { describe, expect, it } from 'vitest'
import {
  buildScreenMotionFilter,
  createMoveThrottle,
  cursorKeyframes,
  cursorOverlayFilter,
  demoCameraEnabled,
  normalizeOnDisplay,
  planZoomSegments,
  sampleCamera,
  sampleCursor,
  smoothstep,
  zoompanFilter,
  type DemoEvent
} from './screenMotion'

const click = (t: number, x = 0.5, y = 0.5): DemoEvent => ({ t, type: 'click', x, y })

describe('demoCameraEnabled', () => {
  const events = [click(1)]

  it('is on by default when the asset carries a journal', () => {
    expect(demoCameraEnabled({ assetId: 'a1' }, events)).toBe(true)
    expect(demoCameraEnabled(undefined, events)).toBe(true)
    expect(demoCameraEnabled({ demoCamera: true }, events)).toBe(true)
  })

  it('is off without a journal, and on explicit opt-out', () => {
    expect(demoCameraEnabled({ assetId: 'a1' }, null)).toBe(false)
    expect(demoCameraEnabled({ assetId: 'a1' }, [])).toBe(false)
    expect(demoCameraEnabled({ demoCamera: false }, events)).toBe(false)
  })
})

describe('smoothstep', () => {
  it('eases with flat tangents and clamps outside 0-1', () => {
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(0.5)).toBe(0.5)
    expect(smoothstep(0.25)).toBeCloseTo(0.15625)
    expect(smoothstep(-3)).toBe(0)
    expect(smoothstep(7)).toBe(1)
  })
})

describe('planZoomSegments', () => {
  it('returns nothing without positioned clicks or with zoom ≤ 1', () => {
    expect(planZoomSegments([], 20)).toEqual([])
    expect(planZoomSegments([{ t: 3, type: 'key' }], 20)).toEqual([])
    expect(planZoomSegments([click(3)], 20, { zoom: 1 })).toEqual([])
  })

  it('wraps a single click in the lead/hold/release envelope', () => {
    const [seg] = planZoomSegments([click(5, 0.3, 0.7)], 20)
    expect(seg).toMatchObject({ leadSec: 0.6, releaseSec: 0.8, zoom: 1.8 })
    expect(seg!.startSec).toBeCloseTo(4.4)
    expect(seg!.endSec).toBeCloseTo(6.9)
    expect(seg!.targets).toEqual([{ t: 5, x: 0.3, y: 0.7 }])
  })

  it('merges a burst of clicks into one panning segment, splits distant ones', () => {
    const segments = planZoomSegments([click(5, 0.2, 0.2), click(7, 0.8, 0.8), click(15)], 30)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.targets).toHaveLength(2)
    expect(segments[0]!.endSec).toBeCloseTo(8.9)
    expect(segments[1]!.targets).toEqual([{ t: 15, x: 0.5, y: 0.5 }])
  })

  it('merges groups whose envelopes touch after expansion', () => {
    // Gap 3 s > mergeWindow 2.5 splits the groups, but with a 2 s hold the
    // first envelope ends at 7.8 and the second starts at 7.4 — they touch.
    const segments = planZoomSegments([click(5), click(8)], 30, { holdSec: 2 })
    expect(segments).toHaveLength(1)
    expect(segments[0]!.targets).toHaveLength(2)
  })

  it('clamps to the capture bounds and shrinks ramps on short segments', () => {
    const [seg] = planZoomSegments([click(0.3)], 1)
    expect(seg!.startSec).toBe(0)
    expect(seg!.endSec).toBe(1)
    expect(seg!.leadSec).toBeCloseTo(0.5)
    expect(seg!.releaseSec).toBeCloseTo(0.5)
  })
})

describe('sampleCamera', () => {
  const segments = planZoomSegments([click(5, 0.9, 0.5)], 20, { zoom: 2 })

  it('rests at identity outside every segment', () => {
    expect(sampleCamera(segments, 0)).toEqual({ zoom: 1, cx: 0.5, cy: 0.5 })
    expect(sampleCamera(segments, 19)).toEqual({ zoom: 1, cx: 0.5, cy: 0.5 })
  })

  it('eases the zoom in, holds it, and clamps the center inside the frame', () => {
    // Mid-lead: smoothstep(0.5) = 0.5 → zoom halfway.
    expect(sampleCamera(segments, 4.4 + 0.3).zoom).toBeCloseTo(1.5)
    const held = sampleCamera(segments, 5.5)
    expect(held.zoom).toBe(2)
    // Target x 0.9 clamped to 1 - 0.5/2 = 0.75 so the crop stays in frame.
    expect(held.cx).toBeCloseTo(0.75)
    expect(held.cy).toBeCloseTo(0.5)
  })

  it('pans between two targets with easing', () => {
    const pan = planZoomSegments([click(5, 0.3, 0.3), click(7, 0.7, 0.7)], 20, { zoom: 2 })
    const mid = sampleCamera(pan, 6)
    expect(mid.cx).toBeCloseTo(0.5)
    expect(mid.cy).toBeCloseTo(0.5)
    expect(sampleCamera(pan, 5).cx).toBeCloseTo(0.3)
    expect(sampleCamera(pan, 7.2).cx).toBeCloseTo(0.7)
  })
})

describe('cursor', () => {
  const events: DemoEvent[] = [click(2, 0.1, 0.1), { t: 3, type: 'key' }, click(6, 0.9, 0.9)]

  it('keyframes keep only positioned events, in order', () => {
    expect(cursorKeyframes(events)).toEqual([
      { t: 2, x: 0.1, y: 0.1 },
      { t: 6, x: 0.9, y: 0.9 }
    ])
  })

  it('glides between keyframes and holds at the ends', () => {
    const keys = cursorKeyframes(events)
    expect(sampleCursor(keys, 0)).toEqual({ t: 2, x: 0.1, y: 0.1 })
    expect(sampleCursor(keys, 4)?.x).toBeCloseTo(0.5)
    expect(sampleCursor(keys, 10)).toEqual({ t: 6, x: 0.9, y: 0.9 })
    expect(sampleCursor([], 1)).toBeNull()
  })

  it('builds a centered overlay expression, or nothing without positions', () => {
    const overlay = cursorOverlayFilter(cursorKeyframes(events))
    expect(overlay).toContain('overlay=x=')
    expect(overlay).toContain('-overlay_w/2')
    expect(overlay).toContain('main_h*(')
    expect(cursorOverlayFilter([])).toBeNull()
  })
})

describe('normalizeOnDisplay', () => {
  const main = { x: 0, y: 0, width: 1512, height: 982 }
  const secondary = { x: 1512, y: -200, width: 2560, height: 1440 }

  it('maps a global point onto the captured display', () => {
    expect(normalizeOnDisplay(756, 491, main)).toEqual({ x: 0.5, y: 0.5 })
    // Secondary displays have non-zero origins (negative y included).
    expect(normalizeOnDisplay(1512 + 640, -200 + 360, secondary)).toEqual({ x: 0.25, y: 0.25 })
  })

  it('rejects points outside the display (clicks on another monitor)', () => {
    expect(normalizeOnDisplay(-1, 100, main)).toBeNull()
    expect(normalizeOnDisplay(2000, 100, main)).toBeNull()
    expect(normalizeOnDisplay(100, 100, secondary)).toBeNull()
    expect(normalizeOnDisplay(1, 1, { x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })
})

describe('createMoveThrottle (shared with main)', () => {
  it('offset-invariant: epoch-based provisional times throttle the same', () => {
    const throttle = createMoveThrottle(0.08)
    const epoch = 1_700_000_000
    const at = (t: number) => ({ t: epoch + t, type: 'move' as const, x: 0.5, y: 0.5 })
    expect(throttle(at(0))).not.toBeNull()
    expect(throttle(at(0.05))).toBeNull()
    expect(throttle(at(0.1))).not.toBeNull()
  })
})

describe('filter builders', () => {
  const opts = { width: 1280, height: 720, fps: 30 }

  it('zoompan mirrors the segments and keeps the frame count (d=1)', () => {
    const segments = planZoomSegments([click(5)], 20)
    const filter = zoompanFilter(segments, opts)
    expect(filter).toContain("zoompan=z='if(between(it,4.4000,6.9000)")
    expect(filter).toContain('d=1:s=1280x720:fps=30')
    // The crop window is clamped exactly like sampleCamera.
    expect(filter).toContain('clip(iw*(')
    expect(filter).toContain('iw-iw/zoom')
  })

  it('assembles the full chain, cursor first so it rides the zoom', () => {
    const withCursor = buildScreenMotionFilter([click(5)], 20, opts)
    expect(withCursor.usesCursor).toBe(true)
    expect(withCursor.filter).toMatch(/^\[0:v\]\[1:v\]overlay=/)
    expect(withCursor.filter).toContain('[comp];[comp]zoompan=')
    expect(withCursor.filter.endsWith('[out]')).toBe(true)

    const bare = buildScreenMotionFilter([{ t: 1, type: 'key' }], 20, opts)
    expect(bare.usesCursor).toBe(false)
    expect(bare.filter).toMatch(/^\[0:v\]zoompan=/)
  })

  it('cursor: false skips the synthetic cursor even with positioned events', () => {
    const screenTake = buildScreenMotionFilter([click(5)], 20, { ...opts, cursor: false })
    expect(screenTake.usesCursor).toBe(false)
    expect(screenTake.filter).toMatch(/^\[0:v\]zoompan=/)
    expect(screenTake.filter).not.toContain('overlay')
  })
})
