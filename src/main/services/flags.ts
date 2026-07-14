import { eq } from 'drizzle-orm'
import { flagRegistry, flagKeys, isFlagKey, type FlagKey } from '@shared/flags/registry'
import type { FlagState } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { flagOverrides } from '../db/schema'
import { getReleaseChannel } from '../env'

function getOverrides(): Map<string, boolean> {
  const rows = getDb().select().from(flagOverrides).all()
  return new Map(rows.map((row) => [row.key, row.enabled]))
}

export function isEnabled(key: FlagKey): boolean {
  const override = getOverrides().get(key)
  if (override !== undefined) return override
  return flagRegistry[key].defaults[getReleaseChannel()]
}

export function listFlags(): FlagState[] {
  const channel = getReleaseChannel()
  const overrides = getOverrides()
  return flagKeys.map((key) => {
    const defaultValue = flagRegistry[key].defaults[channel]
    const override = overrides.get(key)
    return {
      key,
      description: flagRegistry[key].description,
      enabled: override ?? defaultValue,
      defaultValue,
      overridden: override !== undefined
    }
  })
}

/** enabled=null clears the override and falls back to the channel default. */
export function setOverride(key: string, enabled: boolean | null): FlagState[] {
  if (!isFlagKey(key)) throw new Error(`Unknown feature flag: ${key}`)
  if (enabled === null) {
    getDb().delete(flagOverrides).where(eq(flagOverrides.key, key)).run()
  } else {
    getDb()
      .insert(flagOverrides)
      .values({ key, enabled })
      .onConflictDoUpdate({ target: flagOverrides.key, set: { enabled } })
      .run()
  }
  return listFlags()
}
