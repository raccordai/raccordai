import { join } from 'node:path'
import { createDatabase, setDatabaseForTests, type Db } from '@main/db/client'

/**
 * Opens a fresh in-memory SQLite database with the real drizzle migrations
 * applied, and injects it as the service-layer singleton. Call in beforeEach
 * so every test starts from an empty, fully-migrated schema.
 */
export function useTestDatabase(): Db {
  const db = createDatabase(':memory:', join(process.cwd(), 'drizzle'))
  setDatabaseForTests(db)
  return db
}

export function resetTestDatabase(): void {
  setDatabaseForTests(null)
}
