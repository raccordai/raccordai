import { fetchMediaBlob } from './mediaProxy'

/**
 * Extracts the final visible frame of a video as a JPEG blob.
 *
 * The video is downloaded into a same-origin Blob URL first — this side-steps
 * CORS taint issues with `canvas.toBlob()` that would otherwise plague
 * cross-origin <video> elements. The whole operation is in-browser.
 */
export async function extractLastFrame(videoUrl: string): Promise<Blob> {
  const videoBlob = await fetchMediaBlob(videoUrl)
  const blobUrl = URL.createObjectURL(videoBlob)

  const video = document.createElement('video')
  video.src = blobUrl
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  // Off-DOM is fine for codec decode in most browsers, but keep it attached if quirks appear.

  try {
    await waitFor(video, 'loadedmetadata')

    // Seek to just before the end. Going exactly to `duration` sometimes lands on a
    // blank frame depending on codec/browser — clamp a tiny offset back.
    const target = Math.max(0, video.duration - 0.05)
    video.currentTime = target
    await waitFor(video, 'seeked')

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(video, 0, 0)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
        'image/jpeg',
        0.92
      )
    })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

function waitFor(el: HTMLMediaElement, event: 'loadedmetadata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener(event, onOk)
      el.removeEventListener('error', onErr)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`Video element error while waiting for "${event}"`))
    }
    el.addEventListener(event, onOk)
    el.addEventListener('error', onErr)
  })
}
