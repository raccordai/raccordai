import { describe, expect, it } from 'vitest'
import enCommon from './i18n/locales/en/common.json'
import frCommon from './i18n/locales/fr/common.json'
import { TEXT_ANIMATIONS, TEXT_ANIMATION_IDS, isTextAnimationId } from './textAnimations'

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

describe('TEXT_ANIMATIONS registry', () => {
  it('has unique ids', () => {
    expect(new Set(TEXT_ANIMATION_IDS).size).toBe(TEXT_ANIMATIONS.length)
  })

  it('every animation has a label in both locales, and no orphan label survives', () => {
    for (const [locale, resource] of LOCALES) {
      const labels = (resource as { timeline: { layerAnimations: Record<string, string> } })
        .timeline.layerAnimations
      for (const id of TEXT_ANIMATION_IDS) {
        expect(typeof labels[id], `${locale}: timeline.layerAnimations.${id}`).toBe('string')
      }
      for (const key of Object.keys(labels)) {
        expect(
          isTextAnimationId(key),
          `${locale}: orphan label timeline.layerAnimations.${key}`
        ).toBe(true)
      }
    }
  })

  it('recognises preset ids', () => {
    expect(isTextAnimationId('slide-up')).toBe(true)
    expect(isTextAnimationId('spin')).toBe(false)
  })
})
