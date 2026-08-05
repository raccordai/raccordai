import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { VoicePersona } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { niches, voicePersonas } from '../db/schema'
import { broadcastVoicePersonasChanged } from '../events'

/**
 * Voice personas (§8): the channel's named voice identities. The casting
 * service names who appears on screen — this names who SPEAKS, app-level so
 * the same narrator serves every video (the consistency the YouTube channel
 * needs). A persona resolves a NAME to an ElevenLabs voice id; the speech
 * models consume the id, the assistant and the dialogue voice map consume the
 * name. Same doctrine as casting: unique case-insensitive names, deleting a
 * persona touches no graph and no node.
 */

type PersonaRow = typeof voicePersonas.$inferSelect

function toPersona(row: PersonaRow): VoicePersona {
  return {
    id: row.id,
    name: row.name,
    voiceId: row.voiceId,
    description: row.description ?? null,
    nicheId: row.nicheId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ')
  if (normalized === '') throw new Error('Persona name cannot be empty.')
  return normalized
}

function assertNameFree(name: string, exceptId?: string): void {
  const clash = getDb()
    .select()
    .from(voicePersonas)
    .all()
    .find(
      (row) =>
        row.id !== exceptId &&
        row.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
    )
  if (clash) throw new Error(`A voice persona named "${clash.name}" already exists.`)
}

function assertNicheExists(nicheId: string): void {
  const row = getDb().select().from(niches).where(eq(niches.id, nicheId)).get()
  if (!row) throw new Error(`Unknown nicheId: ${nicheId}`)
}

/** All personas, or those usable for one niche (its own + the unpinned ones). */
export function listVoicePersonas(nicheId?: string): VoicePersona[] {
  const rows = getDb().select().from(voicePersonas).all()
  const scoped = nicheId ? rows.filter((r) => r.nicheId === null || r.nicheId === nicheId) : rows
  return scoped
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map(toPersona)
}

export function getVoicePersona(id: string): VoicePersona | null {
  const row = getDb().select().from(voicePersonas).where(eq(voicePersonas.id, id)).get()
  return row ? toPersona(row) : null
}

/** Case- and whitespace-insensitive name lookup — the dialogue voice map's resolver. */
export function findVoicePersonaByName(name: string): VoicePersona | null {
  const needle = name.trim().replace(/\s+/g, ' ')
  const row = getDb()
    .select()
    .from(voicePersonas)
    .all()
    .find((r) => r.name.localeCompare(needle, undefined, { sensitivity: 'base' }) === 0)
  return row ? toPersona(row) : null
}

export function createVoicePersona(input: {
  name: string
  voiceId: string
  description?: string | null
  nicheId?: string | null
}): VoicePersona {
  const name = normalizeName(input.name)
  assertNameFree(name)
  const voiceId = input.voiceId.trim()
  if (voiceId === '') throw new Error('Persona voiceId cannot be empty.')
  if (input.nicheId) assertNicheExists(input.nicheId)
  const now = Date.now()
  const row: PersonaRow = {
    id: randomUUID(),
    name,
    voiceId,
    description: input.description?.trim() || null,
    nicheId: input.nicheId ?? null,
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(voicePersonas).values(row).run()
  broadcastVoicePersonasChanged()
  return toPersona(row)
}

export function updateVoicePersona(
  id: string,
  patch: {
    name?: string
    voiceId?: string
    description?: string | null
    nicheId?: string | null
  }
): VoicePersona {
  const row = getDb().select().from(voicePersonas).where(eq(voicePersonas.id, id)).get()
  if (!row) throw new Error(`Unknown voice persona: ${id}`)
  const name = patch.name === undefined ? row.name : normalizeName(patch.name)
  if (patch.name !== undefined) assertNameFree(name, id)
  const voiceId = patch.voiceId === undefined ? row.voiceId : patch.voiceId.trim()
  if (voiceId === '') throw new Error('Persona voiceId cannot be empty.')
  if (patch.nicheId) assertNicheExists(patch.nicheId)
  const next: PersonaRow = {
    ...row,
    name,
    voiceId,
    description:
      patch.description === undefined ? row.description : patch.description?.trim() || null,
    nicheId: patch.nicheId === undefined ? row.nicheId : patch.nicheId,
    updatedAt: Date.now()
  }
  getDb().update(voicePersonas).set(next).where(eq(voicePersonas.id, id)).run()
  broadcastVoicePersonasChanged()
  return toPersona(next)
}

/** Forgetting a name — existing nodes keep their voice ids untouched. */
export function deleteVoicePersona(id: string): void {
  getDb().delete(voicePersonas).where(eq(voicePersonas.id, id)).run()
  broadcastVoicePersonasChanged()
}
