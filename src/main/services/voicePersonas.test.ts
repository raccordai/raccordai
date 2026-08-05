import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createNiche, deleteNiche } from './niches'
import {
  createVoicePersona,
  deleteVoicePersona,
  findVoicePersonaByName,
  getVoicePersona,
  listVoicePersonas,
  updateVoicePersona
} from './voicePersonas'

beforeEach(() => useTestDatabase())
afterEach(() => resetTestDatabase())

describe('voice personas', () => {
  it('creates, reads back and normalizes whitespace', () => {
    const persona = createVoicePersona({ name: '  Narrateur   FR ', voiceId: ' v-1 ' })
    expect(persona).toMatchObject({
      name: 'Narrateur FR',
      voiceId: 'v-1',
      description: null,
      nicheId: null
    })
    expect(getVoicePersona(persona.id)).toEqual(persona)
  })

  it('enforces case-insensitive unique names', () => {
    createVoicePersona({ name: 'Léa', voiceId: 'v-1' })
    expect(() => createVoicePersona({ name: 'léa', voiceId: 'v-2' })).toThrow(/already exists/)
  })

  it('rejects empty names and voice ids', () => {
    expect(() => createVoicePersona({ name: '  ', voiceId: 'v' })).toThrow(/empty/)
    expect(() => createVoicePersona({ name: 'X', voiceId: '  ' })).toThrow(/voiceId/)
  })

  it('scopes the list to a niche (its own + the unpinned ones), sorted by name', () => {
    const niche = createNiche({ name: 'Cuisine' })
    const other = createNiche({ name: 'Tech' })
    const global = createVoicePersona({ name: 'Zoé', voiceId: 'v-g' })
    const pinned = createVoicePersona({ name: 'Anna', voiceId: 'v-n', nicheId: niche.id })
    createVoicePersona({ name: 'Bob', voiceId: 'v-o', nicheId: other.id })

    expect(listVoicePersonas(niche.id).map((p) => p.id)).toEqual([pinned.id, global.id])
    expect(listVoicePersonas()).toHaveLength(3)
  })

  it('rejects an unknown nicheId', () => {
    expect(() => createVoicePersona({ name: 'X', voiceId: 'v', nicheId: 'nope' })).toThrow(
      /Unknown nicheId/
    )
  })

  it('finds by name case- and whitespace-insensitively', () => {
    const persona = createVoicePersona({ name: 'Narrateur FR', voiceId: 'v-1' })
    expect(findVoicePersonaByName('  narrateur   fr ')?.id).toBe(persona.id)
    expect(findVoicePersonaByName('inconnu')).toBeNull()
  })

  it('updates fields independently; null clears, undefined keeps', () => {
    const niche = createNiche({ name: 'Cuisine' })
    const persona = createVoicePersona({
      name: 'Léa',
      voiceId: 'v-1',
      description: 'calme',
      nicheId: niche.id
    })
    const renamed = updateVoicePersona(persona.id, { name: 'Léa V2' })
    expect(renamed).toMatchObject({ name: 'Léa V2', voiceId: 'v-1', description: 'calme' })
    const cleared = updateVoicePersona(persona.id, { description: null, nicheId: null })
    expect(cleared.description).toBeNull()
    expect(cleared.nicheId).toBeNull()
    expect(() => updateVoicePersona(persona.id, { voiceId: ' ' })).toThrow(/voiceId/)
    expect(() => updateVoicePersona('nope', {})).toThrow(/Unknown voice persona/)
  })

  it('keeps a renamed persona from colliding with another name', () => {
    createVoicePersona({ name: 'Léa', voiceId: 'v-1' })
    const other = createVoicePersona({ name: 'Marc', voiceId: 'v-2' })
    expect(() => updateVoicePersona(other.id, { name: 'LÉA' })).toThrow(/already exists/)
    // Re-saving its own name is not a collision.
    expect(updateVoicePersona(other.id, { name: 'Marc' }).name).toBe('Marc')
  })

  it('survives its niche being deleted (SET NULL)', () => {
    const niche = createNiche({ name: 'Cuisine' })
    const persona = createVoicePersona({ name: 'Anna', voiceId: 'v-n', nicheId: niche.id })
    deleteNiche(niche.id)
    expect(getVoicePersona(persona.id)?.nicheId).toBeNull()
  })

  it('deletes a persona', () => {
    const persona = createVoicePersona({ name: 'Léa', voiceId: 'v-1' })
    deleteVoicePersona(persona.id)
    expect(getVoicePersona(persona.id)).toBeNull()
    expect(listVoicePersonas()).toEqual([])
  })
})
