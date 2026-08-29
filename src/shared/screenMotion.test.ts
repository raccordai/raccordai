import { describe, expect, it } from 'vitest'
import {
  buildScreenMotionFilter,
  cameraTransform,
  createMoveThrottle,
  cursorKeyframes,
  cursorOverlayFilter,
  demoCameraEnabled,
  bakeTargetSize,
  frameLayout,
  mapEventsToFrame,
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

  it('frame composes the mac-window look and remaps the journal onto the inset', () => {
    const framed = buildScreenMotionFilter([click(5, 1, 1)], 20, { ...opts, frame: {} })
    // Gradient background + shadow + a chromed window, ended by the capture.
    expect(framed.filter).toContain('gradients=s=1280x720:c0=0xb7b6ff:c1=0xff9bc6')
    expect(framed.filter).toContain('boxblur=0:0:0:0:18:2')
    // The composition ends WITH the take: shortest overlays + a hard trim.
    expect(framed.filter).toContain('shortest=1[fr0]')
    expect(framed.filter).toContain('trim=end=20.000,setpts=PTS-STARTPTS[framed]')
    // 1280×0.85 = 1088 even, 720×0.85 = 612 even.
    expect(framed.filter).toContain('[0:v]scale=1088:612[cap]')
    // The fake macOS chrome: title bar canvas + the three traffic lights.
    expect(framed.filter).toContain(`color=c=0x2b2b36:s=1088x`)
    expect(framed.filter).toContain('color=c=0xff5f57')
    expect(framed.filter).toContain('color=c=0xfebc2e')
    expect(framed.filter).toContain('color=c=0x28c840')
    // Rounding via a static mask (perf doctrine), sources bounded by the take.
    expect(framed.filter).toContain('alphamerge')
    expect(framed.filter).toContain(':r=2:d=20.050,')
    // The cursor rides the framed composition, then the camera zooms it all.
    expect(framed.usesCursor).toBe(true)
    expect(framed.filter).toContain('[framed][1:v]overlay')
    expect(framed.filter).toContain('[comp]zoompan=')
    // The capture IS 16:9 → the canvas equals it.
    expect(framed.filter).toContain('s=1280x720:fps=30[out]')
  })

  it('frames a non-16:9 capture on a 16:9 canvas at its true aspect', () => {
    // A 1440×900 window capture (16:10): the old behavior kept that aspect
    // for the whole output — players pillarboxed it on every 16:9 screen.
    const framed = buildScreenMotionFilter([click(5, 1, 1)], 20, {
      ...opts,
      width: 1440,
      height: 900,
      frame: {}
    })
    // Canvas widened to 16:9; window fitted by height, capture undistorted.
    expect(framed.filter).toContain('gradients=s=1600x900:c0=0xb7b6ff')
    expect(framed.filter).toContain('[0:v]scale=1226:766[cap]')
    expect(framed.filter).toContain('s=1600x900:fps=30[out]')
  })
})

describe('cameraTransform', () => {
  it('is identity at zoom 1 and centers the camera target otherwise', () => {
    expect(cameraTransform({ zoom: 1, cx: 0.5, cy: 0.5 })).toBe('none')
    // Zooming on (0.75, 0.5): the content shifts left by 25% then scales ×2.
    expect(cameraTransform({ zoom: 2, cx: 0.75, cy: 0.5 })).toBe(
      'scale(2.0000) translate(-25.000%, 0.000%)'
    )
  })
})

describe('bakeTargetSize', () => {
  it('halves a Retina capture to the 1080p cap, keeps small ones untouched', () => {
    expect(bakeTargetSize(2880, 1770)).toEqual({ width: 1758, height: 1080 })
    expect(bakeTargetSize(1440, 885)).toEqual({ width: 1440, height: 886 })
  })
})

describe('frameLayout / mapEventsToFrame', () => {
  it('keeps a 16:9 capture on an equal canvas with the historical fractions', () => {
    const layout = frameLayout(1280, 720)
    expect(layout).toMatchObject({ canvasW: 1280, canvasH: 720, fgW: 1088, fgH: 612, barH: 32 })
    expect(layout.sx).toBeCloseTo(0.85)
    expect(layout.sy).toBeCloseTo(0.85)
  })

  it('widens the canvas to 16:9 around a narrower capture, preserving its aspect', () => {
    const layout = frameLayout(1440, 900)
    expect(layout.canvasW / layout.canvasH).toBeCloseTo(16 / 9, 2)
    expect(layout.fgW / layout.fgH).toBeCloseTo(1440 / 900, 2)
    // Fitted by height: the gradient absorbs the extra width.
    expect(layout.sy).toBeCloseTo(0.85, 2)
    expect(layout.sx).toBeLessThan(0.8)
  })

  it('remaps journal positions onto the window, keys untouched', () => {
    const layout = frameLayout(1280, 720)
    const [corner, center, key] = mapEventsToFrame(
      [click(1, 1, 0), click(2, 0.5, 0.5), { t: 3, type: 'key' }],
      layout
    ) as DemoEvent[]
    expect(corner!.x).toBeCloseTo(0.925)
    expect(corner!.y).toBeCloseTo(0.5 - 0.425 + layout.offsetY)
    // The window's center sits half a bar below the canvas center.
    expect(center!.y).toBeCloseTo(0.5 + layout.barH / (2 * 720))
    expect(key).toEqual({ t: 3, type: 'key' })
  })
})
