import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clipFraming, clipTrim } from '@shared/timeline'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { getAsset } from './assets'
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
