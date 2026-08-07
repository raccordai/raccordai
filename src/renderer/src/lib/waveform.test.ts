import { describe, expect, it } from 'vitest'
import { computePeaks, slicePeaks, waveformPath } from './waveform'

describe('waveform peaks', () => {
  it('buckets absolute maxima and normalizes to the loudest bucket', () => {
    const samples = [0.1, -0.5, 0.2, 0.25, 0, -1, 0.3, 0.1]
    const peaks = computePeaks(samples, 4)
    expect(peaks).toHaveLength(4)
    // Buckets: |−0.5|, 0.25, |−1|, 0.3 → normalized by 1.
    expect(peaks[0]).toBeCloseTo(0.5)
    expect(peaks[2]).toBe(1)
    expect(Math.max(...peaks)).toBe(1)
  })

  it('survives silence and empty input', () => {
    expect(computePeaks([], 4)).toEqual([])
    expect(computePeaks([0, 0, 0, 0], 2)).toEqual([0, 0])
    expect(computePeaks([0.5], 0)).toEqual([])
  })

  it('slices the trimmed window out of the peaks', () => {
    const peaks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
    expect(slicePeaks(peaks, 0.2, 0.5)).toEqual([0.3, 0.4, 0.5])
    expect(slicePeaks(peaks, 0, 1)).toEqual(peaks)
    // Degenerate window keeps at least one bucket.
    expect(slicePeaks(peaks, 0.99, 0.99)).toHaveLength(1)
    expect(slicePeaks([], 0, 1)).toEqual([])
  })

  it('draws one mirrored bar per peak', () => {
    const d = waveformPath([1, 0], 20, 10)
    // First bar spans the full half-height around the midline (5 ± 4).
    expect(d).toContain('M5.00 1.00V9.00')
    // Silent bucket keeps a hairline so the lane never looks empty.
    expect(d).toContain('M15.00 4.60V5.40')
    expect(waveformPath([], 20, 10)).toBe('')
  })
})
