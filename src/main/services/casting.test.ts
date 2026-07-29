import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { assets } from '../db/schema'
import { createProject } from './projects'
import { createVideo } from './videos'
import { connectNodes, createNode, listGraph } from './graph'
import { historyState, undoGraph } from './graphHistory'
import {
  castRole,
  castingsUsingAsset,
  castingsOnVideo,
  createCasting,
  deleteCasting,
  getCasting,
  listCastings,
  planCastRole,
  updateCasting
} from './casting'

let db: Db
let projectId: string
let videoId: string

const SEEDANCE = 'bytedance/seedance-2-fast'
/** Seedance 1.5 has image inputs, but they are frame ANCHORS — never a role. */
const NO_REFERENCES = 'bytedance/seedance-1.5-pro'

beforeEach(() => {
  db = useTestDatabase()
  projectId = createProject('Test project').id
  videoId = createVideo(projectId, 'Test video').id
})

afterEach(() => resetTestDatabase())

function insertSheet(
  overrides: { name?: string; designId?: string | null; designSubject?: string | null } = {}
): string {
  const id = randomUUID()
  db.insert(assets)
    .values({
      id,
      projectId,
      key: `asset-${id.slice(0, 6)}`,
      name: overrides.name ?? 'Léa — character sheet',
      kind: 'image',
      filePath: null,
      sourceUrl: 'https://example.com/lea.png',
      designId: overrides.designId === undefined ? 'character' : overrides.designId,
      designSubject:
        overrides.designSubject === undefined ? 'Léa, 20, pink hair' : overrides.designSubject,
      createdAt: Date.now()
    })
    .run()
  return id
}

function shot(label: string, modelId = SEEDANCE): string {
  return createNode({ videoId, modelId, params: { prompt: `${label} plays out.` }, label }).id
}

const nodeById = (id: string) => listGraph(videoId).nodes.find((n) => n.id === id)!
const promptOf = (id: string) => String((nodeById(id).params as { prompt?: string }).prompt ?? '')

describe('createCasting', () => {
  it('names a sheet as a role and resolves the sheet markers', () => {
    const casting = createCasting({ projectId, name: '  Léa  ', assetId: insertSheet() })
    expect(casting.name).toBe('Léa')
    expect(casting.designId).toBe('character')
    expect(casting.designSubject).toBe('Léa, 20, pink hair')
    expect(listCastings(projectId).map((c) => c.name)).toEqual(['Léa'])
  })

  it('refuses two roles whose names differ only by case', () => {
    createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    expect(() => createCasting({ projectId, name: 'léa', assetId: insertSheet() })).toThrow(
      /already casts a role/i
    )
  })

  it('refuses an empty name, a foreign sheet and a non-image asset', () => {
    expect(() => createCasting({ projectId, name: '   ', assetId: insertSheet() })).toThrow(
      /needs a name/i
    )
    const other = createProject('Other').id
    expect(() => createCasting({ projectId: other, name: 'Léa', assetId: insertSheet() })).toThrow(
      /another project/i
    )

    const clipId = randomUUID()
    db.insert(assets)
      .values({
        id: clipId,
        projectId,
        key: 'clip',
        name: 'A clip',
        kind: 'video',
        createdAt: Date.now()
      })
      .run()
    expect(() => createCasting({ projectId, name: 'Léa', assetId: clipId })).toThrow(/image sheet/i)
  })
})

describe('updateCasting', () => {
  it('renames a role and re-points it at a regenerated sheet', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const better = insertSheet({ name: 'Léa v2', designSubject: 'Léa, 20, pink bob' })
    const updated = updateCasting(casting.id, {
      name: 'Léa Mercier',
      assetId: better,
      notes: ' red scarf '
    })
    expect(updated.name).toBe('Léa Mercier')
    expect(updated.assetName).toBe('Léa v2')
    expect(updated.designSubject).toBe('Léa, 20, pink bob')
    expect(updated.notes).toBe('red scarf')
  })

  it('still refuses a name another role already answers to', () => {
    createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const other = createCasting({ projectId, name: 'Marc', assetId: insertSheet({ name: 'Marc' }) })
    expect(() => updateCasting(other.id, { name: 'LÉA' })).toThrow(/already casts a role/i)
    // Keeping its own name is not a clash with itself.
    expect(updateCasting(other.id, { name: 'Marc', notes: 'beard' }).notes).toBe('beard')
  })
})

describe('castRole', () => {
  it('wires the sheet on every shot and declares the role in each prompt', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')
    const b = shot('Shot 02')

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.skipped).toEqual([])
    expect(result.cast.map((c) => c.nodeId).sort()).toEqual([a, b].sort())
    expect(result.cast.every((c) => c.alias === '@Image1')).toBe(true)

    // One asset node fans out to both shots — a role has one sheet.
    const graph = listGraph(videoId)
    const source = graph.nodes.find((n) => n.id === result.sourceNodeId)!
    expect(source.modelId).toBe('studio/asset')
    expect((source.params as { assetId: string }).assetId).toBe(casting.assetId)
    expect(graph.edges.filter((e) => e.sourceNodeId === source.id)).toHaveLength(2)
    expect(graph.edges.every((e) => e.targetHandle === 'reference_image_urls')).toBe(true)

    // The prompt keeps what it said and gains the identity contract.
    expect(promptOf(a)).toContain('Shot 01 plays out.')
    expect(promptOf(a)).toContain('@Image1 is LÉA')
    expect(promptOf(a)).toContain('Léa, 20, pink hair')
    expect(promptOf(a)).toMatch(/never appear on screen/i)
  })

  it('lands as ONE undo step — the user cast a role, they undo a role', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    const before = promptOf(a)

    castRole({ videoId, castingId: casting.id })
    expect(historyState(videoId).canUndo).toBe(true)

    undoGraph(videoId)

    const graph = listGraph(videoId)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([a, b].sort())
    expect(graph.edges).toEqual([])
    expect(promptOf(a)).toBe(before)
  })

  it('is idempotent: a second cast re-reports instead of double-wiring', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')

    castRole({ videoId, castingId: casting.id })
    const promptAfterFirst = promptOf(a)
    const again = castRole({ videoId, castingId: casting.id })

    expect(again.cast).toEqual([])
    expect(again.alreadyCast).toEqual([{ nodeId: a, alias: '@Image1' }])
    expect(listGraph(videoId).edges).toHaveLength(1)
    expect(promptOf(a)).toBe(promptAfterFirst)
  })

  it('costs no undo step when there is nothing to wire', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    castRole({ videoId, castingId: casting.id })
    undoGraph(videoId)
    const depth = historyState(videoId)

    // No shots left to cast: the second call must not journal an empty group.
    const result = castRole({ videoId, castingId: casting.id })
    expect(result.cast).toEqual([])
    expect(historyState(videoId)).toEqual(depth)
  })

  it('reuses an asset node already on the canvas rather than adding a second one', () => {
    const assetId = insertSheet()
    const casting = createCasting({ projectId, name: 'Léa', assetId })
    const existing = createNode({
      videoId,
      modelId: 'studio/asset',
      params: { assetId },
      label: 'Léa'
    }).id
    const a = shot('Shot 01')

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.sourceNodeId).toBe(existing)
    expect(listGraph(videoId).nodes.filter((n) => n.modelId === 'studio/asset')).toHaveLength(1)
    expect(promptOf(a)).toContain('@Image1 is LÉA')
  })

  it('detects a role already wired by hand and leaves the prompt alone', () => {
    const assetId = insertSheet()
    const casting = createCasting({ projectId, name: 'Léa', assetId })
    const source = createNode({ videoId, modelId: 'studio/asset', params: { assetId } }).id
    const a = shot('Shot 01')
    connectNodes({
      videoId,
      sourceNodeId: source,
      sourceHandle: 'output',
      targetNodeId: a,
      targetHandle: 'reference_image_urls'
    })
    const before = promptOf(a)

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.cast).toEqual([])
    expect(result.alreadyCast).toEqual([{ nodeId: a, alias: '@Image1' }])
    expect(promptOf(a)).toBe(before)
  })

  it('numbers the alias after the references the shot already carries', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const decor = insertSheet({ name: 'Décor', designId: 'decor' })
    const decorNode = createNode({
      videoId,
      modelId: 'studio/asset',
      params: { assetId: decor }
    }).id
    const a = shot('Shot 01')
    connectNodes({
      videoId,
      sourceNodeId: decorNode,
      sourceHandle: 'output',
      targetNodeId: a,
      targetHandle: 'reference_image_urls'
    })

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.cast).toEqual([{ nodeId: a, alias: '@Image2' }])
    expect(promptOf(a)).toContain('@Image2 is LÉA')
  })

  it('skips a shot whose model has no reference input, and casts the rest', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const ok = shot('Shot 01')
    const legacy = shot('Shot 02', NO_REFERENCES)

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.cast.map((c) => c.nodeId)).toEqual([ok])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.nodeId).toBe(legacy)
    expect(result.skipped[0]!.reason).toMatch(/no reference-image input/i)
    // The skipped shot's prompt is untouched — a skip costs nothing.
    expect(promptOf(legacy)).toBe('Shot 02 plays out.')
  })

  it('targets only the video shots by default', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const clip = shot('Shot 01')
    const sheetNode = createNode({
      videoId,
      modelId: 'gpt-image-2-text-to-image',
      params: { prompt: 'a sheet' },
      label: 'A still'
    }).id

    const result = castRole({ videoId, castingId: casting.id })

    expect(result.cast.map((c) => c.nodeId)).toEqual([clip])
    expect(promptOf(sheetNode)).toBe('a sheet')
  })

  it('casts onto an explicitly named still — a storyboard needs the role too', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const board = createNode({
      videoId,
      modelId: 'gpt-image-2-image-to-image',
      params: { prompt: 'nine panels' },
      label: 'Storyboard'
    }).id

    const result = castRole({ videoId, castingId: casting.id, nodeIds: [board] })

    expect(result.cast.map((c) => c.nodeId)).toEqual([board])
    expect(promptOf(board)).toContain('is LÉA')
  })

  it('rejects a role from another project and an unknown node', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const otherProject = createProject('Other').id
    const otherVideo = createVideo(otherProject, 'Other video').id
    expect(() => castRole({ videoId: otherVideo, castingId: casting.id })).toThrow(
      /another project/i
    )
    expect(() => castRole({ videoId, castingId: casting.id, nodeIds: ['nope'] })).toThrow(
      /Unknown nodeId/i
    )
  })
})

describe('planCastRole', () => {
  it('previews the same decisions without touching the graph', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')
    shot('Shot 02', NO_REFERENCES)

    const plan = planCastRole({ videoId, castingId: casting.id })

    expect(plan.name).toBe('Léa')
    expect(plan.sourceNodeId).toBeNull()
    expect(plan.cast.map((c) => c.nodeId)).toEqual([a])
    expect(plan.cast[0]!.label).toBe('Shot 01')
    expect(plan.cast[0]!.role).toContain('@Image1 is LÉA')
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]!.label).toBe('Shot 02')

    // Nothing moved: the preview is free.
    expect(listGraph(videoId).edges).toEqual([])
    expect(promptOf(a)).toBe('Shot 01 plays out.')
  })

  it('reports an already-cast shot rather than proposing it again', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')
    castRole({ videoId, castingId: casting.id })

    const plan = planCastRole({ videoId, castingId: casting.id })
    expect(plan.cast).toEqual([])
    expect(plan.alreadyCast).toEqual([{ nodeId: a, label: 'Shot 01', alias: '@Image1' }])
    expect(plan.sourceNodeId).not.toBeNull()
  })
})

describe('deleteCasting', () => {
  it('forgets the role without un-wiring the shots it already cast', () => {
    const casting = createCasting({ projectId, name: 'Léa', assetId: insertSheet() })
    const a = shot('Shot 01')
    castRole({ videoId, castingId: casting.id })
    const prompt = promptOf(a)

    deleteCasting(casting.id)

    expect(getCasting(casting.id)).toBeNull()
    expect(listGraph(videoId).edges).toHaveLength(1)
    expect(promptOf(a)).toBe(prompt)
  })
})

describe('castingsUsingAsset / castingsOnVideo', () => {
  it('names the roles a sheet answers to, and the roles present on a video', () => {
    const assetId = insertSheet()
    const casting = createCasting({ projectId, name: 'Léa', assetId })
    createCasting({ projectId, name: 'Marc', assetId: insertSheet({ name: 'Marc' }) })

    expect(castingsUsingAsset(assetId).map((c) => c.name)).toEqual(['Léa'])
    expect(castingsOnVideo(videoId, projectId)).toEqual([])

    shot('Shot 01')
    const result = castRole({ videoId, castingId: casting.id })
    expect(castingsOnVideo(videoId, projectId)).toEqual([
      { castingId: casting.id, nodeId: result.sourceNodeId }
    ])
  })
})
