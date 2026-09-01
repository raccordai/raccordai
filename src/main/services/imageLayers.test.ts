import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo, deleteVideo } from './videos'
import { createNode } from './graph'
import {
  createImageLayer,
  deleteImageLayer,
  getImageLayer,
  listImageLayers,
  updateImageLayer
} from './imageLayers'

let videoId: string
let imageNodeId: string

beforeEach(() => {
  useTestDatabase()
  const project = createProject('P')
  videoId = createVideo(project.id, 'V').id
  imageNodeId = createNode({ videoId, modelId: 'studio/asset' }).id
})

afterEach(() => resetTestDatabase())

describe('image layers (sticker track)', () => {
  it('creates with sensible defaults and lists in start order', () => {
    const late = createImageLayer({ videoId, nodeId: imageNodeId, startSec: 10, endSec: 12 })
    const early = createImageLayer({ videoId, assetId: 'asset-1', startSec: 0, endSec: 3 })
    expect(late).toMatchObject({ x: 0.5, y: 0.5, widthPct: 25, nodeId: imageNodeId, assetId: null })
    expect(early).toMatchObject({ nodeId: null, assetId: 'asset-1' })
    expect(listImageLayers(videoId).map((l) => l.id)).toEqual([early.id, late.id])
  })

  it('requires exactly one image source', () => {
    expect(() => createImageLayer({ videoId, startSec: 0, endSec: 2 })).toThrow(/exactly one/)
    expect(() =>
      createImageLayer({ videoId, nodeId: 'n', assetId: 'a', startSec: 0, endSec: 2 })
    ).toThrow(/exactly one/)
  })

  it('refuses inverted timings on create and update', () => {
    expect(() =>
      createImageLayer({ videoId, nodeId: imageNodeId, startSec: 5, endSec: 5 })
    ).toThrow(/end after it starts/)
    const layer = createImageLayer({ videoId, nodeId: imageNodeId, startSec: 0, endSec: 3 })
    expect(() => updateImageLayer(layer.id, { startSec: 2, endSec: 1 })).toThrow(
      /end after it starts/
    )
  })

  it('strips immutable keys and rejects bad values on update', () => {
    const layer = createImageLayer({ videoId, nodeId: imageNodeId, startSec: 0, endSec: 3 })
    // A patch smuggling videoId or a source swap (MCP tools pass arguments
    // through) must not touch the immutable columns.
    const hostile = { videoId: 'other', nodeId: null, x: 0.3 } as Parameters<
      typeof updateImageLayer
    >[1]
    const updated = updateImageLayer(layer.id, hostile)
    expect(updated).toMatchObject({ videoId, nodeId: imageNodeId, x: 0.3 })
    const badType = { widthPct: 'wide' } as unknown as Parameters<typeof updateImageLayer>[1]
    expect(() => updateImageLayer(layer.id, badType)).toThrow()
  })

  it('updates timing/position/size and deletes', () => {
    const layer = createImageLayer({ videoId, nodeId: imageNodeId, startSec: 0, endSec: 3 })
    const updated = updateImageLayer(layer.id, { x: 0.2, y: 0.8, widthPct: 40, startSec: 1 })
    expect(updated).toMatchObject({ x: 0.2, y: 0.8, widthPct: 40, startSec: 1 })
    deleteImageLayer(layer.id)
    expect(getImageLayer(layer.id)).toBeNull()
    // Deleting a missing layer is a no-op, not an error.
    deleteImageLayer(layer.id)
  })

  it('cascades with its video', () => {
    createImageLayer({ videoId, nodeId: imageNodeId, startSec: 0, endSec: 3 })
    deleteVideo(videoId)
    expect(listImageLayers(videoId)).toEqual([])
  })
})
