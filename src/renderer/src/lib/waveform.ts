/**
 * Waveform peaks for the timeline's audio lanes (pure, tested): bucketed
 * absolute maxima of a decoded channel, normalized to the loudest bucket, and
 * an SVG path builder that mirrors them around the block's midline. Decoding
 * itself (WebAudio) lives in the Waveform component — this module owns every
 * decision on the samples.
 */

/** Bucketed |max| of the samples, normalized so the loudest bucket is 1. */
export function computePeaks(samples: ArrayLike<number>, buckets: number): number[] {
  if (buckets <= 0 || samples.length === 0) return []
  const out = new Array<number>(buckets).fill(0)
  const per = samples.length / buckets
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per)
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * per)))
    let max = 0
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i] as number)
      if (v > max) max = v
    }
    out[b] = max
  }
  const loudest = Math.max(...out)
  if (loudest <= 0) return out
  return out.map((v) => v / loudest)
}

/** The peaks of a media sub-window (fractions of the full duration). */
export function slicePeaks(peaks: number[], startFrac: number, endFrac: number): number[] {
  if (peaks.length === 0) return []
  const s = Math.max(0, Math.min(peaks.length - 1, Math.floor(startFrac * peaks.length)))
  const e = Math.max(s + 1, Math.min(peaks.length, Math.ceil(endFrac * peaks.length)))
  return peaks.slice(s, e)
}

/** One SVG path of vertical bars mirrored around the midline. */
export function waveformPath(peaks: number[], width: number, height: number): string {
  if (peaks.length === 0) return ''
  const mid = height / 2
  const step = width / peaks.length
  let d = ''
  peaks.forEach((p, i) => {
    const x = (i + 0.5) * step
    const h = Math.max(0.4, p * (mid - 1))
    d += `M${x.toFixed(2)} ${(mid - h).toFixed(2)}V${(mid + h).toFixed(2)}`
  })
  return d
}
