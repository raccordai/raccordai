import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { generations } from '../db/schema'
import { onGenerationSettled, type GenerationSettledEvent } from '../bus'
import { createProject } from './projects'
import { createVideo } from './videos'
import { createNode } from './graph'
import { cancelGeneration, cancelGenerationsForVideo, failGeneration } from './generationLifecycle'

const SEEDANCE = 'bytedance/seedance-2-fast'

let db: Db
let videoId: string
let nodeId: string

beforeEach(() => {
  db = useTestDatabase()
  const project = createProject('P')
  videoId = createVideo(project.id, 'V').id
  nodeId = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } }).id
})

afterEach(() => resetTestDatabase())

function seedGeneration(
  status: 'pending' | 'running' | 'success' | 'failed',
  genNodeId = nodeId
): string {
  const id = randomUUID()
  db.insert(generations).values({ id, nodeId: genNodeId, videoId, status, createdAt: 1 }).run()
  return id
}

function statusOf(id: string): { status: string; errorMessage: string | null } {
  const gen = db.select().from(generations).where(eq(generations.id, id)).get()
  if (!gen) throw new Error('generation row missing')
  return { status: gen.status, errorMessage: gen.errorMessage }
}

/** Collects settle events for the duration of `fn`. */
function collectSettles(fn: () => void): GenerationSettledEvent[] {
  const events: GenerationSettledEvent[] = []
  const off = onGenerationSettled((event) => events.push(event))
  try {
    fn()
  } finally {
    off()
  }
  return events
}

describe('failGeneration', () => {
  it('fails the row and emits a settle event (queue-slot release path)', () => {
    const id = seedGeneration('running')
    const events = collectSettles(() => failGeneration(id, 'boom'))
    expect(statusOf(id)).toEqual({ status: 'failed', errorMessage: 'boom' })
    expect(events).toEqual([
      {
        generationId: id,
        videoId,
        nodeId,
        status: 'failed',
        errorMessage: 'boom'
      }
    ])
  })
})

describe('cancelGeneration', () => {
  it('settles every in-flight run of the node and leaves settled rows alone', () => {
    const running = seedGeneration('running')
    const pending = seedGeneration('pending')
    const done = seedGeneration('success')
    const events = collectSettles(() => {
      expect(cancelGeneration(nodeId)).toEqual({ cancelled: true })
    })
    expect(statusOf(running).status).toBe('failed')
    expect(statusOf(pending).status).toBe('failed')
    expect(statusOf(done).status).toBe('success')
    expect(events).toHaveLength(2)
  })

  it('reports cancelled: false when nothing is in flight', () => {
    seedGeneration('success')
    expect(cancelGeneration(nodeId)).toEqual({ cancelled: false })
  })
})

describe('cancelGenerationsForVideo', () => {
  it('settles in-flight runs across every node of the video', () => {
    const otherNode = createNode({ videoId, modelId: SEEDANCE, position: { x: 100, y: 0 } }).id
    const a = seedGeneration('running')
    const b = seedGeneration('pending', otherNode)
    const done = seedGeneration('success', otherNode)
    const events = collectSettles(() => cancelGenerationsForVideo(videoId))
    expect(statusOf(a).status).toBe('failed')
    expect(statusOf(b).status).toBe('failed')
    expect(statusOf(done).status).toBe('success')
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.errorMessage === 'Cancelled: the video was deleted.')).toBe(true)
  })
})
