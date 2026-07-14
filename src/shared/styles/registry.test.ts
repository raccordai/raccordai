import { describe, expect, it } from 'vitest'
import { STYLES, getStyle, isStyleId, styleIds } from './registry'

describe('style registry', () => {
  it('has unique ids', () => {
    expect(new Set(styleIds).size).toBe(STYLES.length)
  })

  it('resolves styles by id', () => {
    for (const style of STYLES) {
      expect(getStyle(style.id)).toBe(style)
      expect(isStyleId(style.id)).toBe(true)
    }
    expect(getStyle('nope')).toBeUndefined()
    expect(isStyleId('nope')).toBe(false)
  })

  it('every style ships complete agent-facing content', () => {
    for (const style of STYLES) {
      expect(style.label.length).toBeGreaterThan(0)
      expect(style.description.length).toBeGreaterThan(0)
      // The bible is the consistency lever — it must be a substantial paragraph.
      expect(style.styleBible.length).toBeGreaterThan(100)
      expect(style.imageFragment.length).toBeGreaterThan(0)
      expect(style.videoFragment.length).toBeGreaterThan(0)
      expect(style.musicHint.length).toBeGreaterThan(0)
      expect(style.avoid.length).toBeGreaterThan(0)
    }
  })

  it('content is plain ASCII-safe prose (no stray non-latin characters)', () => {
    for (const style of STYLES) {
      const all = [
        style.styleBible,
        style.imageFragment,
        style.videoFragment,
        style.musicHint,
        style.avoid
      ].join(' ')
      expect(all).toMatch(/^[\x20-\x7EÀ-ſ’‘“”—–…]+$/)
    }
  })
})
