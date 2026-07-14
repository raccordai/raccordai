import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { app } from 'electron'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

let db: Db | null = null
/** Raw connection behind `db` — kept for operations drizzle doesn't expose (close). */
let sqlite: Database.Database | null = null
let dbPath = ''

/** Opens (or creates) a database at `path` and applies pending migrations. */
export function createDatabase(path: string, migrationsFolder: string): Db {
  const conn = new Database(path)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')

  const database = drizzle(conn, { schema })
  migrate(database, { migrationsFolder })
  sqlite = conn
  return database
}

export function openDatabase(): Db {
  if (db) return db

  dbPath = join(app.getPath('userData'), 'raccord.db')
  const migrationsFolder = app.isPackaged
    ? join(process.resourcesPath, 'drizzle')
    : join(app.getAppPath(), 'drizzle')
  db = createDatabase(dbPath, migrationsFolder)

  return db
}

export function getDb(): Db {
  if (!db) throw new Error('Database accessed before openDatabase()')
  return db
}

export function getDbPath(): string {
  return dbPath
}

/** Closes the underlying SQLite connection (backup restore, shutdown). */
export function closeDatabase(): void {
  sqlite?.close()
  sqlite = null
  db = null
}

/** Test-only: inject an in-memory database so services run outside Electron. */
export function setDatabaseForTests(next: Db | null): void {
  db = next
}
