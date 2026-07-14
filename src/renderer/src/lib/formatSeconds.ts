/**
 * Human-readable duration: "7s", "24.5s", "3m", "3m04s", "3m24.1s".
 *
 * Works in integer tenths of a second — float arithmetic on the raw seconds
 * (`s % 60`) leaks artefacts like "3m24.099999999999994s".
 */
export function formatSeconds(s: number): string {
  const tenths = Math.round(s * 10)
  const minutes = Math.floor(tenths / 600)
  const seconds = (tenths % 600) / 10
  if (minutes === 0) return `${seconds}s`
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m${seconds < 10 ? '0' : ''}${seconds}s`
}
