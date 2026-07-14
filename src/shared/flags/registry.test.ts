import { describe, expect, it } from 'vitest'
import { flagKeys, flagRegistry, isFlagKey } from './registry'

describe('flag registry', () => {
  it('flagKeys mirrors the registry', () => {
    expect(flagKeys.sort()).toEqual(Object.keys(flagRegistry).sort())
  })

  it('isFlagKey narrows correctly', () => {
    expect(isFlagKey('local-api')).toBe(true)
    expect(isFlagKey('not-a-flag')).toBe(false)
    expect(isFlagKey('')).toBe(false)
  })

  it('every flag declares a default for each release channel', () => {
    for (const [key, def] of Object.entries(flagRegistry)) {
      for (const channel of ['dev', 'beta', 'stable'] as const) {
        expect(typeof def.defaults[channel], `${key}.${channel}`).toBe('boolean')
      }
      expect(def.description.trim()).not.toBe('')
    }
  })
})
