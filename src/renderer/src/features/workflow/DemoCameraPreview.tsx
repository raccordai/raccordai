import { useEffect, useRef } from 'react'
import {
  FRAME_DEFAULTS,
  cameraTransform,
  cursorKeyframes,
  demoCameraEnabled,
  frameLayout,
  mapEventsToFrame,
  planZoomSegments,
  sampleCamera,
  sampleCursor,
  type DemoEvent,
  type PanTarget,
  type ZoomSegment
} from '@shared/screenMotion'
import type { AssetNodeMedia } from './data'

/**
 * Demo camera PREVIEW (§9): replays the automatic camera in the timeline
 * player — CSS transforms driven by the SAME pure math the render bakes
 * (sampleCamera/sampleCursor are the single source of truth, the
 * looks-registry doctrine of ffmpeg fragment + CSS equivalent). The stage
 * wraps the video stack: framed takes get the gradient + mac-style window
 * here too, and the whole composition zooms exactly like the MP4 will.
 *
 * Framed geometry depends on the CAPTURE's aspect ratio (frameLayout fits
 * the window to it on the 16:9 canvas), which the preview only knows once
 * the video's metadata load — so the derived segments/cursor/window styles
 * are computed lazily in the rAF loop, keyed by the media's intrinsic size.
 *
 * Styles are written imperatively from one requestAnimationFrame loop —
 * a per-frame React state would re-render the whole timeline at 60 fps.
 */

export interface DemoCameraInfo {
  events: DemoEvent[]
  framed: boolean
  showCursor: boolean
}

/** The camera the preview should replay for an asset clip, or null. */
export function demoCameraInfoFor(
  params: unknown,
  media: AssetNodeMedia | undefined
): DemoCameraInfo | null {
  if (!media || media.kind !== 'video' || !demoCameraEnabled(params, media.demoEvents)) return null
  return {
    events: media.demoEvents!,
    framed: (params as { demoFrame?: unknown } | undefined)?.demoFrame === true,
    // 'staged' takes have their lived cursor in the pixels already.
    showCursor: media.demoSource !== 'staged'
  }
}

const gradient = `linear-gradient(135deg, ${FRAME_DEFAULTS.background[0].replace('0x', '#')}, ${FRAME_DEFAULTS.background[1].replace('0x', '#')})`
const chrome = FRAME_DEFAULTS.chrome.replace('0x', '#')
const trafficLights = FRAME_DEFAULTS.trafficLights.map((c) => c.replace('0x', '#'))

interface Derived {
  key: string
  segments: ZoomSegment[]
  cursorKeys: PanTarget[]
}

/**
 * Wraps the player's media stack; `getMediaTime` reads the active video's
 * currentTime (media time — the same clock the bake's zoompan runs on) and
 * `getMediaSize` its intrinsic dimensions (the capture's true size).
 */
export function DemoCameraStage({
  info,
  getMediaTime,
  getMediaSize,
  children
}: {
  info: DemoCameraInfo | null
  getMediaTime: () => number
  getMediaSize: () => { width: number; height: number } | null
  children: React.ReactNode
}): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const windowRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (!info) {
      stage.style.transform = 'none'
      return
    }
    let raf = 0
    let derived: Derived | null = null
    const derive = (): Derived | null => {
      if (!info.framed) {
        if (derived?.key !== 'plain') {
          derived = {
            key: 'plain',
            // The take's own length bounds the journal — no cap needed here.
            segments: planZoomSegments(info.events, Number.POSITIVE_INFINITY),
            cursorKeys: cursorKeyframes(info.events)
          }
        }
        return derived
      }
      const size = getMediaSize()
      if (!size || size.width <= 0 || size.height <= 0) return derived
      const key = `${size.width}x${size.height}`
      if (derived?.key === key) return derived
      const layout = frameLayout(size.width, size.height)
      const mapped = mapEventsToFrame(info.events, layout)
      derived = {
        key,
        segments: planZoomSegments(mapped, Number.POSITIVE_INFINITY),
        cursorKeys: cursorKeyframes(mapped)
      }
      // Window box on the 16:9 stage — same fractions as the ffmpeg chain.
      const win = windowRef.current
      if (win) {
        win.style.left = `${((1 - layout.winWFrac) / 2) * 100}%`
        win.style.top = `${((1 - layout.winHFrac) / 2) * 100}%`
        win.style.width = `${layout.winWFrac * 100}%`
        win.style.height = `${layout.winHFrac * 100}%`
      }
      const bar = barRef.current
      if (bar) bar.style.height = `${layout.barInWinFrac * 100}%`
      return derived
    }
    const tick = (): void => {
      const d = derive()
      const t = getMediaTime()
      stage.style.transform = d ? cameraTransform(sampleCamera(d.segments, t)) : 'none'
      const cursor = cursorRef.current
      if (cursor) {
        const point = d && info.showCursor ? sampleCursor(d.cursorKeys, t) : null
        if (point) {
          cursor.style.opacity = '1'
          cursor.style.left = `${point.x * 100}%`
          cursor.style.top = `${point.y * 100}%`
        } else {
          cursor.style.opacity = '0'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [info, getMediaTime, getMediaSize])

  return (
    <div
      ref={stageRef}
      className="absolute inset-0"
      style={{ transformOrigin: 'center', willChange: info ? 'transform' : undefined }}
    >
      {info?.framed ? (
        <>
          <div className="absolute inset-0" style={{ background: gradient }} />
          <div
            ref={windowRef}
            className="absolute flex flex-col overflow-hidden"
            style={{
              // Placeholder box until the media's metadata set the real one.
              left: '7.5%',
              top: '5.25%',
              width: '85%',
              height: '89.5%',
              borderRadius: 12,
              boxShadow: '0 16px 44px rgba(0,0,0,0.45)',
              background: chrome
            }}
          >
            {/* Fake macOS chrome: title bar + traffic lights, like the render's. */}
            <div
              ref={barRef}
              className="flex flex-shrink-0 items-center gap-[6px] pl-3"
              style={{ height: '5%', background: chrome }}
            >
              {trafficLights.map((color) => (
                <span
                  key={color}
                  className="rounded-full"
                  style={{ width: 9, height: 9, background: color }}
                />
              ))}
            </div>
            <div className="relative min-h-0 flex-1">{children}</div>
          </div>
        </>
      ) : (
        children
      )}
      {info?.showCursor && (
        <div
          ref={cursorRef}
          className="pointer-events-none absolute z-[8] opacity-0"
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            transform: 'translate(-50%, -50%)',
            background:
              'radial-gradient(circle, #ffffff 0 40%, rgba(255,255,255,0.35) 41% 70%, transparent 71%)',
            boxShadow: '0 0 8px rgba(255,255,255,0.6)'
          }}
        />
      )}
    </div>
  )
}
