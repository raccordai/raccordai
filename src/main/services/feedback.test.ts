import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo, deleteVideo } from './videos'
import {
  createFeedbackItem,
  deleteFeedbackItem,
  getFeedbackItem,
  listFeedback,
  updateFeedbackItem
} from './feedback'

let videoId: string

beforeEach(() => {
  useTestDatabase()
  const project = createProject('P')
  videoId = createVideo(project.id, 'V').id
})

afterEach(() => resetTestDatabase())

describe('feedback bucket', () => {
  it('creates open notes with optional anchors and lists in creation order', () => {
    const first = createFeedbackItem({
      videoId,
      comment: 'Le ciel clignote sur la fin',
      timecodeSec: 12.4,
      nodeId: 'node-1',
      nodeLabel: 'Plan 3 — poursuite'
    })
    const second = createFeedbackItem({ videoId, comment: 'Note générale' })
    expect(first).toMatchObject({
      status: 'open',
      timecodeSec: 12.4,
      nodeId: 'node-1',
      nodeLabel: 'Plan 3 — poursuite'
    })
    expect(second).toMatchObject({ status: 'open', timecodeSec: null, nodeId: null })
    expect(listFeedback(videoId).map((f) => f.id)).toEqual([first.id, second.id])
    expect(() => createFeedbackItem({ videoId: 'nope', comment: 'x' })).toThrow(/Unknown videoId/)
  })

  it('marks a note done (and back) without touching the rest', () => {
    const note = createFeedbackItem({ videoId, comment: 'Trop sombre', timecodeSec: 3 })
    const done = updateFeedbackItem(note.id, { status: 'done' })
    expect(done).toMatchObject({ status: 'done', comment: 'Trop sombre', timecodeSec: 3 })
    expect(getFeedbackItem(note.id)?.status).toBe('done')
    expect(updateFeedbackItem(note.id, { status: 'open' }).status).toBe('open')
    expect(() => updateFeedbackItem('ghost', { status: 'done' })).toThrow(/Unknown feedback item/)
  })

  it('deletes a note, and the video cascade removes the rest', () => {
    const a = createFeedbackItem({ videoId, comment: 'A' })
    createFeedbackItem({ videoId, comment: 'B' })
    deleteFeedbackItem(a.id)
    deleteFeedbackItem(a.id) // idempotent
    expect(getFeedbackItem(a.id)).toBeNull()
    expect(listFeedback(videoId)).toHaveLength(1)

    deleteVideo(videoId)
    expect(listFeedback(videoId)).toHaveLength(0)
  })
})
