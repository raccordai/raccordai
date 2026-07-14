import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { and, asc, eq } from 'drizzle-orm'
import type { Asset } from '@shared/ipc/contracts'
import { assetMatchesQuery, normalizeTags } from '@shared/assets/search'
import { getDb } from '../db/client'
import { assets, generations, videos } from '../db/schema'
import {
  deleteMediaFile,
  importFileToStore,
  mediaDirFor,
  mediaKindFor,
  mimeTypeFor
} from '../media/files'

type AssetRow = typeof assets.$inferSelect

/** SHA-256 of a managed file — the duplicate-detection fingerprint. */
function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** Rows → IPC shape (tags default to [], internal columns are dropped downstream). */
function toAsset(row: AssetRow): Asset {
  return { ...row, tags: row.tags ?? [] }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Project-scoped unique key, e.g. "main-character", "main-character-2". */
function uniqueKeyFor(projectId: string, name: string): string {
  const base = slugify(name) || 'asset'
  const db = getDb()
  let key = base
  for (let n = 2; ; n += 1) {
    const clash = db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.key, key)))
      .get()
    if (!clash) return key
    key = `${base}-${n}`
  }
}

export function listAssets(projectId: string): Asset[] {
  return getDb()
    .select()
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .orderBy(asc(assets.createdAt))
    .all()
    .map(toAsset)
}

export function getAsset(id: string): Asset | null {
  const row = getDb().select().from(assets).where(eq(assets.id, id)).get()
  return row ? toAsset(row) : null
}

/** Same matching semantics as the renderer's instant filter (shared helper). */
export function searchAssets(projectId: string, query: string): Asset[] {
  return listAssets(projectId).filter((a) => assetMatchesQuery(a, query))
}

export function setAssetTags(id: string, tags: string[]): void {
  getDb()
    .update(assets)
    .set({ tags: normalizeTags(tags), updatedAt: Date.now() })
    .where(eq(assets.id, id))
    .run()
}

/**
 * Groups of asset ids sharing identical file content within the project
 * (only groups of 2+ are returned). Hashes missing on rows imported before
 * the content_hash column existed are backfilled lazily here.
 */
export function duplicateAssetGroups(projectId: string): string[][] {
  const db = getDb()
  const rows = db.select().from(assets).where(eq(assets.projectId, projectId)).all()

  const byHash = new Map<string, string[]>()
  for (const row of rows) {
    let hash = row.contentHash
    if (!hash && row.filePath) {
      try {
        hash = hashFile(row.filePath)
        db.update(assets).set({ contentHash: hash }).where(eq(assets.id, row.id)).run()
      } catch {
        continue // file missing on disk — nothing to compare
      }
    }
    if (!hash) continue
    const group = byHash.get(hash) ?? []
    group.push(row.id)
    byHash.set(hash, group)
  }
  return [...byHash.values()].filter((group) => group.length > 1)
}

export function importAssetFromFile(projectId: string, sourcePath: string): Asset {
  const kind = mediaKindFor(sourcePath)
  if (!kind) throw new Error(`Unsupported media file: ${basename(sourcePath)}`)

  const id = randomUUID()
  const name = basename(sourcePath, extname(sourcePath))
  const { filePath, size } = importFileToStore(projectId, id, sourcePath)
  const row: AssetRow = {
    id,
    projectId,
    key: uniqueKeyFor(projectId, name),
    name,
    description: null,
    kind,
    filePath,
    sourceUrl: null,
    mimeType: mimeTypeFor(sourcePath),
    size,
    uploadedUrl: null,
    uploadedAt: null,
    tags: [],
    contentHash: hashFile(filePath),
    createdAt: Date.now(),
    updatedAt: null
  }
  getDb().insert(assets).values(row).run()
  return toAsset(row)
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a'
}

/**
 * Download a remote media URL into the managed store and register it as an
 * asset (local-first: no remote reference that can expire).
 */
export async function importAssetFromUrl(
  projectId: string,
  url: string,
  name?: string,
  description?: string
): Promise<Asset> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null
  const urlPath = new URL(url).pathname
  const ext = (mimeType && EXT_BY_MIME[mimeType]) || extname(urlPath).toLowerCase() || ''
  const kind = mimeType?.startsWith('image/')
    ? ('image' as const)
    : mimeType?.startsWith('video/')
      ? ('video' as const)
      : mimeType?.startsWith('audio/')
        ? ('audio' as const)
        : mediaKindFor(urlPath)
  if (!kind) throw new Error(`Unsupported media type "${mimeType ?? 'unknown'}" for ${url}`)

  const id = randomUUID()
  const bytes = new Uint8Array(await res.arrayBuffer())
  const filePath = join(mediaDirFor(projectId), `${id}${ext}`)
  writeFileSync(filePath, bytes)

  const resolvedName = name?.trim() || basename(urlPath, extname(urlPath)) || 'asset'
  const row: AssetRow = {
    id,
    projectId,
    key: uniqueKeyFor(projectId, resolvedName),
    name: resolvedName,
    description: description?.trim() || null,
    kind,
    filePath,
    sourceUrl: url,
    mimeType: mimeType ?? mimeTypeFor(filePath),
    size: bytes.byteLength,
    uploadedUrl: null,
    uploadedAt: null,
    tags: [],
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    createdAt: Date.now(),
    updatedAt: null
  }
  getDb().insert(assets).values(row).run()
  return toAsset(row)
}

/**
 * Copy a successful generation's media into the asset library as an
 * independent file (so deleting either side never breaks the other).
 */
export async function promoteGeneration(
  generationId: string,
  name: string,
  description?: string
): Promise<Asset> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen) throw new Error('Generation not found')
  if (gen.status !== 'success') {
    throw new Error('Generation must be in success state before it can be promoted.')
  }
  const video = db.select().from(videos).where(eq(videos.id, gen.videoId)).get()
  if (!video) throw new Error('Video not found')

  const id = randomUUID()
  let filePath: string
  let mimeType: string | null
  let size: number

  if (gen.resultPath) {
    const ext = extname(gen.resultPath)
    filePath = join(mediaDirFor(video.projectId), `${id}${ext}`)
    copyFileSync(gen.resultPath, filePath)
    mimeType = gen.resultMimeType ?? mimeTypeFor(gen.resultPath)
    size = statSync(filePath).size
  } else if (gen.resultUrl) {
    const res = await fetch(gen.resultUrl)
    if (!res.ok) throw new Error(`Failed to fetch generation media: HTTP ${res.status}`)
    mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? gen.resultMimeType
    const bytes = new Uint8Array(await res.arrayBuffer())
    const ext =
      mimeType && mimeType.includes('/') ? `.${mimeType.split('/')[1]?.replace('jpeg', 'jpg')}` : ''
    filePath = join(mediaDirFor(video.projectId), `${id}${ext}`)
    writeFileSync(filePath, bytes)
    size = bytes.byteLength
  } else {
    throw new Error('Generation has no media — wait for it to finish, then retry.')
  }

  const kind: Asset['kind'] = mimeType?.startsWith('image/')
    ? 'image'
    : mimeType?.startsWith('video/')
      ? 'video'
      : 'audio'

  const row: AssetRow = {
    id,
    projectId: video.projectId,
    key: uniqueKeyFor(video.projectId, name),
    name,
    description: description ?? null,
    kind,
    filePath,
    sourceUrl: null,
    mimeType,
    size,
    uploadedUrl: null,
    uploadedAt: null,
    tags: [],
    contentHash: hashFile(filePath),
    createdAt: Date.now(),
    updatedAt: null
  }
  db.insert(assets).values(row).run()
  return toAsset(row)
}

export function updateAsset(
  id: string,
  patch: { name?: string; description?: string | null }
): void {
  getDb()
    .update(assets)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(assets.id, id))
    .run()
}

export function deleteAsset(id: string): void {
  const asset = getAsset(id)
  if (!asset) return
  deleteMediaFile(asset.filePath)
  getDb().delete(assets).where(eq(assets.id, id)).run()
}
