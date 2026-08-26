import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { generations } from '../db/schema'
import { createProject } from './projects'
import { createVideo } from './videos'
import { clearGraphHistory, undoGraph } from './graphHistory'
import { createNode, listGraph, setSelectedGeneration, updateNodeLabel } from './graph'
import {
  createCheckpoint,
  deleteCheckpoint,
  diffAgainstCurrent,
  listCheckpoints,
  restoreCheckpoint
} from './checkpoints'

const SEEDANCE = 'bytedance/seedance-2-fast'

let db: Db
let videoId: string

/** Inserts a successful generation for the node and returns its id. */
function addSuccess(nodeId: string): string {
  const id = randomUUID()
  db.insert(generations)
    .values({ id, nodeId, videoId, status: 'success', createdAt: Date.now() })
    .run()
  return id
}

beforeEach(() => {
  db = useTestDatabase()
  clearGraphHistory()
  videoId = createVideo(createProject('P').id, 'V').id
})

afterEach(() => resetTestDatabase())

describe('checkpoints', () => {
  it('creates, lists and deletes; an empty name throws', () => {
    expect(() => createCheckpoint(videoId, '   ')).toThrow()
    const cp = createCheckpoint(videoId, 'before rework')
    expect(listCheckpoints(videoId).map((c) => c.id)).toEqual([cp.id])
    expect(diffAgainstCurrent(cp.id).name).toBe('before rework')
    deleteCheckpoint(cp.id)
    expect(listCheckpoints(videoId)).toEqual([])
  })

  // THE checkpoint rule (§6.4): a restore replays the diff-restore, never a
  // wipe-and-reimport — surviving nodes keep their identity and their
  // generations. Restoring through importWorkflow(replace) would delete every
  // generation of the video; this test is what makes that regression loud.
  it('restore preserves the generations and selection of surviving nodes', () => {
    const keeper = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const genId = addSuccess(keeper.id)
    setSelectedGeneration(keeper.id, genId)

    const cp = createCheckpoint(videoId, 'capture')

    // Drift after the capture: a rename and a node that must go away.
    updateNodeLabel(keeper.id, 'renamed since capture')
    createNode({ videoId, modelId: SEEDANCE, position: { x: 100, y: 0 } })

    const result = restoreCheckpoint(cp.id)
    expect(result.selectionsRestored).toBe(1)
    expect(result.selectionsMissing).toBe(0)

    const graphNow = listGraph(videoId)
    expect(graphNow.nodes).toHaveLength(1)
    const restored = graphNow.nodes[0]!
    // Same row, same identity — not a re-created copy.
    expect(restored.id).toBe(keeper.id)
    expect(restored.selectedGenerationId).toBe(genId)
    // The generation row itself survived the restore.
    const gen = db.select().from(generations).all()
    expect(gen.map((g) => g.id)).toEqual([genId])
  })

  it('skips and counts selections whose generation was deleted since the capture', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const genId = addSuccess(node.id)
    setSelectedGeneration(node.id, genId)
    const cp = createCheckpoint(videoId, 'capture')

    // The output disappears after the capture (§6.4: deleted generations are
    // NOT restored — the node must come back unselected, not dangling).
    db.delete(generations).run()

    const result = restoreCheckpoint(cp.id)
    expect(result.selectionsRestored).toBe(0)
    expect(result.selectionsMissing).toBe(1)
    expect(listGraph(videoId).nodes[0]!.selectedGenerationId).toBeNull()
  })

  it('restore is ONE journaled step — a single undo walks back out of it', () => {
    const keeper = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const cp = createCheckpoint(videoId, 'capture')
    const extra = createNode({ videoId, modelId: SEEDANCE, position: { x: 100, y: 0 } })

    restoreCheckpoint(cp.id)
    expect(listGraph(videoId).nodes.map((n) => n.id)).toEqual([keeper.id])

    undoGraph(videoId)
    expect(new Set(listGraph(videoId).nodes.map((n) => n.id))).toEqual(
      new Set([keeper.id, extra.id])
    )
  })
})
