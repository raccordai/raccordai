/**
 * Screen-motion compiler (§9 — automatic feature videos): turns the EVENT
 * TRACK of a recorded demo (clicks/moves with timestamps, captured by whoever
 * drove the app) into the automatic demo camera — auto zoom-in on each
 * click, smooth pans between nearby clicks, eased release — plus a synthetic
 * cursor glide, both as ffmpeg filter expressions.
 *
 * Everything decision-shaped is numeric and pure here (renderPlan doctrine):
 * `planZoomSegments` merges clicks into camera segments, `sampleCamera` is the
 * tested source of truth for the camera at any time t, and the `*Filter`
 * builders translate the SAME segment data into ffmpeg expressions (zoompan
 * for the camera — the cursor is overlaid BEFORE zooming, so it scales with
 * the picture like a real recording would).
 *
 * Coordinates are NORMALIZED (0-1 of the capture frame), like every overlay
 * in the app; times are seconds from the start of the capture.
 */

/** One input event of a recorded demo session. */
export interface DemoEvent {
  /** Seconds from the start of the capture. */
  t: number
  type: 'click' | 'move' | 'key' | 'scroll'
  /** Normalized position (0-1); absent on key events. */
  x?: number
  y?: number
}

export interface ScreenMotionOptions {
  /** Zoom level held on a click (1 = no zoom). */
  zoom?: number
  /** Seconds the zoom-in ramp starts BEFORE the click. */
  leadSec?: number
  /** Seconds the zoom holds after the segment's last click. */
  holdSec?: number
  /** Seconds of the zoom-out ramp. */
  releaseSec?: number
  /** Clicks closer than this share one segment (the camera pans between them). */
  mergeWindowSec?: number
}

const DEFAULTS: Required<ScreenMotionOptions> = {
  zoom: 1.8,
  leadSec: 0.6,
  holdSec: 1.1,
  releaseSec: 0.8,
  mergeWindowSec: 2.5
}

/** A pan target inside a segment — the camera centers here at time t. */
export interface PanTarget {
  t: number
  x: number
  y: number
}

/** One camera move: ramp in before the first click, pan, ramp out at the end. */
export interface ZoomSegment {
  startSec: number
  endSec: number
  /** Seconds of the in/out ramps (may be shorter than asked on short segments). */
  leadSec: number
  releaseSec: number
  zoom: number
  /** Chronological pan targets (the segment's clicks). Never empty. */
  targets: PanTarget[]
}

/**
 * Should the automatic camera run on this clip? The product promise is
 * AUTOMATIC: a demo journal on the asset ⇒ camera applied at render. The
 * opt-out is a params marker on the asset NODE (`demoCamera: false`, written
 * through the journaled updateNodeParams — same pattern as applyVideoStyle),
 * so "keep the raw capture" is an explicit, undoable gesture.
 */
export function demoCameraEnabled(
  params: unknown,
  events: DemoEvent[] | null | undefined
): boolean {
  if (!events || events.length === 0) return false
  return (params as { demoCamera?: unknown } | undefined)?.demoCamera !== false
}

/** Hermite smoothstep — the easing of every camera and cursor move. */
export function smoothstep(p: number): number {
  const c = Math.min(1, Math.max(0, p))
  return c * c * (3 - 2 * c)
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * Global point (screen coordinates, e.g. a uiohook event during an external
 * SCREEN capture) → normalized position on the captured display. Null when
 * the point lands outside it (a click on another monitor is not part of the
 * demo). Bounds are Electron display bounds (DIPs — macOS CGEvent points
 * share that space).
 */
export function normalizeOnDisplay(
  x: number,
  y: number,
  bounds: { x: number; y: number; width: number; height: number }
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const nx = (x - bounds.x) / bounds.width
  const ny = (y - bounds.y) / bounds.height
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
  return { x: nx, y: ny }
}

/**
 * Latest-sample-per-window coalescing for pointer/mouse moves: at most one
 * move event per interval (the glide compiler only needs waypoints). Shared
 * by the renderer journal (self capture) and main's global hook (screen
 * capture).
 */
export function createMoveThrottle(intervalSec = 0.08): (event: DemoEvent) => DemoEvent | null {
  let windowStart = -Infinity
  return (event) => {
    if (event.t - windowStart < intervalSec) return null
    windowStart = event.t
    return event
  }
}

/**
 * Camera segments from the event track: one segment per burst of clicks
 * (gaps ≤ mergeWindowSec chain into the same segment — the camera pans
 * instead of zooming out and back in), expanded by the lead/hold/release
 * envelope, then overlapping segments merged. Ramps shrink to at most half
 * of a short segment so in+out never cross.
 */
export function planZoomSegments(
  events: DemoEvent[],
  durationSec: number,
  options: ScreenMotionOptions = {}
): ZoomSegment[] {
  const opts = { ...DEFAULTS, ...options }
  const clicks = events
    .filter((e) => e.type === 'click' && typeof e.x === 'number' && typeof e.y === 'number')
    .filter((e) => e.t >= 0 && e.t <= durationSec)
    .sort((a, b) => a.t - b.t)
  if (clicks.length === 0 || opts.zoom <= 1) return []

  const groups: PanTarget[][] = []
  for (const click of clicks) {
    const target = { t: click.t, x: clamp01(click.x!), y: clamp01(click.y!) }
    const current = groups[groups.length - 1]
    if (current && target.t - current[current.length - 1]!.t <= opts.mergeWindowSec) {
      current.push(target)
    } else {
      groups.push([target])
    }
  }

  const segments: ZoomSegment[] = []
  for (const targets of groups) {
    const startSec = Math.max(0, targets[0]!.t - opts.leadSec)
    const endSec = Math.min(
      durationSec,
      targets[targets.length - 1]!.t + opts.holdSec + opts.releaseSec
    )
    const previous = segments[segments.length - 1]
    if (previous && startSec <= previous.endSec) {
      // The envelopes touch: one continuous camera move.
      previous.endSec = endSec
      previous.targets.push(...targets)
      continue
    }
    segments.push({ startSec, endSec, leadSec: 0, releaseSec: 0, zoom: opts.zoom, targets })
  }
  for (const seg of segments) {
    const half = (seg.endSec - seg.startSec) / 2
    seg.leadSec = Math.min(opts.leadSec, half)
    seg.releaseSec = Math.min(opts.releaseSec, half)
  }
  return segments
}

/** The camera's center at time t within a segment (before easing ramps). */
function panCenter(seg: ZoomSegment, t: number): { x: number; y: number } {
  const targets = seg.targets
  if (t <= targets[0]!.t) return targets[0]!
  const last = targets[targets.length - 1]!
  if (t >= last.t) return last
  for (let i = 0; i < targets.length - 1; i++) {
    const a = targets[i]!
    const b = targets[i + 1]!
    if (t >= a.t && t < b.t) {
      const e = smoothstep((t - a.t) / (b.t - a.t))
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }
    }
  }
  return last
}

/**
 * The camera at time t — the numeric source of truth the ffmpeg expressions
 * mirror. Zoom eases in over the lead, holds while panning between targets,
 * eases out over the release; the center is clamped so the crop window never
 * leaves the frame (at zoom 1 the clamp collapses to the frame center).
 */
export function sampleCamera(
  segments: ZoomSegment[],
  t: number
): { zoom: number; cx: number; cy: number } {
  const seg = segments.find((s) => t >= s.startSec && t <= s.endSec)
  if (!seg) return { zoom: 1, cx: 0.5, cy: 0.5 }

  let zoom: number
  if (t < seg.startSec + seg.leadSec) {
    zoom = 1 + (seg.zoom - 1) * smoothstep((t - seg.startSec) / seg.leadSec)
  } else if (t > seg.endSec - seg.releaseSec) {
    zoom = 1 + (seg.zoom - 1) * smoothstep((seg.endSec - t) / seg.releaseSec)
  } else {
    zoom = seg.zoom
  }

  const { x, y } = panCenter(seg, t)
  const halfWindow = 0.5 / zoom
  return {
    zoom,
    cx: Math.min(1 - halfWindow, Math.max(halfWindow, x)),
    cy: Math.min(1 - halfWindow, Math.max(halfWindow, y))
  }
}

/**
 * The camera as a CSS transform (preview parity — the render's zoompan and
 * this share sampleCamera as their single source of truth, the looks-registry
 * doctrine). Apply with `transform-origin: center` on the composition.
 */
export function cameraTransform(camera: { zoom: number; cx: number; cy: number }): string {
  if (camera.zoom === 1) return 'none'
  const tx = ((0.5 - camera.cx) * 100).toFixed(3)
  const ty = ((0.5 - camera.cy) * 100).toFixed(3)
  return `scale(${camera.zoom.toFixed(4)}) translate(${tx}%, ${ty}%)`
}

/** Formats a number for an ffmpeg expression (fixed, locale-proof). */
const n = (v: number): string => v.toFixed(4)

/** smoothstep of `p` as an ffmpeg expression fragment. */
const ssExpr = (p: string): string => {
  const c = `clip(${p},0,1)`
  return `(${c}*${c}*(3-2*${c}))`
}

/** The segment's pan center (x or y) as an expression of the time variable. */
function panExpr(seg: ZoomSegment, axis: 'x' | 'y', time: string): string {
  const targets = seg.targets
  let expr = n(targets[targets.length - 1]![axis])
  // Build right-to-left: if(before leg i, interpolate leg i, later legs…).
  for (let i = targets.length - 2; i >= 0; i--) {
    const a = targets[i]!
    const b = targets[i + 1]!
    const e = ssExpr(`(${time}-${n(a.t)})/${n(b.t - a.t)}`)
    const leg = `(${n(a[axis])}+${n(b[axis] - a[axis])}*${e})`
    expr = `if(lt(${time},${n(b.t)}),${leg},${expr})`
  }
  return `if(lt(${time},${n(targets[0]!.t)}),${n(targets[0]![axis])},${expr})`
}

/** The segment's zoom as an expression of the time variable. */
function zoomExpr(seg: ZoomSegment, time: string): string {
  const rampIn = ssExpr(`(${time}-${n(seg.startSec)})/${n(seg.leadSec)}`)
  const rampOut = ssExpr(`(${n(seg.endSec)}-${time})/${n(seg.releaseSec)}`)
  const rise = `(1+${n(seg.zoom - 1)}*${rampIn})`
  const fall = `(1+${n(seg.zoom - 1)}*${rampOut})`
  const inEnd = seg.startSec + seg.leadSec
  const outStart = seg.endSec - seg.releaseSec
  return `if(lt(${time},${n(inEnd)}),${rise},if(gt(${time},${n(outStart)}),${fall},${n(seg.zoom)}))`
}

/** Piecewise expression over the segments; `fallback` outside all of them. */
function piecewise(
  segments: ZoomSegment[],
  time: string,
  perSegment: (seg: ZoomSegment) => string,
  fallback: string
): string {
  let expr = fallback
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!
    expr = `if(between(${time},${n(seg.startSec)},${n(seg.endSec)}),${perSegment(seg)},${expr})`
  }
  return expr
}

/**
 * The whole camera as one zoompan filter (d=1 keeps the frame count). zoompan
 * exposes the input timestamp as `it`; x/y run after z, so `zoom` is the
 * current level — the clamp keeps the crop window inside the frame exactly
 * like sampleCamera. Output size must be given (zoompan defaults to hd720).
 */
export function zoompanFilter(
  segments: ZoomSegment[],
  opts: { width: number; height: number; fps: number }
): string {
  const z = piecewise(segments, 'it', (seg) => zoomExpr(seg, 'it'), '1')
  const cx = piecewise(segments, 'it', (seg) => panExpr(seg, 'x', 'it'), '0.5')
  const cy = piecewise(segments, 'it', (seg) => panExpr(seg, 'y', 'it'), '0.5')
  const x = `clip(iw*(${cx})-iw/(2*zoom),0,iw-iw/zoom)`
  const y = `clip(ih*(${cy})-ih/(2*zoom),0,ih-ih/zoom)`
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${opts.width}x${opts.height}:fps=${opts.fps}`
}

/**
 * Cursor glide keyframes: every event that carries a position, in order. The
 * synthetic cursor eases from one to the next over the real gap — steadier
 * than any human hand, and it arrives exactly when the click fires.
 */
export function cursorKeyframes(events: DemoEvent[]): PanTarget[] {
  return events
    .filter((e) => typeof e.x === 'number' && typeof e.y === 'number')
    .sort((a, b) => a.t - b.t)
    .map((e) => ({ t: e.t, x: clamp01(e.x!), y: clamp01(e.y!) }))
}

/** The cursor position at time t — numeric twin of the overlay expressions. */
export function sampleCursor(keyframes: PanTarget[], t: number): { x: number; y: number } | null {
  if (keyframes.length === 0) return null
  if (t <= keyframes[0]!.t) return keyframes[0]!
  const last = keyframes[keyframes.length - 1]!
  if (t >= last.t) return last
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!
    const b = keyframes[i + 1]!
    if (t >= a.t && t < b.t) {
      const e = smoothstep((t - a.t) / (b.t - a.t))
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }
    }
  }
  return last
}

/** One axis of the cursor glide as an overlay expression of `t`. */
function cursorAxisExpr(keyframes: PanTarget[], axis: 'x' | 'y'): string {
  let expr = n(keyframes[keyframes.length - 1]![axis])
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i]!
    const b = keyframes[i + 1]!
    const e = ssExpr(`(t-${n(a.t)})/${n(b.t - a.t)}`)
    const leg = `(${n(a[axis])}+${n(b[axis] - a[axis])}*${e})`
    expr = `if(lt(t,${n(b.t)}),${leg},${expr})`
  }
  return `if(lt(t,${n(keyframes[0]!.t)}),${n(keyframes[0]![axis])},${expr})`
}

/**
 * Overlay filter placing the cursor image (input [cursor]) on the capture.
 * Applied BEFORE zoompan so the cursor rides — and scales with — the zoom.
 * Normalized position maps to the cursor's CENTER (overlay_w/h are the
 * cursor input's own size). Null when the track has no positioned event.
 */
export function cursorOverlayFilter(keyframes: PanTarget[]): string | null {
  if (keyframes.length === 0) return null
  const x = `main_w*(${cursorAxisExpr(keyframes, 'x')})-overlay_w/2`
  const y = `main_h*(${cursorAxisExpr(keyframes, 'y')})-overlay_h/2`
  return `overlay=x='${x}':y='${y}'`
}

/**
 * Framed presentation (§9): the capture sits inset over a gradient
 * background, rounded and shadowed like a simple floating window, and the
 * camera zooms the whole composition.
 */
export interface DemoFrameOptions {
  /** Fraction of the output the capture occupies (default 0.85). */
  scale?: number
  /** Corner radius in pixels (default 16). */
  radius?: number
  /** Background gradient corners as 0xRRGGBB (default Raccord lavender → pink). */
  background?: [string, string]
}

export const FRAME_DEFAULTS = {
  scale: 0.85,
  radius: 16,
  background: ['0xb7b6ff', '0xff9bc6'] as const,
  /** Fake macOS title bar height as a fraction of the output height. */
  barFrac: 0.045,
  chrome: '0x2b2b36',
  trafficLights: ['0xff5f57', '0xfebc2e', '0x28c840'] as const
}

/**
 * Journal positions remapped onto the inset capture: p' = 0.5 + (p−0.5)·scale
 * (+ a vertical offset when the window chrome pushes the capture down — the
 * bar sits above it, so the capture's center is barFrac/2 below the frame's).
 */
export function insetEvents(events: DemoEvent[], scale: number, offsetY = 0): DemoEvent[] {
  return events.map((e) =>
    typeof e.x === 'number' && typeof e.y === 'number'
      ? { ...e, x: 0.5 + (e.x - 0.5) * scale, y: 0.5 + (e.y - 0.5) * scale + offsetY }
      : e
  )
}

/** Rounded-rect alpha (1px anti-aliased edge) for a w×h surface with an inner rect iw×ih. */
function roundedAlpha(w: number, h: number, innerW: number, innerH: number, r: number): string {
  const dx = `max(abs(X-${w / 2})-${innerW / 2 - r},0)`
  const dy = `max(abs(Y-${h / 2})-${innerH / 2 - r},0)`
  return `255*clip(${r}+0.5-sqrt(${dx}*${dx}+${dy}*${dy}),0,1)`
}

/** Filled-circle alpha (1px anti-aliased edge) centered on a d×d surface. */
function circleAlpha(d: number): string {
  return `255*clip(${d / 2}-0.5-hypot(X-${d / 2},Y-${d / 2}),0,1)`
}

/**
 * The framing chain: [0:v] → [framed]. A gradient background, a blurred
 * shadow silhouette, then a fake macOS WINDOW — title bar with the three
 * traffic lights above the capture, the whole thing rounded together.
 *
 * Performance doctrine: every STATIC element (gradient, shadow, dots, the
 * rounding mask) is generated at 2 fps — its per-pixel geq runs 15× less —
 * then duplicated to full rate by `fps`; the rounding itself is applied by
 * `alphamerge` against that static mask (a plane copy per frame) instead of
 * a per-frame geq. Every lavfi source is BOUNDED by the take's duration so
 * the output can never outrun the capture.
 */
function frameChain(
  opts: { width: number; height: number; fps: number },
  frame: DemoFrameOptions,
  durationSec: number
): string {
  const scale = frame.scale ?? FRAME_DEFAULTS.scale
  const radius = frame.radius ?? FRAME_DEFAULTS.radius
  const [c0, c1] = frame.background ?? FRAME_DEFAULTS.background
  const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
  // One frame of slack so rounding never cuts the last capture frame; the
  // final shortest=1 overlays clamp the output to the take itself.
  const dur = Number.isFinite(durationSec) ? (durationSec + 0.05).toFixed(3) : '3600'
  const fgW = even(opts.width * scale)
  const fgH = even(opts.height * scale)
  const barH = even(opts.height * FRAME_DEFAULTS.barFrac)
  const winW = fgW
  const winH = fgH + barH
  const winX = (opts.width - winW) / 2
  const winY = (opts.height - winH) / 2
  const pad = 80
  const shW = winW + pad
  const shH = winH + pad
  const dot = Math.max(6, even(Math.round(barH * 0.34)))
  const dotY = (barH - dot) / 2
  // Static generator: cheap 2 fps geq, duplicated to the real rate.
  const stillSrc = (src: string, chain: string): string =>
    `${src}:r=2:d=${dur},${chain},fps=${opts.fps}`
  const rgba = "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'"
  const [red, yellow, green] = FRAME_DEFAULTS.trafficLights
  const lights = [red, yellow, green]
    .map(
      (c, i) =>
        `${stillSrc(`color=c=${c}:s=${dot}x${dot}`, `${rgba}:a='${circleAlpha(dot)}'`)}[dot${i}]`
    )
    .join(';')
  const lightOverlays = [0, 1, 2]
    .map(
      (i) =>
        `[w${i}][dot${i}]overlay=x=${Math.round(barH * 0.5) + i * (dot + Math.round(dot * 0.8))}:y=${dotY}[w${i + 1}]`
    )
    .join(';')
  return [
    `[0:v]scale=${fgW}:${fgH}[cap]`,
    // The window: chrome-colored canvas, capture below the bar, dots on top.
    `color=c=${FRAME_DEFAULTS.chrome}:s=${winW}x${winH}:r=${opts.fps}:d=${dur}[winbase]`,
    `[winbase][cap]overlay=x=0:y=${barH}:shortest=1[w0]`,
    lights,
    lightOverlays,
    // Rounded as one via a STATIC mask + alphamerge (never a per-frame geq).
    `${stillSrc(`color=c=white:s=${winW}x${winH}`, `format=gray,geq=lum='${roundedAlpha(winW, winH, winW, winH, radius)}'`)}[mask]`,
    `[w3]format=rgba[w3f]`,
    `[w3f][mask]alphamerge[win]`,
    `${stillSrc(`gradients=s=${opts.width}x${opts.height}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${opts.width}:y1=${opts.height}`, 'null')}[bg]`,
    `${stillSrc(`color=c=black:s=${shW}x${shH}`, `format=rgba,geq=r=0:g=0:b=0:a='${roundedAlpha(shW, shH, winW, winH, radius + 4)}',boxblur=0:0:0:0:18:2,colorchannelmixer=aa=0.45`)}[sh]`,
    `[bg][sh]overlay=x=${(opts.width - shW) / 2}:y=${(opts.height - shH) / 2 + 10}[b1]`,
    // trim bounds the composition DETERMINISTICALLY: lavfi frame durations
    // (2 fps stills) otherwise pad the tail past the take via repeatlast.
    `[b1][win]overlay=x=${winX}:y=${winY}:shortest=1[fr0]`,
    `[fr0]trim=end=${Number.isFinite(durationSec) ? durationSec.toFixed(3) : '3600'},setpts=PTS-STARTPTS[framed]`
  ].join(';')
}

/**
 * The full -filter_complex of a screen-motion pass: capture on input 0,
 * cursor image on input 1 (omitted when the track has no position — the
 * chain then starts from the capture directly). `frame` composes the
 * framed look first (journal positions are remapped onto the inset);
 * `cursor: false` skips the synthetic cursor even with positioned events.
 */
export function buildScreenMotionFilter(
  events: DemoEvent[],
  durationSec: number,
  opts: {
    width: number
    height: number
    fps: number
    cursor?: boolean
    frame?: DemoFrameOptions
  } & ScreenMotionOptions
): { filter: string; usesCursor: boolean } {
  const mapped = opts.frame
    ? insetEvents(events, opts.frame.scale ?? FRAME_DEFAULTS.scale, FRAME_DEFAULTS.barFrac / 2)
    : events
  const segments = planZoomSegments(mapped, durationSec, opts)
  const zoom = zoompanFilter(segments, opts)
  const cursor = opts.cursor === false ? null : cursorOverlayFilter(cursorKeyframes(mapped))
  const base = opts.frame ? `${frameChain(opts, opts.frame, durationSec)};[framed]` : '[0:v]'
  if (cursor) {
    const cursorIn = opts.frame
      ? `${frameChain(opts, opts.frame, durationSec)};[framed][1:v]`
      : '[0:v][1:v]'
    return { filter: `${cursorIn}${cursor}[comp];[comp]${zoom}[out]`, usesCursor: true }
  }
  return { filter: `${base}${zoom}[out]`, usesCursor: false }
}
