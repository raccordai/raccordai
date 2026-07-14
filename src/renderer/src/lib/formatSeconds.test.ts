import { describe, expect, it } from 'vitest'
import { formatSeconds } from './formatSeconds'

describe('formatSeconds', () => {
  it('formats sub-minute durations', () => {
    expect(formatSeconds(0)).toBe('0s')
    expect(formatSeconds(7)).toBe('7s')
    expect(formatSeconds(24.5)).toBe('24.5s')
  })

  it('formats exact minutes', () => {
    expect(formatSeconds(60)).toBe('1m')
    expect(formatSeconds(180)).toBe('3m')
  })

  it('pads seconds under ten', () => {
    expect(formatSeconds(184)).toBe('3m04s')
    expect(formatSeconds(64.5)).toBe('1m04.5s')
  })

  it('never leaks float artefacts (sums of 0.1-precision clips)', () => {
    // 7.3 + 196.8 → 204.09999999999997 in float arithmetic
    expect(formatSeconds(7.3 + 196.8)).toBe('3m24.1s')
    expect(formatSeconds(0.1 + 0.2)).toBe('0.3s')
  })

  it('rounds to tenth-of-a-second precision', () => {
    expect(formatSeconds(59.96)).toBe('1m')
    expect(formatSeconds(12.34)).toBe('12.3s')
  })
})
