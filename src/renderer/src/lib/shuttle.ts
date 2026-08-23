/**
 * FCP-style shuttle playback (the L key): a preview-only rate MULTIPLIER on
 * top of each clip's baked `speed` effect. The effective element rate is
 * always `clipSpeed × shuttleRate`, so shuttling never touches the clip's
 * render-parity speed logic — and pausing resets the multiplier to 1×.
 */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const

export type ShuttleRate = (typeof SHUTTLE_RATES)[number]

/**
 * Next step of the shuttle ladder: 1 → 2 → 4 → 8, capped at 8. An off-ladder
 * value (defensive — the state only ever holds ladder steps) snaps to the
 * next step up so repeated presses always converge on the ladder.
 */
export function nextShuttleRate(current: number): ShuttleRate {
  for (const rate of SHUTTLE_RATES) if (rate > current) return rate
  return SHUTTLE_RATES[3]
}
