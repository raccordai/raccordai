import { describe, expect, it } from 'vitest'
import { SHUTTLE_RATES, nextShuttleRate } from './shuttle'

describe('nextShuttleRate', () => {
  it('climbs the ladder one step per press: 1 → 2 → 4 → 8', () => {
    expect(nextShuttleRate(1)).toBe(2)
    expect(nextShuttleRate(2)).toBe(4)
    expect(nextShuttleRate(4)).toBe(8)
  })

  it('caps at the top of the ladder', () => {
    expect(nextShuttleRate(8)).toBe(8)
    expect(nextShuttleRate(100)).toBe(8)
  })

  it('snaps an off-ladder value to the next step up', () => {
    expect(nextShuttleRate(0)).toBe(1)
    expect(nextShuttleRate(3)).toBe(4)
    expect(nextShuttleRate(5.5)).toBe(8)
  })

  it('ladder starts at 1× (the resting rate) and only goes up', () => {
    expect(SHUTTLE_RATES[0]).toBe(1)
    for (let i = 1; i < SHUTTLE_RATES.length; i++) {
      expect(SHUTTLE_RATES[i]).toBeGreaterThan(SHUTTLE_RATES[i - 1] as number)
    }
  })
})
