import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { generations } from '../db/schema'
import { createProject } from './projects'
import { createVideo } from './videos'
import { createNode } from './graph'
import {
  deleteAsset,
  duplicateAssetGroups,
  getAsset,
  importAssetFromFile,
  importAssetFromUrl,
  listAssets,
  promoteGeneration,
  searchAssets,
  setAssetTags,
  updateAsset
} from './assets'

let db: Db
let projectId: string
let dir: string

beforeEach(() => {
  db = useTestDatabase()
  projectId = createProject('P').id
  dir = mkdtempSync(join(tmpdir(), 'raccord-assets-'))
})

afterEach(() => resetTestDatabase())

function writeMedia(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('asset import', () => {
  it('stores tags as [] and a content hash', () => {
    const asset = importAssetFromFile(projectId, writeMedia('Hero.png', 'png-bytes'))
    expect(asset.tags).toEqual([])
    expect(listAssets(projectId)).toHaveLength(1)
    // Same content elsewhere → same hash → grouped as duplicates below.
  })
})

describe('setAssetTags', () => {
  it('normalizes and persists tags', () => {
    const asset = importAssetFromFile(projectId, writeMedia('a.png', 'x'))
    setAssetTags(asset.id, [' Extérieur ', 'NATURE', 'nature'])
    expect(getAsset(asset.id)?.tags).toEqual(['exterieur', 'nature'])
  })
})

describe('searchAssets', () => {
  it('matches by name and tag with the shared semantics', () => {
    const forest = importAssetFromFile(projectId, writeMedia('foret.png', 'f'))
    const city = importAssetFromFile(projectId, writeMedia('ville.png', 'v'))
    setAssetTags(forest.id, ['nature'])

    expect(searchAssets(projectId, 'foret').map((a) => a.id)).toEqual([forest.id])
    expect(searchAssets(projectId, 'nature').map((a) => a.id)).toEqual([forest.id])
    expect(
      searchAssets(projectId, '')
        .map((a) => a.id)
        .sort()
    ).toEqual([forest.id, city.id].sort())
  })
})

describe('duplicateAssetGroups', () => {
  it('groups byte-identical files and leaves unique ones out', () => {
    const a = importAssetFromFile(projectId, writeMedia('one.png', 'same-bytes'))
    const b = importAssetFromFile(projectId, writeMedia('two.png', 'same-bytes'))
    importAssetFromFile(projectId, writeMedia('three.png', 'different'))

    const groups = duplicateAssetGroups(projectId)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sort()).toEqual([a.id, b.id].sort())
  })

  it('returns nothing when every file is unique', () => {
    importAssetFromFile(projectId, writeMedia('a.png', '1'))
    importAssetFromFile(projectId, writeMedia('b.png', '2'))
    expect(duplicateAssetGroups(projectId)).toEqual([])
  })

  it('scopes duplicate detection to the project', () => {
    const otherProject = createProject('Other').id
    importAssetFromFile(projectId, writeMedia('x.png', 'shared'))
    importAssetFromFile(otherProject, writeMedia('y.png', 'shared'))
    expect(duplicateAssetGroups(projectId)).toEqual([])
  })
})

describe('update / delete', () => {
  it('rejects unsupported files', () => {
    expect(() => importAssetFromFile(projectId, writeMedia('doc.txt', 'x'))).toThrowError(
      /Unsupported/
    )
  })

  it('suffixes the key when the slug collides', () => {
    const a = importAssetFromFile(projectId, writeMedia('Hero Shot.png', '1'))
    const b = importAssetFromFile(projectId, writeMedia('Hero Shot.jpg', '2'))
    expect(a.key).toBe('hero-shot')
    expect(b.key).toBe('hero-shot-2')
  })

  it('updates name and description', () => {
    const asset = importAssetFromFile(projectId, writeMedia('a.png', 'x'))
    updateAsset(asset.id, { name: 'Renamed', description: 'desc' })
    const updated = getAsset(asset.id)
    expect(updated?.name).toBe('Renamed')
    expect(updated?.description).toBe('desc')
  })

  it('deletes the row and the managed file', () => {
    const asset = importAssetFromFile(projectId, writeMedia('a.png', 'x'))
    expect(existsSync(asset.filePath!)).toBe(true)
    deleteAsset(asset.id)
    expect(getAsset(asset.id)).toBeNull()
    expect(existsSync(asset.filePath!)).toBe(false)
    // Deleting a missing asset is a no-op.
    expect(() => deleteAsset(asset.id)).not.toThrow()
  })
})

describe('importAssetFromUrl', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/img.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end('png-from-url')
      } else if (req.url === '/weird') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end('???')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterEach(() => server.close())

  it('downloads the media, stores it locally and keeps the source URL', async () => {
    const asset = await importAssetFromUrl(projectId, `${base}/img.png`, 'From web', 'a test')
    expect(asset.kind).toBe('image')
    expect(asset.name).toBe('From web')
    expect(asset.description).toBe('a test')
    expect(asset.sourceUrl).toBe(`${base}/img.png`)
    expect(existsSync(asset.filePath!)).toBe(true)
  })

  it('fails on HTTP errors and unsupported media types', async () => {
    await expect(importAssetFromUrl(projectId, `${base}/missing.png`)).rejects.toThrowError(/404/)
    await expect(importAssetFromUrl(projectId, `${base}/weird`)).rejects.toThrowError(/Unsupported/)
  })
})

describe('promoteGeneration', () => {
  function insertGeneration(overrides: Partial<typeof generations.$inferInsert>): string {
    const videoId = createVideo(projectId, 'V').id
    const node = createNode({
      videoId,
      modelId: 'bytedance/seedance-2-fast',
      position: { x: 0, y: 0 }
    })
    const id = randomUUID()
    db.insert(generations)
      .values({
        id,
        nodeId: node.id,
        videoId,
        status: 'success',
        createdAt: Date.now(),
        ...overrides
      })
      .run()
    return id
  }

  it('copies a locally-downloaded result into the library', async () => {
    const media = writeMedia('result.mp4', 'video-bytes')
    const genId = insertGeneration({ resultPath: media, resultMimeType: 'video/mp4' })
    const asset = await promoteGeneration(genId, 'Best take', 'the good one')
    expect(asset.kind).toBe('video')
    expect(asset.name).toBe('Best take')
    expect(existsSync(asset.filePath!)).toBe(true)
    expect(asset.filePath).not.toBe(media) // independent copy
  })

  it('refuses unfinished or missing generations', async () => {
    const genId = insertGeneration({ status: 'running' })
    await expect(promoteGeneration(genId, 'x')).rejects.toThrowError(/success/)
    await expect(promoteGeneration('missing', 'x')).rejects.toThrowError(/not found/)
  })

  it('refuses a success with no media at all', async () => {
    const genId = insertGeneration({ resultPath: null, resultUrl: null })
    await expect(promoteGeneration(genId, 'x')).rejects.toThrowError(/no media/)
  })
})
