import { describe, expect, it } from 'vitest'
import enCommon from './i18n/locales/en/common.json'
import frCommon from './i18n/locales/fr/common.json'
import { CAPTION_PRESETS, CAPTION_PRESET_IDS, isCaptionPresetId } from './captions'

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

describe('CAPTION_PRESETS registry', () => {
  it('has unique ids', () => {
    expect(new Set(CAPTION_PRESET_IDS).size).toBe(CAPTION_PRESETS.length)
  })

  it('every preset has a label in both locales, and no orphan label survives', () => {
    for (const [locale, resource] of LOCALES) {
      const labels = (resource as { exportDialog: { captions: Record<string, string> } })
        .exportDialog.captions
      for (const id of CAPTION_PRESET_IDS) {
        expect(typeof labels[id], `${locale}: exportDialog.captions.${id}`).toBe('string')
      }
      for (const key of Object.keys(labels)) {
        expect(isCaptionPresetId(key), `${locale}: orphan label exportDialog.captions.${key}`).toBe(
          true
        )
      }
    }
  })

  it('recognises preset ids', () => {
    expect(isCaptionPresetId('karaoke')).toBe(true)
    expect(isCaptionPresetId('srt')).toBe(false)
    expect(isCaptionPresetId(undefined)).toBe(false)
  })
})
