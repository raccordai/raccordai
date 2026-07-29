import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getStyle } from '@shared/styles/registry'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { assets } from '../db/schema'
import { createProject } from './projects'
import { createVideo, setVideoDefaults, setVideoStyle } from './videos'
import { createNode, listGraph } from './graph'
import { historyState, undoGraph } from './graphHistory'
import { createRecipeNode } from './recipes'

let db: Db
let videoId: string
let projectId: string

beforeEach(() => {
  db = useTestDatabase()
  projectId = createProject('Test project').id
  videoId = createVideo(projectId, 'Test video').id
})

afterEach(() => resetTestDatabase())

function insertAsset(kind: 'image' | 'video' = 'image'): string {
  const id = randomUUID()
  db.insert(assets)
    .values({
      id,
      projectId,
      key: `asset-${id.slice(0, 6)}`,
      name: 'Léa — sheet',
      kind,
      filePath: null,
      sourceUrl: 'https://example.com/x.png',
      createdAt: Date.now()
    })
    .run()
  return id
}

describe('createRecipeNode', () => {
  it('builds a design node with its prompt, markers and intent', () => {
    const result = createRecipeNode({
      videoId,
      recipeId: 'character',
      values: { description: 'Léa, pink hair', views: 'five-view' }
    })
    const node = listGraph(videoId).nodes.find((n) => n.id === result.nodeId)!
    const params = node.params as Record<string, unknown>
    expect(node.modelId).toBe('gpt-image-2-text-to-image')
    expect(params.prompt).toContain('Léa, pink hair')
    // The chosen option's fragment, not the default one.
    expect(params.prompt).toContain('five aligned views')
    expect(params.recipeId).toBe('character')
    expect(params.recipeMode).toBe('text')
    expect(params.designId).toBe('character')
    expect(params.designSubject).toBe('Léa, pink hair')
    expect(params.applyVideoStyle).toBe(true)
    expect(node.intent).toMatch(/reference/i)
    expect(result.sourceNodeId).toBeNull()
  })

  it('appends the video style fragment, never the bible (that is a run-time job)', () => {
    setVideoStyle(videoId, 'anime')
    const anime = getStyle('anime')!
    const { nodeId } = createRecipeNode({
      videoId,
      recipeId: 'decor',
      values: { description: 'a rooftop garden' }
    })
    const node = listGraph(videoId).nodes.find((n) => n.id === nodeId)!
    const prompt = String((node.params as Record<string, unknown>).prompt)
    expect(prompt).toContain(anime.imageFragment)
    expect(prompt).not.toContain(anime.styleBible)
  })

  it('never stamps the design marker on a shot preset', () => {
    // `designId` means "this output is a reference sheet" — on a clip it would
    // fire the frame-anchor guard and offer the shot to the design library.
    const { nodeId } = createRecipeNode({
      videoId,
      recipeId: 'shot-push-in',
      values: { description: 'Léa realises' }
    })
    const params = listGraph(videoId).nodes.find((n) => n.id === nodeId)!.params as Record<
      string,
      unknown
    >
    expect(params.recipeId).toBe('shot-push-in')
    expect('designId' in params).toBe(false)
  })

  it('ships a shot length that is the preset’s, not the model’s 15 s default', () => {
    const { nodeId } = createRecipeNode({
      videoId,
      recipeId: 'shot-insert',
      values: { description: 'droplets on brushed metal' }
    })
    const params = listGraph(videoId).nodes.find((n) => n.id === nodeId)!.params as Record<
      string,
      unknown
    >
    expect(params.duration).toBe(4)
  })

  it('follows the video format on a shot, keeps its own on a turnaround sheet', () => {
    setVideoDefaults(videoId, { defaultAspectRatio: '9:16', defaultResolution: '1080p' })
    const shot = createRecipeNode({
      videoId,
      recipeId: 'shot-locked-off',
      values: { description: 'the workshop door' }
    })
    const shotParams = listGraph(videoId).nodes.find((n) => n.id === shot.nodeId)!.params as Record<
      string,
      unknown
    >
    // A 9:16 project cannot have 16:9 shots.
    expect(shotParams.aspect_ratio).toBe('9:16')
    // …but a default the model does not offer is dropped, not forced: the Fast
    // tier caps at 720p, so the video's 1080p simply does not apply here.
    expect(shotParams.resolution).toBe('720p')

    const sheet = createRecipeNode({
      videoId,
      recipeId: 'character',
      values: { description: 'Léa' }
    })
    const sheetParams = listGraph(videoId).nodes.find((n) => n.id === sheet.nodeId)!
      .params as Record<string, unknown>
    // A turnaround is reference material: it keeps the format it reads best in.
    expect(sheetParams.aspect_ratio).toBe('16:9')
  })

  it('runs a shot preset on another supported tier when asked', () => {
    const { modelId } = createRecipeNode({
      videoId,
      recipeId: 'shot-orbit',
      modelId: 'bytedance/seedance-2',
      values: { description: 'the headphones' }
    })
    expect(modelId).toBe('bytedance/seedance-2')
  })

  it('creates the asset node, wires it to the derived handle, and undoes as ONE step', () => {
    const assetId = insertAsset()
    const before = listGraph(videoId).nodes.length
    const result = createRecipeNode({
      videoId,
      recipeId: 'wardrobe',
      modeId: 'from-image',
      values: { description: 'Léa', variants: 'city, rain, evening' },
      source: { assetId },
      position: { x: 800, y: 0 }
    })
    const graph = listGraph(videoId)
    expect(graph.nodes.length).toBe(before + 2)
    // gpt-image-2-image-to-image's only image input, resolved from the registry.
    expect(result.handleKey).toBe('input_urls')
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]!.targetNodeId).toBe(result.nodeId)
    expect(graph.edges[0]!.sourceNodeId).toBe(result.sourceNodeId)
    // The asset node sits in the column to the left of the recipe node.
    const source = graph.nodes.find((n) => n.id === result.sourceNodeId)!
    expect(source.position.x).toBeLessThan(800)

    expect(historyState(videoId).canUndo).toBe(true)
    undoGraph(videoId)
    const after = listGraph(videoId)
    expect(after.nodes.length).toBe(before)
    expect(after.edges).toHaveLength(0)
  })

  it('wires an existing node of the same video as the source', () => {
    const clip = createNode({
      videoId,
      modelId: 'bytedance/seedance-2-fast',
      position: { x: 0, y: 0 }
    })
    const result = createRecipeNode({
      videoId,
      recipeId: 'shot-extend',
      values: { description: 'Maya reaches the avenue' },
      source: { nodeId: clip.id }
    })
    expect(result.handleKey).toBe('reference_video_urls')
    expect(result.sourceNodeId).toBe(clip.id)
    expect(listGraph(videoId).edges).toHaveLength(1)
  })

  it('refuses a source-only mode with no source, and leaves the graph untouched', () => {
    const before = listGraph(videoId).nodes.length
    expect(() =>
      createRecipeNode({ videoId, recipeId: 'wardrobe', values: { description: 'Léa' } })
    ).toThrow(/needs a source/)
    expect(listGraph(videoId).nodes.length).toBe(before)
  })

  it('refuses a blank description, an unknown recipe, mode, model or source', () => {
    expect(() =>
      createRecipeNode({ videoId, recipeId: 'character', values: { description: '  ' } })
    ).toThrow(/requires a "description"/)
    expect(() => createRecipeNode({ videoId, recipeId: 'nope', values: {} })).toThrow(
      /Unknown recipe/
    )
    expect(() =>
      createRecipeNode({
        videoId,
        recipeId: 'character',
        modeId: 'from-video',
        values: { description: 'x' }
      })
    ).toThrow(/Unknown mode/)
    expect(() =>
      createRecipeNode({
        videoId,
        recipeId: 'character',
        modelId: 'bytedance/seedance-2',
        values: { description: 'x' }
      })
    ).toThrow(/runs on/)
    expect(() =>
      createRecipeNode({
        videoId,
        recipeId: 'wardrobe',
        modeId: 'from-image',
        values: { description: 'x' },
        source: { assetId: 'nope' }
      })
    ).toThrow(/Unknown source assetId/)
  })

  it('refuses a source node from another video', () => {
    const other = createVideo(projectId, 'Other').id
    const foreign = createNode({
      videoId: other,
      modelId: 'bytedance/seedance-2-fast',
      position: { x: 0, y: 0 }
    })
    expect(() =>
      createRecipeNode({
        videoId,
        recipeId: 'shot-extend',
        values: { description: 'x' },
        source: { nodeId: foreign.id }
      })
    ).toThrow(/does not belong to this video/)
  })
})
