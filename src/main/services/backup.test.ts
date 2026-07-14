import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportBackup,
  extractBackupArchive,
  importBackup,
  readBackupManifest,
  restoreFromStaging,
  writeBackupArchive
} from './backup'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raccord-backup-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake userData layout: a db file + two media files in one project dir. */
function seedSource(): { dbPath: string; mediaRoot: string } {
  const root = tmp()
  const dbPath = join(root, 'raccord.db')
  writeFileSync(dbPath, 'SQLITE-BYTES')
  const mediaRoot = join(root, 'media')
  mkdirSync(join(mediaRoot, 'project-a'), { recursive: true })
  writeFileSync(join(mediaRoot, 'project-a', 'gen-1.mp4'), 'VIDEO-BYTES')
  writeFileSync(join(mediaRoot, 'project-a', 'gen-2.png'), 'IMAGE-BYTES')
  return { dbPath, mediaRoot }
}

describe('backup archive round-trip', () => {
  it('archives manifest + db + media and restores identical bytes', async () => {
    const { dbPath, mediaRoot } = seedSource()
    const outPath = join(tmp(), 'backup.raccord')

    const result = await writeBackupArchive({
      dbSnapshotPath: dbPath,
      mediaRoot,
      outPath,
      appVersion: '9.9.9'
    })
    expect(result.files).toBe(4) // manifest + db + 2 media
    expect(result.bytes).toBeGreaterThan(0)

    const staging = tmp()
    await extractBackupArchive(outPath, staging)

    const manifest = readBackupManifest(staging)
    expect(manifest.format).toBe('raccord-backup')
    expect(manifest.version).toBe(1)
    expect(manifest.appVersion).toBe('9.9.9')
    expect(readFileSync(join(staging, 'raccord.db'), 'utf8')).toBe('SQLITE-BYTES')
    expect(readFileSync(join(staging, 'media/project-a/gen-1.mp4'), 'utf8')).toBe('VIDEO-BYTES')
    expect(readFileSync(join(staging, 'media/project-a/gen-2.png'), 'utf8')).toBe('IMAGE-BYTES')
  })

  it('exports without a media directory (fresh install)', async () => {
    const dbPath = join(tmp(), 'raccord.db')
    writeFileSync(dbPath, 'DB')
    const outPath = join(tmp(), 'backup.raccord')

    const result = await writeBackupArchive({
      dbSnapshotPath: dbPath,
      mediaRoot: join(tmp(), 'does-not-exist'),
      outPath,
      appVersion: '1.0.0'
    })
    expect(result.files).toBe(2) // manifest + db
  })

  it('yields an empty staging for a non-zip file — caught by manifest validation', async () => {
    const archivePath = join(tmp(), 'garbage.raccord')
    writeFileSync(archivePath, 'this is not a zip file at all')
    const staging = tmp()
    // fflate's streaming Unzip skips unrecognized bytes instead of throwing:
    // the guard against foreign files is the manifest check that follows.
    await extractBackupArchive(archivePath, staging)
    expect(() => readBackupManifest(staging)).toThrow(/manifest.json is missing/)
  })

  it('rejects archives with path-traversal entries (zip-slip)', async () => {
    const evil = zipSync({ '../evil.txt': strToU8('pwned') })
    const archivePath = join(tmp(), 'evil.raccord')
    writeFileSync(archivePath, evil)

    await expect(extractBackupArchive(archivePath, tmp())).rejects.toThrow(/unsafe path/)
  })
})

describe('restoreFromStaging', () => {
  function seedStaging(manifest: object = { format: 'raccord-backup', version: 1 }): string {
    const staging = tmp()
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(staging, 'raccord.db'), 'NEW-DB')
    mkdirSync(join(staging, 'media', 'project-b'), { recursive: true })
    writeFileSync(join(staging, 'media', 'project-b', 'gen-9.mp4'), 'NEW-MEDIA')
    return staging
  }

  it('swaps the db (keeping a .bak) and merges media', () => {
    const staging = seedStaging()
    const live = tmp()
    const dbPath = join(live, 'raccord.db')
    writeFileSync(dbPath, 'OLD-DB')
    writeFileSync(`${dbPath}-wal`, 'STALE-WAL')
    const mediaRoot = join(live, 'media')
    mkdirSync(join(mediaRoot, 'project-a'), { recursive: true })
    writeFileSync(join(mediaRoot, 'project-a', 'kept.mp4'), 'LOCAL-ONLY')

    const { mediaFiles } = restoreFromStaging({ stagingDir: staging, dbPath, mediaRoot })

    expect(mediaFiles).toBe(1)
    expect(readFileSync(dbPath, 'utf8')).toBe('NEW-DB')
    // Previous db preserved, stale WAL removed.
    const bak = readdirSync(live).find((f) => f.startsWith('raccord.db.bak-'))
    expect(bak).toBeDefined()
    expect(readFileSync(join(live, bak as string), 'utf8')).toBe('OLD-DB')
    expect(readdirSync(live)).not.toContain('raccord.db-wal')
    // Media merged: restored file added, local-only file untouched.
    expect(readFileSync(join(mediaRoot, 'project-b', 'gen-9.mp4'), 'utf8')).toBe('NEW-MEDIA')
    expect(readFileSync(join(mediaRoot, 'project-a', 'kept.mp4'), 'utf8')).toBe('LOCAL-ONLY')
  })

  it('restores onto a fresh profile (no existing db)', () => {
    const staging = seedStaging()
    const live = tmp()
    const result = restoreFromStaging({
      stagingDir: staging,
      dbPath: join(live, 'raccord.db'),
      mediaRoot: join(live, 'media')
    })
    expect(result.mediaFiles).toBe(1)
    expect(readFileSync(join(live, 'raccord.db'), 'utf8')).toBe('NEW-DB')
  })

  it('refuses foreign or future archives before touching anything', () => {
    const live = tmp()
    const dbPath = join(live, 'raccord.db')
    writeFileSync(dbPath, 'OLD-DB')

    const noManifest = tmp()
    expect(() =>
      restoreFromStaging({ stagingDir: noManifest, dbPath, mediaRoot: join(live, 'media') })
    ).toThrow(/manifest.json is missing/)

    const wrongFormat = seedStaging({ format: 'other-app', version: 1 })
    expect(() =>
      restoreFromStaging({ stagingDir: wrongFormat, dbPath, mediaRoot: join(live, 'media') })
    ).toThrow(/unknown format/)

    const futureVersion = seedStaging({ format: 'raccord-backup', version: 2 })
    expect(() =>
      restoreFromStaging({ stagingDir: futureVersion, dbPath, mediaRoot: join(live, 'media') })
    ).toThrow(/newer Raccord/)

    // The live db was never touched by the failed attempts.
    expect(readFileSync(dbPath, 'utf8')).toBe('OLD-DB')
  })

  it('refuses a staging without database', () => {
    const live = tmp()
    const staging = tmp()
    writeFileSync(
      join(staging, 'manifest.json'),
      JSON.stringify({ format: 'raccord-backup', version: 1 })
    )
    expect(() =>
      restoreFromStaging({
        stagingDir: staging,
        dbPath: join(live, 'raccord.db'),
        mediaRoot: join(live, 'media')
      })
    ).toThrow(/raccord.db is missing/)
  })

  it('refuses an unreadable manifest', () => {
    const staging = tmp()
    writeFileSync(join(staging, 'manifest.json'), '{not json')
    expect(() => readBackupManifest(staging)).toThrow(/unreadable/)
  })
})

describe('importBackup (full flow)', () => {
  it('extracts, validates, restores and cleans its staging', async () => {
    const { dbPath, mediaRoot } = seedSource()
    const archivePath = join(tmp(), 'full.raccord')
    await writeBackupArchive({
      dbSnapshotPath: dbPath,
      mediaRoot,
      outPath: archivePath,
      appVersion: '1.0.0'
    })

    const live = tmp()
    const target = { dbPath: join(live, 'raccord.db'), mediaRoot: join(live, 'media') }
    const result = await importBackup(archivePath, target)

    expect(result.mediaFiles).toBe(2)
    expect(readFileSync(target.dbPath, 'utf8')).toBe('SQLITE-BYTES')
    expect(readFileSync(join(target.mediaRoot, 'project-a', 'gen-1.mp4'), 'utf8')).toBe(
      'VIDEO-BYTES'
    )
  })

  it('rejects a foreign archive without touching the target', async () => {
    const foreign = zipSync({ 'readme.txt': strToU8('hello') })
    const archivePath = join(tmp(), 'foreign.raccord')
    writeFileSync(archivePath, foreign)

    const live = tmp()
    const target = { dbPath: join(live, 'raccord.db'), mediaRoot: join(live, 'media') }
    await expect(importBackup(archivePath, target)).rejects.toThrow(/manifest.json is missing/)
    expect(readdirSync(live)).toEqual([])
  })
})

describe('exportBackup (live database)', () => {
  it('snapshots the open database into a valid archive', async () => {
    useTestDatabase()
    try {
      const outPath = join(tmp(), 'export.raccord')
      const result = await exportBackup(outPath)
      expect(result.files).toBeGreaterThanOrEqual(2) // manifest + db (+ media store if any)
      expect(result.bytes).toBeGreaterThan(0)

      const staging = tmp()
      await extractBackupArchive(outPath, staging)
      const manifest = readBackupManifest(staging)
      expect(manifest.appVersion).toBe('0.0.0-test')
      // The snapshot is a real SQLite file (magic header).
      const header = readFileSync(join(staging, 'raccord.db')).subarray(0, 15).toString('utf8')
      expect(header).toBe('SQLite format 3')
    } finally {
      resetTestDatabase()
    }
  })
})
