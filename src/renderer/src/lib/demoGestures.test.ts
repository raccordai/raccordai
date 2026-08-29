import { describe, expect, it } from 'vitest'
import { normalizeQuery, pickGestureTarget, type GestureCandidate } from './demoGestures'

let seq = 0
const candidate = (over: Partial<GestureCandidate>): GestureCandidate => ({
  text: '',
  title: '',
  placeholder: '',
  area: 1000,
  index: (seq += 1),
  ...over
})

describe('normalizeQuery', () => {
  it('folds case, accents and whitespace', () => {
    expect(normalizeQuery('  Ajouter   un Nœud ')).toBe(
      'ajouter un nœud'.normalize('NFD').replace(/[̀-ͯ]/g, '')
    )
    expect(normalizeQuery('Créé')).toBe(normalizeQuery('cree'))
  })
})

describe('pickGestureTarget', () => {
  it('prefers an exact title (the locale-proof handle) over visible text', () => {
    const modelEntry = candidate({
      title: 'gpt-image-2-text-to-image',
      text: 'GPT Image 2 — Text to Image'
    })
    const other = candidate({ text: 'gpt-image-2-text-to-image explanation somewhere' })
    expect(pickGestureTarget([other, modelEntry], 'gpt-image-2-text-to-image')).toBe(modelEntry)
  })

  it('matches visible text case- and accent-insensitively', () => {
    const fr = candidate({ text: 'Ajouter un nœud' })
    expect(pickGestureTarget([fr], 'ajouter un noeud')).toBeNull() // œ ≠ oe — honest, not magic
    expect(pickGestureTarget([fr], 'AJOUTER UN NŒUD')).toBe(fr)
    expect(pickGestureTarget([candidate({ text: 'Créer' })], 'creer')).not.toBeNull()
  })

  it('exact text beats contains; placeholder is the last resort', () => {
    const exact = candidate({ text: 'Add node' })
    const contains = candidate({ text: 'Add node to the canvas now' })
    expect(pickGestureTarget([contains, exact], 'add node')).toBe(exact)

    const input = candidate({ placeholder: 'Filter models… (e.g. seedance, image)' })
    expect(pickGestureTarget([input], 'filter models')).toBe(input)
  })

  it('ties break on the smallest rect, then DOM order', () => {
    const big = candidate({ text: 'Run', area: 5000 })
    const small = candidate({ text: 'Run', area: 400 })
    expect(pickGestureTarget([big, small], 'run')).toBe(small)

    const first = candidate({ text: 'Run', area: 400 })
    const second = candidate({ text: 'Run', area: 400 })
    expect(pickGestureTarget([second, first], 'run')).toBe(first)
  })

  it('returns null on empty query or no match', () => {
    expect(pickGestureTarget([candidate({ text: 'Add node' })], '')).toBeNull()
    expect(pickGestureTarget([candidate({ text: 'Add node' })], 'timeline')).toBeNull()
  })
})
