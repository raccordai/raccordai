import { Play } from 'lucide-react'
import { useRef, useState } from 'react'
import { formatSeconds } from '../lib/formatSeconds'

/**
 * Static <video> thumbnail. A never-played <video preload="metadata"> decodes no
 * frame (and generated videos often open on black), so on loadedmetadata we seek
 * a little into the clip to force a representative frame to be painted.
 *
 * With `overlay` (default), the thumb also announces itself as a video — a
 * "▶ duration" badge — and plays muted on hover, resetting to the poster frame
 * on leave. Hover handlers live on the wrapper because several call sites put
 * `pointer-events-none` on the video itself.
 */
export function posterTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(1, duration / 2)
}

export function VideoThumb({
  src,
  className,
  overlay = true
}: {
  src: string
  className?: string
  /** Badge + hover-to-play. Off for surfaces that draw their own chrome (timeline clips). */
  overlay?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState<number | null>(null)

  return (
    <span
      className="relative block h-full w-full"
      onMouseEnter={
        overlay ? () => void videoRef.current?.play().catch(() => undefined) : undefined
      }
      onMouseLeave={
        overlay
          ? () => {
              const video = videoRef.current
              if (!video) return
              video.pause()
              video.currentTime = posterTime(video.duration)
            }
          : undefined
      }
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        loop
        preload="metadata"
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration)
          e.currentTarget.currentTime = posterTime(e.currentTarget.duration)
        }}
        className={className}
      />
      {/* z-10: must paint above the video, lifted to z-index 1 by the
          .island video backdrop-filter workaround in styles.css */}
      {overlay && (
        <span className="pointer-events-none absolute bottom-1 left-1 z-10 flex items-center gap-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-medium text-neutral-200">
          <Play className="h-2.5 w-2.5" />
          {duration !== null && Number.isFinite(duration) ? formatSeconds(duration) : null}
        </span>
      )}
    </span>
  )
}
