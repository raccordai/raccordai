import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clipFraming, clipTrim } from '@shared/timeline'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { getAsset, importAssetFromFile, listAssets } from './assets'
import { listGraph } from './graph'
import { undoGraph } from './graphHistory'
import { createProject } from './projects'
import { deriveShort, normalizeShortSegments } from './shorts'
import { createVideo, getVideo, setVideoStyle } from './videos'

let projectId: string
let sourceVideoId: string
let dir: string

beforeEach(() => {
  useTestDatabase()
  projectId = createProject('P').id
  sourceVideoId = createVideo(projectId, 'Film').id
  dir = mkdtempSync(join(tmpdir(), 'raccord-shorts-'))
})

afterEach(() => resetTestDatabase())

function writeRender(name = 'film.mp4'): string {
  const path = join(dir, name)
  writeFileSync(path, 'mp4-bytes')
  return path
}

describe('normalizeShortSegments', () => {
  it('preserves the caller order (narrative order, not chronology)', () => {
    expect(
      normalizeShortSegments([
        { startSec: 40, endSec: 44 },
        { startSec: 2, endSec: 6.5 }
      ])
    ).toEqual([
      { startSec: 40, endSec: 44 },
      { startSec: 2, endSec: 6.5 }
    ])
  })

  it('rejects empty lists, negative in-points and degenerate windows', () => {
    expect(() => normalizeShortSegments([])).toThrow(/At least one segment/)
    expect(() => normalizeShortSegments([{ startSec: -1, endSec: 3 }])).toThrow(/startSec/)
    expect(() => normalizeShortSegments([{ startSec: 3, endSec: 3 }])).toThrow(/endSec/)
    expect(() => normalizeShortSegments([{ startSec: 0, endSec: Number.NaN }])).toThrow(/endSec/)
    const many = Array.from({ length: 21 }, (_, i) => ({ startSec: i, endSec: i + 1 }))
    expect(() => normalizeShortSegments(many)).toThrow(/Too many segments/)
  })
})

describe('deriveShort', () => {
  it('imports the render as a video asset and builds one fill-framed clip per segment', () => {
    const { video, asset, nodeIds } = deriveShort({
      videoId: sourceVideoId,
      sourcePath: writeRender(),
      segments: [
        { startSec: 12, endSec: 18 },
        { startSec: 47.5, endSec: 52 }
      ]
    })

    expect(video.projectId).toBe(projectId)
    expect(video.name).toBe('Film — Short')
    expect(video.defaultAspectRatio).toBe('9:16')
    expect(getAsset(asset.id)).toMatchObject({ projectId, kind: 'video' })

    const { nodes } = listGraph(video.id)
    expect(nodes.map((n) => n.id)).toEqual(nodeIds)
    expect(nodes.map((n) => n.timelineOrder)).toEqual([0, 1])
    for (const node of nodes) {
      expect(node.modelId).toBe('studio/asset')
      expect(node.params).toMatchObject({ assetId: asset.id })
      expect(node.assetKind).toBe('video')
      expect(clipFraming(node)).toBe('fill')
    }
    expect(clipTrim(nodes[0]!)).toMatchObject({ start: 12, end: 18 })
    expect(clipTrim(nodes[1]!)).toMatchObject({ start: 47.5, end: 52 })
  })

  it('inherits the source style and honours an explicit title', () => {
    setVideoStyle(sourceVideoId, 'cinematic-realism')
    const { video } = deriveShort({
      videoId: sourceVideoId,
      sourcePath: writeRender(),
      segments: [{ startSec: 0, endSec: 4 }],
      title: 'Hook — la chute'
    })
    expect(video.name).toBe('Hook — la chute')
    expect(video.styleId).toBe('cinematic-realism')
  })

  it('derives from an EXTERNAL file with projectId only (no source video)', () => {
    const { video, asset } = deriveShort({
      projectId,
      sourcePath: writeRender('youtube-master.mp4'),
      segments: [{ startSec: 90, endSec: 118 }]
    })
    expect(video.projectId).toBe(projectId)
    expect(video.name).toBe('youtube-master — Short')
    expect(video.styleId).toBeNull()
    expect(video.defaultAspectRatio).toBe('9:16')
    expect(getAsset(asset.id)?.kind).toBe('video')
    const { nodes } = listGraph(video.id)
    expect(nodes).toHaveLength(1)
    expect(clipTrim(nodes[0]!)).toMatchObject({ start: 90, end: 118 })
    expect(clipFraming(nodes[0]!)).toBe('fill')
  })

  it('derives from an already-imported asset without re-importing the file', () => {
    const imported = importAssetFromFile(projectId, writeRender('master.mp4'))
    const first = deriveShort({
      assetId: imported.id,
      segments: [{ startSec: 5, endSec: 12 }]
    })
    const second = deriveShort({
      assetId: imported.id,
      segments: [{ startSec: 40, endSec: 55 }],
      title: 'Short 2'
    })
    expect(first.asset.id).toBe(imported.id)
    expect(second.asset.id).toBe(imported.id)
    expect(first.video.projectId).toBe(projectId)
    // ONE stored file serves both Shorts — no duplicate import.
    expect(listAssets(projectId)).toHaveLength(1)
    const { nodes } = listGraph(second.video.id)
    expect(nodes[0]!.params).toMatchObject({ assetId: imported.id })
  })

  it('rejects a non-video asset, a foreign asset and a missing source', () => {
    const still = join(dir, 'poster.png')
    writeFileSync(still, 'png-bytes')
    const image = importAssetFromFile(projectId, still)
    expect(() =>
      deriveShort({ assetId: image.id, segments: [{ startSec: 0, endSec: 2 }] })
    ).toThrow(/not a video/)
    expect(() => deriveShort({ assetId: 'ghost', segments: [{ startSec: 0, endSec: 2 }] })).toThrow(
      /Unknown assetId/
    )
    const other = createProject('Q')
    const foreign = importAssetFromFile(other.id, writeRender('other.mp4'))
    expect(() =>
      deriveShort({ projectId, assetId: foreign.id, segments: [{ startSec: 0, endSec: 2 }] })
    ).toThrow(/another project/)
    expect(() => deriveShort({ projectId, segments: [{ startSec: 0, endSec: 2 }] })).toThrow(
      /sourcePath .* assetId/
    )
  })

  it('requires a source: no videoId nor projectId, or an unknown projectId, refuse', () => {
    const path = writeRender()
    expect(() => deriveShort({ sourcePath: path, segments: [{ startSec: 0, endSec: 2 }] })).toThrow(
      /videoId .* projectId/
    )
    expect(() =>
      deriveShort({ projectId: 'ghost', sourcePath: path, segments: [{ startSec: 0, endSec: 2 }] })
    ).toThrow(/Unknown projectId/)
  })

  it('builds the whole graph as ONE undo step on the new video', () => {
    const { video } = deriveShort({
      videoId: sourceVideoId,
      sourcePath: writeRender(),
      segments: [
        { startSec: 0, endSec: 4 },
        { startSec: 8, endSec: 12 }
      ]
    })
    expect(listGraph(video.id).nodes).toHaveLength(2)
    undoGraph(video.id)
    expect(listGraph(video.id).nodes).toHaveLength(0)
  })

  it('rejects unknown videos, missing files and non-video sources', () => {
    const path = writeRender()
    expect(() =>
      deriveShort({ videoId: 'ghost', sourcePath: path, segments: [{ startSec: 0, endSec: 2 }] })
    ).toThrow(/Unknown videoId/)
    expect(() =>
      deriveShort({
        videoId: sourceVideoId,
        sourcePath: join(dir, 'nope.mp4'),
        segments: [{ startSec: 0, endSec: 2 }]
      })
    ).toThrow(/not found/)
    const still = join(dir, 'poster.png')
    writeFileSync(still, 'png-bytes')
    expect(() =>
      deriveShort({
        videoId: sourceVideoId,
        sourcePath: still,
        segments: [{ startSec: 0, endSec: 2 }]
      })
    ).toThrow(/must be a video/)
    // Nothing half-created on a validation failure that precedes the import.
    expect(getVideo(sourceVideoId)?.name).toBe('Film')
  })
})
