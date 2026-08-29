/** Display rate of the transport timecode only — media fps varies per model. */
export const TIMECODE_FPS = 25

/**
 * FCP-style timecode: fixed-width `HH:MM:SS:FF` with the leading zeros dimmed.
 * The constant width (monospace + always 11 chars) is what keeps the transport
 * from shifting as digits roll over.
 */
export function Timecode({ seconds, dimAll = false }: { seconds: number; dimAll?: boolean }) {
  const totalFrames = Math.max(0, Math.floor(seconds * TIMECODE_FPS))
  const ff = totalFrames % TIMECODE_FPS
  const totalSeconds = Math.floor(totalFrames / TIMECODE_FPS)
  const hh = Math.floor(totalSeconds / 3600)
  const mm = Math.floor((totalSeconds % 3600) / 60)
  const ss = totalSeconds % 60
  const text = [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':')
  // Dim everything up to the first significant digit, like FCP.
  const firstDigit = text.search(/[1-9]/)
  const split = dimAll || firstDigit === -1 ? text.length : firstDigit
  return (
    <span className="font-mono tabular-nums whitespace-pre">
      <span className="text-neutral-600">{text.slice(0, split)}</span>
      <span className={dimAll ? undefined : 'text-neutral-100'}>{text.slice(split)}</span>
    </span>
  )
}
