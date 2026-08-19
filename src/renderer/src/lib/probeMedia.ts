/**
 * In-browser probing of a downloaded media blob — used by the FCPXML export so
 * the timeline matches the real footage (resolution, duration, frame rate)
 * instead of guessed values. All of it runs off a temporary object URL; nothing
 * touches the network.
 */

export interface VideoDimensions {
  width: number
  height: number
  /** Real media duration in seconds. */
  duration: number
}

/**
 * Read a video's intrinsic width/height/duration from its metadata (fast — no
 * playback). Returns null if the browser can't decode the container.
 */
export async function probeVideoDimensions(blob: Blob): Promise<VideoDimensions | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('probeVideoDimensions: metadata error'))
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (!video.videoWidth || !video.videoHeight || duration <= 0) return null
    return { width: video.videoWidth, height: video.videoHeight, duration }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Read an audio file's real duration from its metadata (used by the FCPXML
 * export to place and chain the audio lanes). Null when undecodable.
 */
export async function probeAudioDuration(blob: Blob): Promise<number | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  const audio = document.createElement('audio')
  audio.preload = 'metadata'
  audio.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve()
      audio.onerror = () => reject(new Error('probeAudioDuration: metadata error'))
    })
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]

/** Snap a measured rate to the nearest standard fps when it's close enough. */
function snapFps(raw: number): number {
  let best = raw
  let bestErr = Infinity
  for (const f of COMMON_FPS) {
    const err = Math.abs(f - raw)
    if (err < bestErr) {
      bestErr = err
      best = f
    }
  }
  return bestErr <= 1 ? best : Math.round(raw)
}

/**
 * Best-effort frame-rate detection. The browser exposes no fps attribute, so we
 * play a short muted slice and measure the spacing between decoded frames via
 * `requestVideoFrameCallback`, then snap to the nearest standard rate. Returns
 * null when rVFC is unavailable or too few frames arrive to be confident — the
 * caller falls back to a sensible default.
 */
export async function detectVideoFps(blob: Blob, sampleMs = 1200): Promise<number | null> {
  if (typeof document === 'undefined') return null
  const video = document.createElement('video') as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
  }
  if (typeof video.requestVideoFrameCallback !== 'function') return null

  const url = URL.createObjectURL(blob)
  video.muted = true
  video.playsInline = true
  video.src = url
  const mediaTimes: number[] = []

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('detectVideoFps: metadata error'))
    })
    await new Promise<void>((resolve) => {
      let stopped = false
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        mediaTimes.push(meta.mediaTime)
        if (!stopped) video.requestVideoFrameCallback!(onFrame)
      }
      video.requestVideoFrameCallback!(onFrame)
      void video.play().catch(() => {})
      window.setTimeout(() => {
        stopped = true
        video.pause()
        resolve()
      }, sampleMs)
    })
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }

  const deltas: number[] = []
  for (let i = 1; i < mediaTimes.length; i++) {
    const d = mediaTimes[i]! - mediaTimes[i - 1]!
    if (d > 0) deltas.push(d)
  }
  if (deltas.length < 3) return null
  deltas.sort((a, b) => a - b)
  const median = deltas[Math.floor(deltas.length / 2)]!
  return median > 0 ? snapFps(1 / median) : null
}
