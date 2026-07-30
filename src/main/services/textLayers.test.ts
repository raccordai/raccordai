import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo, deleteVideo } from './videos'
import {
  createTextLayer,
  deleteTextLayer,
  getTextLayer,
  listTextLayers,
  updateTextLayer
} from './textLayers'

let videoId: string

beforeEach(() => {
  useTestDatabase()
  const project = createProject('P')
  videoId = createVideo(project.id, 'V').id
})

afterEach(() => resetTestDatabase())

describe('text layers', () => {
  it('creates with sensible defaults and lists in start order', () => {
    const late = createTextLayer({ videoId, content: 'Fin', startSec: 10, endSec: 12 })
    const early = createTextLayer({ videoId, content: 'Titre', startSec: 0, endSec: 3 })
    expect(late).toMatchObject({
      x: 0.5,
      y: 0.5,
      anchor: 5,
      fontFamily: null,
      sizePct: 6,
      bold: false,
      italic: false,
      colorHex: '#ffffff'
    })
    expect(listTextLayers(videoId).map((l) => l.id)).toEqual([early.id, late.id])
  })

  it('honours explicit styling and validates the timing', () => {
    const layer = createTextLayer({
      videoId,
      content: 'Chapitre 1',
      startSec: 1,
      endSec: 4,
      x: 0.1,
      y: 0.9,
      anchor: 1,
      fontFamily: 'Georgia',
      sizePct: 9,
      bold: true,
      italic: true,
      colorHex: '#ffcc00'
    })
    expect(layer.fontFamily).toBe('Georgia')
    expect(() => createTextLayer({ videoId, content: 'x', startSec: 5, endSec: 5 })).toThrow(
      /end after it starts/
    )
    expect(() =>
      createTextLayer({ videoId: 'nope', content: 'x', startSec: 0, endSec: 1 })
    ).toThrow(/Unknown videoId/)
  })

  it('updates a subset of fields and keeps timing valid', () => {
    const layer = createTextLayer({ videoId, content: 'Titre', startSec: 0, endSec: 3 })
    const moved = updateTextLayer(layer.id, { x: 0.2, y: 0.1, bold: true })
    expect(moved).toMatchObject({ x: 0.2, y: 0.1, bold: true, content: 'Titre' })
    expect(() => updateTextLayer(layer.id, { endSec: 0 })).toThrow(/end after it starts/)
    expect(() => updateTextLayer('ghost', { bold: true })).toThrow(/Unknown text layer/)
  })

  it('deletes a layer, and the video cascade removes the rest', () => {
    const a = createTextLayer({ videoId, content: 'A', startSec: 0, endSec: 1 })
    createTextLayer({ videoId, content: 'B', startSec: 1, endSec: 2 })
    deleteTextLayer(a.id)
    deleteTextLayer(a.id) // idempotent
    expect(getTextLayer(a.id)).toBeNull()
    expect(listTextLayers(videoId)).toHaveLength(1)

    deleteVideo(videoId)
    expect(listTextLayers(videoId)).toHaveLength(0)
  })
})
