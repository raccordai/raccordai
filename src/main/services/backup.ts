import { once } from 'node:events'
import {
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { sql } from 'drizzle-orm'
import { app } from 'electron'
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import { closeDatabase, getDb, getDbPath } from '../db/client'

/**
 * Full application backup: one `.raccord` archive (a plain ZIP) containing
 *   - manifest.json  — format marker + versions, validated on restore
 *   - raccord.db     — consistent SQLite snapshot (VACUUM INTO)
 *   - media/**       — the whole managed media store, uncompressed (video/image
 *                      payloads don't deflate; STORE keeps export fast)
 *
 * The archive is streamed in and out (fflate Zip/Unzip): memory stays bounded
 * by the largest single media file, not by the archive size.
 *
 * NOTE: API keys travel as safeStorage-encrypted blobs inside the database —
 * they only decrypt on the machine that created them. After restoring on
 * another machine, keys must be re-entered in Integrations.
 */

export interface BackupManifest {
  format: 'raccord-backup'
  version: 1
  createdAt: number
  appVersion: string
}

const MANIFEST_NAME = 'manifest.json'
const DB_NAME = 'raccord.db'

// ── Pure core (path-parameterized, unit-tested) ──────────────────────────────

/** Every file under `root`, as POSIX-style paths relative to `root`. */
function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const abs = join(entry.parentPath, entry.name)
      return abs
        .slice(root.length + 1)
        .split(sep)
        .join('/')
    })
    .sort()
}

export async function writeBackupArchive(opts: {
  dbSnapshotPath: string
  mediaRoot: string
  outPath: string
  appVersion: string
}): Promise<{ files: number; bytes: number }> {
  const out = createWriteStream(opts.outPath)
  let files = 0

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err)
        return
      }
      out.write(Buffer.from(chunk))
      if (final) out.end(() => resolve())
    })

    const addEntry = (name: string, data: Uint8Array, compress: boolean): void => {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
      zip.add(entry)
      entry.push(data, true)
      files++
    }

    void (async () => {
      const manifest: BackupManifest = {
        format: 'raccord-backup',
        version: 1,
        createdAt: Date.now(),
        appVersion: opts.appVersion
      }
      addEntry(MANIFEST_NAME, strToU8(JSON.stringify(manifest, null, 2)), true)
      addEntry(DB_NAME, readFileSync(opts.dbSnapshotPath), true)
      for (const rel of listFilesRecursive(opts.mediaRoot)) {
        addEntry(`media/${rel}`, readFileSync(join(opts.mediaRoot, rel)), false)
        // One media file at a time: wait for the disk before reading the next.
        if (out.writableNeedDrain) await once(out, 'drain')
      }
      zip.end()
    })().catch(reject)
  })

  return { files, bytes: statSync(opts.outPath).size }
}

/** Streams the archive into `stagingDir` (guarding against zip-slip paths). */
export async function extractBackupArchive(archivePath: string, stagingDir: string): Promise<void> {
  mkdirSync(stagingDir, { recursive: true })
  const writes: Promise<void>[] = []

  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip((file) => {
      const rel = file.name.replaceAll('\\', '/')
      if (rel.endsWith('/')) return // directory entry
      const target = join(stagingDir, rel)
      if (target !== stagingDir && !target.startsWith(stagingDir + sep)) {
        reject(new Error(`Backup archive contains an unsafe path: "${file.name}"`))
        return
      }
      mkdirSync(dirname(target), { recursive: true })
      const fileOut = createWriteStream(target)
      writes.push(once(fileOut, 'close').then(() => undefined))
      file.ondata = (err, data, final) => {
        if (err) {
          reject(err)
          return
        }
        fileOut.write(Buffer.from(data))
        if (final) fileOut.end()
      }
      file.start()
    })
    unzip.register(UnzipInflate)

    const stream = createReadStream(archivePath)
    stream.on('data', (chunk) => unzip.push(chunk as Buffer, false))
    stream.on('end', () => {
      try {
        unzip.push(new Uint8Array(0), true)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
    stream.on('error', reject)
  })

  await Promise.all(writes)
}

export function readBackupManifest(stagingDir: string): BackupManifest {
  const manifestPath = join(stagingDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    throw new Error('Not a Raccord backup: manifest.json is missing')
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error('Not a Raccord backup: manifest.json is unreadable', { cause: err })
  }
  if (manifest.format !== 'raccord-backup') {
    throw new Error('Not a Raccord backup: unknown format')
  }
  if (manifest.version !== 1) {
    throw new Error(
      `This backup was created by a newer Raccord (format v${manifest.version}) — update the app first`
    )
  }
  return manifest
}

/**
 * Swaps the live data for the staged backup. Validates BEFORE touching
 * anything; the previous database is kept next to the new one as `*.bak-<ts>`.
 * Media is merged file-by-file (local files absent from the backup survive —
 * they are at worst orphans, never corruption).
 */
export function restoreFromStaging(opts: {
  stagingDir: string
  dbPath: string
  mediaRoot: string
}): { mediaFiles: number } {
  readBackupManifest(opts.stagingDir)
  const stagedDb = join(opts.stagingDir, DB_NAME)
  if (!existsSync(stagedDb)) {
    throw new Error('Not a Raccord backup: raccord.db is missing')
  }

  if (existsSync(opts.dbPath)) {
    renameSync(opts.dbPath, `${opts.dbPath}.bak-${Date.now()}`)
  }
  // Stale WAL sidecars would be replayed into the restored database.
  rmSync(`${opts.dbPath}-wal`, { force: true })
  rmSync(`${opts.dbPath}-shm`, { force: true })
  mkdirSync(dirname(opts.dbPath), { recursive: true })
  copyFileSync(stagedDb, opts.dbPath)

  const stagedMedia = join(opts.stagingDir, 'media')
  const mediaFiles = listFilesRecursive(stagedMedia)
  if (mediaFiles.length > 0) {
    cpSync(stagedMedia, opts.mediaRoot, { recursive: true, force: true })
  }
  return { mediaFiles: mediaFiles.length }
}

// ── Electron-facing operations ────────────────────────────────────────────────

function mediaRoot(): string {
  return join(app.getPath('userData'), 'media')
}

/** Consistent snapshot of the live database + full media store → `targetPath`. */
export async function exportBackup(targetPath: string): Promise<{ files: number; bytes: number }> {
  const snapshotPath = join(app.getPath('temp'), `raccord-snapshot-${Date.now()}.db`)
  // VACUUM INTO writes a compact, WAL-independent copy without locking writers.
  getDb().run(sql`VACUUM INTO ${snapshotPath}`)
  try {
    return await writeBackupArchive({
      dbSnapshotPath: snapshotPath,
      mediaRoot: mediaRoot(),
      outPath: targetPath,
      appVersion: app.getVersion()
    })
  } finally {
    rmSync(snapshotPath, { force: true })
  }
}

/**
 * Restores `archivePath` over the live data. The caller is responsible for
 * relaunching the app afterwards — the database connection is closed here and
 * every in-memory cache (queue, chat sessions, poller) is stale by design.
 * `target` overrides the live paths (unit tests only).
 */
export async function importBackup(
  archivePath: string,
  target?: { dbPath: string; mediaRoot: string }
): Promise<{ mediaFiles: number }> {
  const stagingDir = join(app.getPath('temp'), `raccord-restore-${Date.now()}`)
  try {
    await extractBackupArchive(archivePath, stagingDir)
    // Validate the staged content BEFORE closing the live database.
    readBackupManifest(stagingDir)
    if (!existsSync(join(stagingDir, DB_NAME))) {
      throw new Error('Not a Raccord backup: raccord.db is missing')
    }
    closeDatabase()
    return restoreFromStaging({
      stagingDir,
      dbPath: target?.dbPath ?? getDbPath(),
      mediaRoot: target?.mediaRoot ?? mediaRoot()
    })
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
