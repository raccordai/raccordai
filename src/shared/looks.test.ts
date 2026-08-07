import { describe, expect, it } from 'vitest'
import enCommon from './i18n/locales/en/common.json'
import frCommon from './i18n/locales/fr/common.json'
import { CLIP_LOOKS, CLIP_LOOK_IDS, isClipLookId, lookCssFilter, lookFfmpegFilter } from './looks'

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

describe('CLIP_LOOKS registry', () => {
  it('has unique ids and both filter sides on every look', () => {
    expect(new Set(CLIP_LOOK_IDS).size).toBe(CLIP_LOOKS.length)
    for (const look of CLIP_LOOKS) {
      expect(look.ffmpeg.length, look.id).toBeGreaterThan(0)
      expect(look.css.length, look.id).toBeGreaterThan(0)
    }
  })

  it('every look has a label in both locales, and no orphan label survives', () => {
    for (const [locale, resource] of LOCALES) {
      const labels = (resource as { timeline: { looks: Record<string, string> } }).timeline.looks
      for (const id of CLIP_LOOK_IDS) {
        expect(typeof labels[id], `${locale}: timeline.looks.${id}`).toBe('string')
      }
      for (const key of Object.keys(labels)) {
        expect(isClipLookId(key), `${locale}: orphan label timeline.looks.${key}`).toBe(true)
      }
    }
  })

  it('resolves both sides, degrading to no-op on none/unknown', () => {
    expect(lookFfmpegFilter('mono')).toBe('hue=s=0')
    expect(lookFfmpegFilter(null)).toBeNull()
    expect(lookFfmpegFilter('nope')).toBeNull()
    expect(lookCssFilter('mono')).toBe('grayscale(1)')
    expect(lookCssFilter(undefined)).toBe('none')
  })
})
