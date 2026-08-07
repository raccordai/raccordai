import { describe, expect, it } from 'vitest'
import enCommon from './i18n/locales/en/common.json'
import frCommon from './i18n/locales/fr/common.json'
import { STILL_MOTIONS, STILL_MOTION_IDS, isStillMotionId } from './stillMotion'

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

describe('STILL_MOTIONS registry', () => {
  it('has unique ids', () => {
    expect(new Set(STILL_MOTION_IDS).size).toBe(STILL_MOTIONS.length)
  })

  it('every motion has a label in both locales, and no orphan label survives', () => {
    for (const [locale, resource] of LOCALES) {
      const labels = (resource as { timeline: { motions: Record<string, string> } }).timeline
        .motions
      for (const id of STILL_MOTION_IDS) {
        expect(typeof labels[id], `${locale}: timeline.motions.${id}`).toBe('string')
      }
      for (const key of Object.keys(labels)) {
        expect(isStillMotionId(key), `${locale}: orphan label timeline.motions.${key}`).toBe(true)
      }
    }
  })

  it('recognises preset ids', () => {
    expect(isStillMotionId('zoom-in')).toBe(true)
    expect(isStillMotionId('spin')).toBe(false)
  })
})
