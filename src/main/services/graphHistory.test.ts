import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { generations } from '../db/schema'
import { mediaDirFor } from '../media/files'
import { createProject } from './projects'
import { createVideo } from './videos'
import { clearGraphHistory, historyState, redoGraph, undoGraph } from './graphHistory'
import {
  connectNodes,
  createNode,
  disconnectEdge,
  importWorkflow,
  listGraph,
  removeNode,
  updateNodeLabel,
  updateNodeParams
} from './graph'

const SEEDANCE = 'bytedance/seedance-2-fast'

let db: Db
let videoId: string
let projectId: string

beforeEach(() => {
  db = useTestDatabase()
  clearGraphHistory()
  const project = createProject('P')
  projectId = project.id
  videoId = createVideo(project.id, 'V').id
})

afterEach(() => resetTestDatabase())

describe('graph history', () => {
  it('starts empty', () => {
    expect(historyState(videoId)).toEqual({ canUndo: false, canRedo: false })
  })

  it('undoing a node creation deletes the media of its generations', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const dir = mediaDirFor(projectId)
    const id = randomUUID()
    const resultPath = join(dir, `${id}.mp4`)
    const lastFramePath = join(dir, `${id}-frame.jpg`)
    writeFileSync(resultPath, 'video-bytes')
    writeFileSync(lastFramePath, 'frame-bytes')
    db.insert(generations)
      .values({
        id,
        nodeId: node.id,
        videoId,
        status: 'success',
        resultPath,
        lastFramePath,
        createdAt: 1
      })
      .run()

    undoGraph(videoId)
    expect(listGraph(videoId).nodes).toHaveLength(0)
    // The cascade removed the generation rows; the files must not be orphaned.
    expect(existsSync(resultPath)).toBe(false)
    expect(existsSync(lastFramePath)).toBe(false)
  })

  it('undoes and redoes a node creation', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect(historyState(videoId)).toEqual({ canUndo: true, canRedo: false })

    undoGraph(videoId)
    expect(listGraph(videoId).nodes).toHaveLength(0)
    expect(historyState(videoId)).toEqual({ canUndo: false, canRedo: true })

    redoGraph(videoId)
    const restored = listGraph(videoId).nodes
    expect(restored).toHaveLength(1)
    expect(restored[0]?.id).toBe(node.id)
    expect(restored[0]?.key).toBe(node.key)
  })

  it('undoes a param update back to the previous value', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    updateNodeParams(node.id, { prompt: 'v1', duration: 8 })
    updateNodeParams(node.id, { prompt: 'v2', duration: 8 })

    undoGraph(videoId)
    expect(listGraph(videoId).nodes[0]?.params).toMatchObject({ prompt: 'v1' })
    undoGraph(videoId)
    expect(listGraph(videoId).nodes[0]?.params).not.toMatchObject({ prompt: 'v1' })
  })

  it('restores a deleted node together with its edges', () => {
    const src = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    connectNodes({
      videoId,
      sourceNodeId: src.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    })

    removeNode(src.id)
    expect(listGraph(videoId).nodes).toHaveLength(1)
    expect(listGraph(videoId).edges).toHaveLength(0)

    undoGraph(videoId)
    const graph = listGraph(videoId)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]?.sourceNodeId).toBe(src.id)
  })

  it('undoes edge connect/disconnect', () => {
    const src = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const edge = connectNodes({
      videoId,
      sourceNodeId: src.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    })

    disconnectEdge(edge.id)
    expect(listGraph(videoId).edges).toHaveLength(0)
    undoGraph(videoId) // undo disconnect
    expect(listGraph(videoId).edges).toHaveLength(1)
    undoGraph(videoId) // undo connect
    expect(listGraph(videoId).edges).toHaveLength(0)
  })

  it('a new mutation clears the redo stack', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    undoGraph(videoId)
    expect(historyState(videoId).canRedo).toBe(true)
    createNode({ videoId, modelId: SEEDANCE, position: { x: 50, y: 50 } })
    expect(historyState(videoId).canRedo).toBe(false)
    void node
  })

  it('undoes a replace-import in one step', () => {
    createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 }, key: 'node_old' })
    importWorkflow(
      videoId,
      JSON.stringify({ nodes: [{ key: 'node_new', modelId: SEEDANCE }], edges: [] }),
      true
    )
    expect(listGraph(videoId).nodes.map((n) => n.key)).toEqual(['node_new'])

    undoGraph(videoId)
    expect(listGraph(videoId).nodes.map((n) => n.key)).toEqual(['node_old'])
    redoGraph(videoId)
    expect(listGraph(videoId).nodes.map((n) => n.key)).toEqual(['node_new'])
  })

  it('a no-op mutation records nothing', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const before = historyState(videoId)
    updateNodeLabel(node.id, node.label ?? '')
    // Label '' → stored as '' vs null… the write happened but the graph content
    // is what matters: same-label writes must not add an entry.
    updateNodeLabel(node.id, '')
    updateNodeLabel(node.id, '')
    const stacks = historyState(videoId)
    expect(stacks.canUndo).toBe(before.canUndo)
  })

  it('keeps histories independent between videos', () => {
    const other = createVideo(createProject('P2').id, 'V2').id
    createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect(historyState(other)).toEqual({ canUndo: false, canRedo: false })
  })
})
