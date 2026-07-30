import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { graphNodeSchema } from '@shared/ipc/contracts'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { inArray } from 'drizzle-orm'
import { assets, edges } from '../db/schema'
import { createProject } from './projects'
import { createVideo, getVideo, setVideoDefaults } from './videos'
import { undoGraph } from './graphHistory'
import {
  applyVideoDefaultsToNodes,
  connectNodes,
  createNode,
  disconnectEdge,
  reorderEdges,
  exportWorkflow,
  importWorkflow,
  listGraph,
  removeNode,
  replaceNodeModel,
  setClipTransition,
  setClipTrim,
  setTimelineOrder,
  updateNodeIntent,
  updateNodeParams
} from './graph'

const SEEDANCE = 'bytedance/seedance-2-fast'
const GROK = 'grok-imagine-video-1-5-preview'

let db: Db
let videoId: string
let projectId: string

beforeEach(() => {
  db = useTestDatabase()
  projectId = createProject('Test project').id
  videoId = createVideo(projectId, 'Test video').id
})

afterEach(() => resetTestDatabase())

function insertAsset(key: string): string {
  const id = randomUUID()
  db.insert(assets)
    .values({
      id,
      projectId,
      key,
      name: key,
      kind: 'image',
      filePath: null,
      sourceUrl: 'https://example.com/x.png',
      createdAt: Date.now()
    })
    .run()
  return id
}

describe('createNode', () => {
  it('applies the model default params and validates against the IPC contract', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 10, y: 20 } })
    expect(node.params).toMatchObject({ duration: 15, resolution: '720p' })
    expect(node.position).toEqual({ x: 10, y: 20 })
    expect(graphNodeSchema.safeParse(node).success).toBe(true)
  })

  it('rejects unknown models', () => {
    expect(() => createNode({ videoId, modelId: 'nope', position: { x: 0, y: 0 } })).toThrow()
  })

  it('allows studio/asset nodes without a registry entry', () => {
    const node = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    expect(node.params).toEqual({})
  })

  it('regenerates the key when the requested one is taken', () => {
    const a = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 }, key: 'node_a' })
    const b = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 }, key: 'node_a' })
    expect(a.key).toBe('node_a')
    expect(b.key).not.toBe('node_a')
  })

  it('touches the parent video updatedAt', () => {
    const before = getVideo(videoId)!.updatedAt
    createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect(getVideo(videoId)!.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('drops a position-less node in a free slot instead of the origin', () => {
    // add_node without x/y used to land every node on (0,0).
    const first = createNode({ videoId, modelId: SEEDANCE })
    const second = createNode({ videoId, modelId: SEEDANCE })
    const third = createNode({ videoId, modelId: SEEDANCE })

    expect(second.position.x).toBeGreaterThan(first.position.x)
    expect(third.position.x).toBeGreaterThan(second.position.x)
    expect(new Set([first, second, third].map((n) => `${n.position.x}:${n.position.y}`)).size).toBe(
      3
    )
  })
})

describe('edges', () => {
  it('connectNodes is idempotent for an identical connection', () => {
    const src = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const args = {
      videoId,
      sourceNodeId: src.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    }
    const first = connectNodes(args)
    const second = connectNodes(args)
    expect(second.id).toBe(first.id)
    expect(listGraph(videoId).edges).toHaveLength(1)
  })

  it('disconnectEdge removes the edge', () => {
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
  })

  it('reorderEdges changes the createdAt sort order of one handle, undoable in one step', () => {
    const a = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const b = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const wire = (sourceNodeId: string) =>
      connectNodes({
        videoId,
        sourceNodeId,
        sourceHandle: 'output',
        targetNodeId: dst.id,
        targetHandle: 'reference_image_urls'
      })
    const e1 = wire(a.id)
    const e2 = wire(b.id)

    const order = () =>
      listGraph(videoId)
        .edges.filter((e) => e.targetHandle === 'reference_image_urls')
        .sort((x, y) => x.createdAt - y.createdAt)
        .map((e) => e.id)
    expect(order()).toEqual([e1.id, e2.id])

    reorderEdges({
      videoId,
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls',
      edgeIds: [e2.id, e1.id]
    })
    expect(order()).toEqual([e2.id, e1.id])

    undoGraph(videoId)
    expect(order()).toEqual([e1.id, e2.id])
  })

  it('reorderEdges keeps numbering unambiguous even when edges share a timestamp', () => {
    const a = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const b = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const e1 = connectNodes({
      videoId,
      sourceNodeId: a.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    })
    const e2 = connectNodes({
      videoId,
      sourceNodeId: b.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    })
    // Force a tie (both edges can land in the same millisecond in real use).
    db.update(edges)
      .set({ createdAt: 1000 })
      .where(inArray(edges.id, [e1.id, e2.id]))
      .run()

    reorderEdges({
      videoId,
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls',
      edgeIds: [e2.id, e1.id]
    })
    const reordered = listGraph(videoId)
      .edges.sort((x, y) => x.createdAt - y.createdAt)
      .map((e) => e.id)
    expect(reordered).toEqual([e2.id, e1.id])
    const stamps = listGraph(videoId).edges.map((e) => e.createdAt)
    expect(new Set(stamps).size).toBe(stamps.length)
  })

  it('reorderEdges rejects an edge list that is not a permutation of the handle', () => {
    const a = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const dst = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const e1 = connectNodes({
      videoId,
      sourceNodeId: a.id,
      sourceHandle: 'output',
      targetNodeId: dst.id,
      targetHandle: 'reference_image_urls'
    })
    expect(() =>
      reorderEdges({
        videoId,
        targetNodeId: dst.id,
        targetHandle: 'reference_image_urls',
        edgeIds: [e1.id, 'ghost-edge']
      })
    ).toThrow(/permutation/)
  })

  it('removeNode cascades its edges', () => {
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
    const graph = listGraph(videoId)
    expect(graph.nodes.map((n) => n.id)).toEqual([dst.id])
    expect(graph.edges).toHaveLength(0)
  })
})

describe('node updates', () => {
  it('updateNodeParams persists arbitrary params', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    updateNodeParams(node.id, { prompt: 'hello', duration: 8 })
    const stored = listGraph(videoId).nodes.find((n) => n.id === node.id)
    expect(stored?.params).toMatchObject({ prompt: 'hello', duration: 8 })
  })

  it('updateNodeIntent trims empty strings to null', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    updateNodeIntent(node.id, '  ')
    expect(listGraph(videoId).nodes[0]?.intent).toBeNull()
    updateNodeIntent(node.id, 'opening shot')
    expect(listGraph(videoId).nodes[0]?.intent).toBe('opening shot')
  })
})

describe('replaceNodeModel', () => {
  it('carries over shared param keys and resets the rest to the new defaults', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    updateNodeParams(node.id, { prompt: 'a dog running', duration: 12, generate_audio: false })
    replaceNodeModel(node.id, GROK)
    const updated = listGraph(videoId).nodes[0]!
    expect(updated.modelId).toBe(GROK)
    // Shared keys survive; seedance-only keys are gone; grok defaults fill in.
    expect(updated.params).toMatchObject({ prompt: 'a dog running', duration: 12 })
    expect(updated.params).not.toHaveProperty('generate_audio')
    expect(updated.params).toMatchObject({ aspect_ratio: 'auto' })
  })

  it('remaps input edges by accepted media kind and drops unmappable ones', () => {
    const image = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    const target = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    connectNodes({
      videoId,
      sourceNodeId: image.id,
      sourceHandle: 'output',
      targetNodeId: target.id,
      targetHandle: 'reference_image_urls'
    })
    const audio = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    connectNodes({
      videoId,
      sourceNodeId: audio.id,
      sourceHandle: 'output',
      targetNodeId: target.id,
      targetHandle: 'reference_audio_urls'
    })

    replaceNodeModel(target.id, GROK)

    const edges = listGraph(videoId).edges
    // Image edge remapped to grok's image_urls; audio edge dropped (no audio input).
    expect(edges).toHaveLength(1)
    expect(edges[0]?.targetHandle).toBe('image_urls')
    expect(edges[0]?.sourceNodeId).toBe(image.id)
  })

  it('keeps output edges whose handle exists on the new model', () => {
    const source = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const downstream = createNode({ videoId, modelId: GROK, position: { x: 0, y: 0 } })
    connectNodes({
      videoId,
      sourceNodeId: source.id,
      sourceHandle: 'lastFrame',
      targetNodeId: downstream.id,
      targetHandle: 'image_urls'
    })
    replaceNodeModel(source.id, GROK)
    expect(listGraph(videoId).edges).toHaveLength(1)
  })

  it('refuses to replace on asset nodes and unknown nodes', () => {
    const asset = createNode({ videoId, modelId: 'studio/asset', position: { x: 0, y: 0 } })
    expect(() => replaceNodeModel(asset.id, GROK)).toThrow()
    expect(() => replaceNodeModel('missing-id', GROK)).toThrow()
  })
})

describe('workflow export / import', () => {
  it('round-trips nodes, edges and asset references through JSON', () => {
    const assetId = insertAsset('hero-image')
    const assetNode = createNode({
      videoId,
      modelId: 'studio/asset',
      position: { x: 0, y: 0 },
      key: 'node_asset',
      params: { assetId }
    })
    const genNode = createNode({
      videoId,
      modelId: SEEDANCE,
      position: { x: 100, y: 0 },
      key: 'node_gen',
      label: 'Main shot',
      intent: 'hero running'
    })
    connectNodes({
      videoId,
      sourceNodeId: assetNode.id,
      sourceHandle: 'output',
      targetNodeId: genNode.id,
      targetHandle: 'reference_image_urls'
    })

    const exported = exportWorkflow(videoId)
    expect(exported.version).toBe(1)
    // Asset nodes are exported by portable key, never by local id.
    const exportedAsset = exported.nodes.find((n) => n.key === 'node_asset')
    expect(exportedAsset?.params).toEqual({ assetKey: 'hero-image' })
    expect(exported.assets.map((a) => a.key)).toEqual(['hero-image'])

    const targetVideo = createVideo(projectId, 'Copy')
    const counts = importWorkflow(targetVideo.id, JSON.stringify(exported), false)
    expect(counts).toEqual({ nodeCount: 2, edgeCount: 1 })

    const graph = listGraph(targetVideo.id)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    // The asset key resolved back to the project-local asset id.
    const importedAsset = graph.nodes.find((n) => n.key === 'node_asset')
    expect(importedAsset?.params).toEqual({ assetId })
    const importedGen = graph.nodes.find((n) => n.key === 'node_gen')
    expect(importedGen?.label).toBe('Main shot')
    expect(importedGen?.intent).toBe('hero running')
  })

  it('imports edges with strictly increasing createdAt (deterministic @Image numbering)', () => {
    // Reference aliases (@Image1, @Image2, …) number connections by edge createdAt:
    // the imported array order must be preserved even within one millisecond.
    const json = JSON.stringify({
      version: 1,
      nodes: [
        {
          key: 'ref',
          modelId: 'gpt-image-2-text-to-image',
          position: { x: 0, y: 0 },
          params: { prompt: 'design' }
        },
        { key: 'prev', modelId: SEEDANCE, position: { x: 0, y: 300 }, params: {} },
        { key: 'clip', modelId: SEEDANCE, position: { x: 400, y: 0 }, params: {} }
      ],
      edges: [
        { from: 'ref', to: 'clip', input: 'reference_image_urls', output: 'output' },
        { from: 'prev', to: 'clip', input: 'reference_image_urls', output: 'lastFrame' }
      ]
    })
    const target = createVideo(projectId, 'Ordered')
    importWorkflow(target.id, json, false)
    const graph = listGraph(target.id)
    const clipId = graph.nodes.find((n) => n.key === 'clip')!.id
    const incoming = graph.edges
      .filter((e) => e.targetNodeId === clipId)
      .sort((a, b) => a.createdAt - b.createdAt)
    expect(incoming).toHaveLength(2)
    // @Image1 = the design reference, @Image2 = the previous clip's last frame.
    expect(incoming[0]!.sourceHandle).toBe('output')
    expect(incoming[1]!.sourceHandle).toBe('lastFrame')
    expect(incoming[1]!.createdAt).toBeGreaterThan(incoming[0]!.createdAt)
  })

  it('replace=true wipes the existing graph first', () => {
    createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 }, key: 'node_old' })
    const exported = exportWorkflow(videoId)
    importWorkflow(videoId, JSON.stringify(exported), true)
    const keys = listGraph(videoId).nodes.map((n) => n.key)
    expect(keys).toEqual(['node_old'])
  })

  it('rejects invalid JSON with a clear error', () => {
    expect(() => importWorkflow(videoId, '{not json', false)).toThrowError(/Invalid JSON/)
  })

  it('lays out a workflow whose nodes carry no position', () => {
    // The assistant's #1 layout bug: no `position` on any node meant every one
    // of them was written at (0,0) and the graph imported as a single pile.
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { key: 'ref', modelId: SEEDANCE, params: {} },
        { key: 'shot_01', modelId: SEEDANCE, params: {} },
        { key: 'shot_02', modelId: SEEDANCE, params: {} },
        { key: 'shot_03', modelId: SEEDANCE, params: {} }
      ],
      edges: [
        { from: 'ref', to: 'shot_01', input: 'reference_image_urls' },
        { from: 'ref', to: 'shot_02', input: 'reference_image_urls' },
        { from: 'ref', to: 'shot_03', input: 'reference_image_urls' }
      ]
    })
    const target = createVideo(projectId, 'Unpositioned')
    importWorkflow(target.id, json, false)

    const placed = listGraph(target.id).nodes
    const spots = new Set(placed.map((n) => `${n.position.x}:${n.position.y}`))
    expect(spots.size).toBe(4)
    // The shared reference is upstream, so it sits left of every shot.
    const ref = placed.find((n) => n.key === 'ref')!
    for (const key of ['shot_01', 'shot_02', 'shot_03']) {
      expect(placed.find((n) => n.key === key)!.position.x).toBeGreaterThan(ref.position.x)
    }
  })

  it('keeps authored positions when the blueprint provides them', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { key: 'a', modelId: SEEDANCE, position: { x: 0, y: 0 }, params: {} },
        { key: 'b', modelId: SEEDANCE, position: { x: 420, y: 0 }, params: {} }
      ],
      edges: []
    })
    const target = createVideo(projectId, 'Authored')
    importWorkflow(target.id, json, false)

    const placed = listGraph(target.id).nodes
    expect(placed.find((n) => n.key === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(placed.find((n) => n.key === 'b')!.position).toEqual({ x: 420, y: 0 })
  })

  it('appends an import below the existing graph instead of on top of it', () => {
    createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 }, key: 'existing' })
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { key: 'new_a', modelId: SEEDANCE, position: { x: 0, y: 0 }, params: {} },
        { key: 'new_b', modelId: SEEDANCE, position: { x: 420, y: 0 }, params: {} }
      ],
      edges: []
    })
    importWorkflow(videoId, json, false)

    const placed = listGraph(videoId).nodes
    const existing = placed.find((n) => n.key === 'existing')!
    for (const key of ['new_a', 'new_b']) {
      expect(placed.find((n) => n.key === key)!.position.y).toBeGreaterThan(existing.position.y)
    }
  })

  it('rejects nodes without key/modelId and edges pointing at unknown keys', () => {
    expect(() =>
      importWorkflow(videoId, JSON.stringify({ nodes: [{ modelId: SEEDANCE }] }), false)
    ).toThrowError(/key/)
    expect(() =>
      importWorkflow(
        videoId,
        JSON.stringify({
          nodes: [{ key: 'a', modelId: SEEDANCE }],
          edges: [{ from: 'a', to: 'ghost', input: 'reference_image_urls' }]
        }),
        false
      )
    ).toThrowError(/unknown node key/)
  })

  it('rejects an asset key that does not exist in the project', () => {
    const json = JSON.stringify({
      nodes: [{ key: 'a', modelId: 'studio/asset', params: { assetKey: 'missing' } }],
      edges: []
    })
    expect(() => importWorkflow(videoId, json, false)).toThrowError(/missing/)
  })

  it('is transactional: a bad edge rolls back the imported nodes', () => {
    const json = JSON.stringify({
      nodes: [{ key: 'a', modelId: SEEDANCE }],
      edges: [{ from: 'a', to: 'ghost', input: 'x' }]
    })
    expect(() => importWorkflow(videoId, json, false)).toThrow()
    expect(listGraph(videoId).nodes).toHaveLength(0)
  })
})

describe('video defaults & style-at-payload markers (§4.5)', () => {
  it('seeds new nodes with the video defaults and the applyVideoStyle flag', () => {
    setVideoDefaults(videoId, { defaultAspectRatio: '9:16', defaultResolution: '480p' })
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect(node.params).toMatchObject({
      aspect_ratio: '9:16',
      resolution: '480p',
      applyVideoStyle: true
    })
  })

  it('skips defaults outside the model enum and never flags audio nodes', () => {
    // 1080p is not a seedance-2-fast resolution — the model default must survive.
    setVideoDefaults(videoId, { defaultAspectRatio: '9:16', defaultResolution: '1080p' })
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect(node.params).toMatchObject({ aspect_ratio: '9:16', resolution: '720p' })

    const music = createNode({ videoId, modelId: 'suno/generate-music', position: { x: 0, y: 0 } })
    expect('applyVideoStyle' in (music.params as Record<string, unknown>)).toBe(false)
  })

  it('takes caller-provided params verbatim (imports keep their exact payloads)', () => {
    setVideoDefaults(videoId, { defaultAspectRatio: '9:16' })
    const node = createNode({
      videoId,
      modelId: SEEDANCE,
      position: { x: 0, y: 0 },
      params: { prompt: 'x', aspect_ratio: '16:9' }
    })
    expect(node.params).toEqual({ prompt: 'x', aspect_ratio: '16:9' })
  })

  it('applyVideoDefaultsToNodes sweeps compatible nodes in ONE undoable step', () => {
    const a = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    const b = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    createNode({ videoId, modelId: 'suno/generate-music', position: { x: 0, y: 0 } })

    setVideoDefaults(videoId, { defaultAspectRatio: '9:16' })
    expect(applyVideoDefaultsToNodes(videoId)).toEqual({ updated: 2 })
    const params = (id: string) =>
      listGraph(videoId).nodes.find((n) => n.id === id)!.params as Record<string, unknown>
    expect(params(a.id).aspect_ratio).toBe('9:16')
    expect(params(b.id).aspect_ratio).toBe('9:16')

    // Second run is a no-op…
    expect(applyVideoDefaultsToNodes(videoId)).toEqual({ updated: 0 })

    // …and ONE undo restores every swept node at once.
    undoGraph(videoId)
    expect(params(a.id).aspect_ratio).toBe('16:9')
    expect(params(b.id).aspect_ratio).toBe('16:9')
  })

  it('replaceNodeModel carries the applyVideoStyle marker to the new visual model', () => {
    const node = createNode({ videoId, modelId: SEEDANCE, position: { x: 0, y: 0 } })
    expect((node.params as Record<string, unknown>).applyVideoStyle).toBe(true)
    replaceNodeModel(node.id, 'bytedance/seedance-2')
    const swapped = listGraph(videoId).nodes.find((n) => n.id === node.id)!
    expect((swapped.params as Record<string, unknown>).applyVideoStyle).toBe(true)
  })
})

describe('timeline editing (order / trim / transition)', () => {
  it('setTimelineOrder stamps every listed clip as ONE undo step', () => {
    const a = createNode({ videoId, modelId: SEEDANCE })
    const b = createNode({ videoId, modelId: SEEDANCE })
    const c = createNode({ videoId, modelId: SEEDANCE })
    setTimelineOrder(videoId, [c.id, a.id, b.id])

    const byId = new Map(listGraph(videoId).nodes.map((n) => [n.id, n]))
    expect(byId.get(c.id)?.timelineOrder).toBe(0)
    expect(byId.get(a.id)?.timelineOrder).toBe(1)
    expect(byId.get(b.id)?.timelineOrder).toBe(2)

    // One gesture, one undo step: all three stamps disappear together.
    undoGraph(videoId)
    const after = new Map(listGraph(videoId).nodes.map((n) => [n.id, n]))
    expect(after.get(c.id)?.timelineOrder).toBeNull()
    expect(after.get(a.id)?.timelineOrder).toBeNull()
    expect(after.get(b.id)?.timelineOrder).toBeNull()
  })

  it('setTimelineOrder refuses ids from another video', () => {
    const mine = createNode({ videoId, modelId: SEEDANCE })
    const otherVideo = createVideo(projectId, 'Other').id
    const foreign = createNode({ videoId: otherVideo, modelId: SEEDANCE })
    expect(() => setTimelineOrder(videoId, [mine.id, foreign.id])).toThrow(/does not belong/)
  })

  it('setClipTrim persists a valid window and rejects an inverted one', () => {
    const node = createNode({ videoId, modelId: SEEDANCE })
    setClipTrim(node.id, { trimStartSec: 1, trimEndSec: 5 })
    const row = listGraph(videoId).nodes.find((n) => n.id === node.id)!
    expect(row.trimStartSec).toBe(1)
    expect(row.trimEndSec).toBe(5)

    expect(() => setClipTrim(node.id, { trimStartSec: -1, trimEndSec: null })).toThrow(/≥ 0/)
    expect(() => setClipTrim(node.id, { trimStartSec: 5, trimEndSec: 3 })).toThrow(/after the/)

    // Nulls clear the window.
    setClipTrim(node.id, { trimStartSec: null, trimEndSec: null })
    const cleared = listGraph(videoId).nodes.find((n) => n.id === node.id)!
    expect(cleared.trimStartSec).toBeNull()
    expect(cleared.trimEndSec).toBeNull()
  })

  it('setClipTransition toggles the crossfade and undo restores the cut', () => {
    const node = createNode({ videoId, modelId: SEEDANCE })
    setClipTransition(node.id, 'crossfade')
    expect(listGraph(videoId).nodes.find((n) => n.id === node.id)?.transitionAfter).toBe(
      'crossfade'
    )
    undoGraph(videoId)
    expect(listGraph(videoId).nodes.find((n) => n.id === node.id)?.transitionAfter).toBeNull()
  })
})
