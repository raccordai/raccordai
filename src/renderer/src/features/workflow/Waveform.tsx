import { useEffect, useState } from 'react'
import { computePeaks, slicePeaks, waveformPath } from '../../lib/waveform'

/**
 * Audio waveform for the timeline lanes: fetches the media (media:// supports
 * fetch), decodes it once through a shared AudioContext and caches the peaks
 * per URL — every block showing the same track reuses one decode. Rendering
 * is currentColor, so the lane's own text color tints its waveform.
 */

const PEAK_BUCKETS = 160
const peaksCache = new Map<string, Promise<number[] | null>>()
let sharedCtx: AudioContext | null = null

async function loadPeaks(url: string): Promise<number[] | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    sharedCtx ??= new AudioContext()
    const audio = await sharedCtx.decodeAudioData(buf)
    return computePeaks(audio.getChannelData(0), PEAK_BUCKETS)
  } catch {
    // Undecodable/unfetchable media → no waveform, never an error surface.
    return null
  }
}

export function useWaveformPeaks(url: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    if (!url) {
      setPeaks(null)
      return
    }
    let alive = true
    let promise = peaksCache.get(url)
    if (!promise) {
      promise = loadPeaks(url)
      peaksCache.set(url, promise)
    }
    void promise.then((v) => {
      if (alive) setPeaks(v)
    })
    return () => {
      alive = false
    }
  }, [url])
  return peaks
}

/** The waveform of a media sub-window (fractions of the full duration). */
export function Waveform({
  url,
  startFrac = 0,
  endFrac = 1,
  className
}: {
  url: string | null
  startFrac?: number
  endFrac?: number
  className?: string
}) {
  const peaks = useWaveformPeaks(url)
  if (!peaks || peaks.length === 0) return null
  const visible = slicePeaks(peaks, startFrac, endFrac)
  return (
    <svg viewBox="0 0 160 32" preserveAspectRatio="none" className={className} aria-hidden="true">
      <path
        d={waveformPath(visible, 160, 32)}
        stroke="currentColor"
        strokeWidth={0.8}
        opacity={0.45}
        fill="none"
      />
    </svg>
  )
}
