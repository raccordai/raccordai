import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { relativeTime } from './relativeTime'

const t = ((key: string, opts?: { count?: number }) =>
  opts?.count !== undefined ? `${key}:${opts.count}` : key) as unknown as TFunction

const NOW = new Date('2026-07-11T12:00:00Z')

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('under a minute → justNow', () => {
    expect(relativeTime(t, NOW.getTime() - 30_000)).toBe('time.justNow')
  })

  it('under an hour → minutes', () => {
    expect(relativeTime(t, NOW.getTime() - 5 * 60_000)).toBe('time.minutesAgo:5')
    expect(relativeTime(t, NOW.getTime() - 59 * 60_000)).toBe('time.minutesAgo:59')
  })

  it('under a day → hours', () => {
    expect(relativeTime(t, NOW.getTime() - 60 * 60_000)).toBe('time.hoursAgo:1')
    expect(relativeTime(t, NOW.getTime() - 23 * 3_600_000)).toBe('time.hoursAgo:23')
  })

  it('a day or more → days', () => {
    expect(relativeTime(t, NOW.getTime() - 24 * 3_600_000)).toBe('time.daysAgo:1')
    expect(relativeTime(t, NOW.getTime() - 8 * 24 * 3_600_000)).toBe('time.daysAgo:8')
  })
})
