import { describe, expect, it } from 'vitest'
import { assetMatchesQuery, nameMatchesQuery, normalizeTags } from './search'

const asset = {
  name: 'Forêt brumeuse',
  key: 'foret-brumeuse',
  description: 'Wide establishing shot of a misty forest',
  tags: ['nature', 'exterior']
}

describe('assetMatchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(assetMatchesQuery(asset, '')).toBe(true)
    expect(assetMatchesQuery(asset, '   ')).toBe(true)
  })

  it('is accent- and case-insensitive', () => {
    expect(assetMatchesQuery(asset, 'foret')).toBe(true)
    expect(assetMatchesQuery(asset, 'FORÊT')).toBe(true)
  })

  it('searches name, key, description and tags', () => {
    expect(assetMatchesQuery(asset, 'misty')).toBe(true)
    expect(assetMatchesQuery(asset, 'exterior')).toBe(true)
    expect(assetMatchesQuery(asset, 'foret-brumeuse')).toBe(true)
  })

  it('requires every term to match (AND semantics)', () => {
    expect(assetMatchesQuery(asset, 'misty nature')).toBe(true)
    expect(assetMatchesQuery(asset, 'misty spaceship')).toBe(false)
  })

  it('handles a null description', () => {
    expect(assetMatchesQuery({ ...asset, description: null }, 'misty')).toBe(false)
    expect(assetMatchesQuery({ ...asset, description: null }, 'nature')).toBe(true)
  })
})

describe('nameMatchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(nameMatchesQuery('Séquence 1', '')).toBe(true)
    expect(nameMatchesQuery('Séquence 1', '   ')).toBe(true)
  })

  it('is accent- and case-insensitive', () => {
    expect(nameMatchesQuery('Séquence finale', 'sequence')).toBe(true)
    expect(nameMatchesQuery('Séquence finale', 'SÉQUENCE')).toBe(true)
  })

  it('requires every term to match (AND semantics)', () => {
    expect(nameMatchesQuery('Séquence finale', 'sequence finale')).toBe(true)
    expect(nameMatchesQuery('Séquence finale', 'sequence intro')).toBe(false)
  })
})

describe('normalizeTags', () => {
  it('lowercases, strips accents, trims and deduplicates', () => {
    expect(normalizeTags([' Extérieur ', 'exterieur', 'NATURE', ''])).toEqual([
      'exterieur',
      'nature'
    ])
  })
})
