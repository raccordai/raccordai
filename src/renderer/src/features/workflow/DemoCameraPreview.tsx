import { useEffect, useRef } from 'react'
import {
  FRAME_DEFAULTS,
  cameraTransform,
  cursorKeyframes,
  demoCameraEnabled,
  insetEvents,
  planZoomSegments,
  sampleCamera,
  sampleCursor,
  type PanTarget,
  type ZoomSegment
} from '@shared/screenMotion'
import type { AssetNodeMedia } from './data'

/**
 * Demo camera PREVIEW (§9): replays the automatic camera in the timeline
 * player — CSS transforms driven by the SAME pure math the render bakes
 * (sampleCamera/sampleCursor are the single source of truth, the
 * looks-registry doctrine of ffmpeg fragment + CSS equivalent). The stage
 * wraps the video stack: framed takes get the gradient + rounded inset here
 * too, and the whole composition zooms exactly like the MP4 will.
 *
 * Styles are written imperatively from one requestAnimationFrame loop —
 * a per-frame React state would re-render the whole timeline at 60 fps.
 */

export interface DemoCameraInfo {
  segments: ZoomSegment[]
  cursorKeys: PanTarget[]
  framed: boolean
  showCursor: boolean
}

/** The camera the preview should replay for an asset clip, or null. */
export function demoCameraInfoFor(
  params: unknown,
  media: AssetNodeMedia | undefined
): DemoCameraInfo | null {
  if (!media || media.kind !== 'video' || !demoCameraEnabled(params, media.demoEvents)) return null
  const framed = (params as { demoFrame?: unknown } | undefined)?.demoFrame === true
  const events = framed ? insetEvents(media.demoEvents!, FRAME_DEFAULTS.scale) : media.demoEvents!
  return {
    // The take's own length already bounds the journal — no cap needed here.
    segments: planZoomSegments(events, Number.POSITIVE_INFINITY),
    cursorKeys: cursorKeyframes(events),
    framed,
    // 'staged' takes have their lived cursor in the pixels already.
    showCursor: media.demoSource !== 'staged'
  }
}

const inset = `${((1 - FRAME_DEFAULTS.scale) / 2) * 100}%`
const insetSize = `${FRAME_DEFAULTS.scale * 100}%`
const gradient = `linear-gradient(135deg, ${FRAME_DEFAULTS.background[0].replace('0x', '#')}, ${FRAME_DEFAULTS.background[1].replace('0x', '#')})`

/**
 * Wraps the player's media stack; `getMediaTime` reads the active video's
 * currentTime (media time — the same clock the bake's zoompan runs on).
 */
export function DemoCameraStage({
  info,
  getMediaTime,
  children
}: {
  info: DemoCameraInfo | null
  getMediaTime: () => number
  children: React.ReactNode
}): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (!info) {
      stage.style.transform = 'none'
      return
    }
    let raf = 0
    const tick = (): void => {
      const t = getMediaTime()
      stage.style.transform = cameraTransform(sampleCamera(info.segments, t))
      const cursor = cursorRef.current
      if (cursor) {
        const point = info.showCursor ? sampleCursor(info.cursorKeys, t) : null
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
  }, [info, getMediaTime])

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
            className="absolute overflow-hidden"
            style={{
              left: inset,
              top: inset,
              width: insetSize,
              height: insetSize,
              borderRadius: 12,
              boxShadow: '0 16px 44px rgba(0,0,0,0.45)'
            }}
          >
            {children}
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
