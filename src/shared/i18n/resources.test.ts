import { describe, expect, it } from 'vitest'
import { resources } from './resources'

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      return flattenKeys(value as Record<string, unknown>, path)
    }
    return [path]
  })
}

/** Extracts i18next interpolation placeholders ({{port}}, {{count}}, …). */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
}

function leafEntries(obj: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      return leafEntries(value as Record<string, unknown>, path)
    }
    return [[path, String(value)] as [string, string]]
  })
}

// Guards the CLAUDE.md rule: every user-facing string exists in BOTH locales.
describe('locale parity fr/en', () => {
  it('has the exact same key set in fr and en', () => {
    const frKeys = flattenKeys(resources.fr.common).sort()
    const enKeys = flattenKeys(resources.en.common).sort()
    expect(enKeys).toEqual(frKeys)
  })

  it('uses the same interpolation placeholders in both locales', () => {
    const fr = new Map(leafEntries(resources.fr.common))
    for (const [key, enValue] of leafEntries(resources.en.common)) {
      const frValue = fr.get(key)
      expect(frValue, `key "${key}" missing in fr`).toBeDefined()
      expect(placeholders(enValue), `placeholders differ for "${key}"`).toEqual(
        placeholders(frValue!)
      )
    }
  })

  it('has no empty translation', () => {
    for (const locale of ['fr', 'en'] as const) {
      for (const [key, value] of leafEntries(resources[locale].common)) {
        expect(value.trim(), `${locale}:${key} is empty`).not.toBe('')
      }
    }
  })
})
