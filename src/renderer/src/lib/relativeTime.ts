import type { TFunction } from 'i18next'

/** Compact "modified 2d ago" style timestamps for library cards. */
export function relativeTime(t: TFunction, timestamp: number): string {
  const elapsed = Date.now() - timestamp
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: Math.floor(hours / 24) })
}
