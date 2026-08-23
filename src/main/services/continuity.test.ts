import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo } from './videos'
import { historyState, undoGraph } from './graphHistory'
import { createNode, listGraph } from './graph'
import { linkShots, planLinkShots } from './continuity'

const SEEDANCE = 'bytedance/seedance-2-fast'
const SEEDANCE_15 = 'bytedance/seedance-1.5-pro'
const IMAGE = 'gpt-image-2-text-to-image'

let videoId: string

beforeEach(() => {
  useTestDatabase()
  const projectId = createProject('Test project').id
  videoId = createVideo(projectId, 'Test video').id
})

afterEach(() => resetTestDatabase())

function shot(
  label: string,
  modelId = SEEDANCE,
  duration = 4,
  prompt = 'She rides, camera tracks.'
) {
  return createNode({ videoId, modelId, label, params: { prompt, duration } })
}

describe('linkShots', () => {
  it('wires each clip into the next shot and declares its role in the prompt', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    const c = shot('Shot 03')

    const result = linkShots(videoId, [a.id, b.id, c.id])
    expect(result.skipped).toEqual([])
    expect(result.linked).toEqual([
      { sourceNodeId: a.id, targetNodeId: b.id, alias: '@Video1' },
      { sourceNodeId: b.id, targetNodeId: c.id, alias: '@Video1' }
    ])

    const { nodes, edges } = listGraph(videoId)
    expect(
      edges.map((e) => [e.sourceNodeId, e.targetNodeId, e.targetHandle, e.sourceHandle])
    ).toEqual([
      [a.id, b.id, 'reference_video_urls', 'output'],
      [b.id, c.id, 'reference_video_urls', 'output']
    ])
    // The prompt now addresses the reference — an unaddressed one only guides
    // by accident, and the shot must stay a CUT, not a continuation.
    const promptOf = (id: string) =>
      String((nodes.find((n) => n.id === id)!.params as { prompt: string }).prompt)
    expect(promptOf(b.id)).toContain('@Video1 is the PREVIOUS shot ("Shot 01")')
    expect(promptOf(b.id)).toContain('CUT to a new camera setup')
    expect(promptOf(b.id)).toContain('She rides, camera tracks.')
    // The first shot is only ever a source — nothing is appended to it.
    expect(promptOf(a.id)).toBe('She rides, camera tracks.')
  })

  it('undoes the whole chain in one step (it was one gesture)', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    const c = shot('Shot 03')
    linkShots(videoId, [a.id, b.id, c.id])
    expect(listGraph(videoId).edges).toHaveLength(2)

    undoGraph(videoId)
    const { nodes, edges } = listGraph(videoId)
    expect(edges).toHaveLength(0)
    for (const node of nodes) {
      expect(String((node.params as { prompt: string }).prompt)).toBe('She rides, camera tracks.')
    }
  })

  it('skips a cut whose model has no reference-video input, and keeps the rest', () => {
    const a = shot('Shot 01')
    // Seedance 1.5 takes frame anchors only — that cut cannot be chained.
    const b = shot('Shot 02', SEEDANCE_15, 8)
    const c = shot('Shot 03')

    const result = linkShots(videoId, [a.id, b.id, c.id])
    expect(result.linked).toEqual([{ sourceNodeId: b.id, targetNodeId: c.id, alias: '@Video1' }])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.targetNodeId).toBe(b.id)
    expect(result.skipped[0]!.reason).toMatch(/no reference-video input/)
  })

  it('skips a link that would overrun the handle combined-length budget', () => {
    // The budget is per TARGET handle (15 s on Seedance 2), not cumulative down
    // the chain: a 15 s clip fills the next shot's handle on its own, so a
    // SECOND reference video on that same shot no longer fits.
    const a = shot('Shot 01', SEEDANCE, 15)
    const b = shot('Shot 02', SEEDANCE, 15)
    const c = shot('Shot 03', SEEDANCE, 15)
    linkShots(videoId, [a.id, b.id])

    const result = linkShots(videoId, [c.id, b.id])
    expect(result.linked).toEqual([])
    expect(result.skipped[0]!.targetNodeId).toBe(b.id)
    expect(result.skipped[0]!.reason).toMatch(/30s of reference video \(max 15s\)/)
  })

  it('chains a long sequence: each target carries only its own predecessor', () => {
    const shots = [shot('Shot 01'), shot('Shot 02'), shot('Shot 03'), shot('Shot 04')]
    const result = linkShots(
      videoId,
      shots.map((s) => s.id)
    )
    expect(result.skipped).toEqual([])
    expect(result.linked).toHaveLength(3)
    expect(result.linked.every((l) => l.alias === '@Video1')).toBe(true)
  })

  it('numbers the alias after the references already wired on the target', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    const c = shot('Shot 03')
    linkShots(videoId, [a.id, b.id])
    // b already carries @Video1; chaining b → c leaves c's handle empty, but
    // re-chaining into b must not reuse @Video1.
    const result = linkShots(videoId, [c.id, b.id])
    expect(result.linked[0]!.alias).toBe('@Video2')
  })

  // An agent retry, or a second pass over a wider selection, must not append a
  // second role sentence for an edge connectNodes would dedupe anyway.
  it('is idempotent: re-chaining an already-linked pair changes nothing', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    linkShots(videoId, [a.id, b.id])
    const promptOf = () =>
      String(
        (listGraph(videoId).nodes.find((n) => n.id === b.id)!.params as { prompt: string }).prompt
      )
    const first = promptOf()

    const again = linkShots(videoId, [a.id, b.id])
    expect(again.linked).toEqual([{ sourceNodeId: a.id, targetNodeId: b.id, alias: '@Video1' }])
    expect(again.skipped).toEqual([])
    expect(promptOf()).toBe(first)
    expect(listGraph(videoId).edges).toHaveLength(1)
  })

  it('refuses anything that is not a chain of video shots', () => {
    const a = shot('Shot 01')
    const image = createNode({ videoId, modelId: IMAGE, label: 'Sheet', params: { prompt: 'x' } })
    expect(() => linkShots(videoId, [a.id])).toThrow(/at least two shots/)
    expect(() => linkShots(videoId, [a.id, image.id])).toThrow(/not a video shot/)
    expect(() => linkShots(videoId, [a.id, 'nope'])).toThrow(/Unknown nodeId/)
  })
})

describe('planLinkShots', () => {
  it('reports what would be chained without touching the graph', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02', SEEDANCE_15)
    const c = shot('Shot 03')

    const plan = planLinkShots(videoId, [a.id, b.id, c.id])
    // a→b impossible (no reference-video input on 1.5); b→c would chain.
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0]).toMatchObject({ sourceNodeId: a.id, targetNodeId: b.id })
    expect(plan.toLink).toEqual([
      {
        sourceNodeId: b.id,
        targetNodeId: c.id,
        alias: '@Video1',
        role: expect.stringContaining('PREVIOUS shot')
      }
    ])
    expect(plan.alreadyLinked).toEqual([])
    // Dry run: no edge, no prompt change, no undo step.
    expect(listGraph(videoId).edges).toEqual([])
    expect(historyState(videoId).canUndo).toBe(true) // node creations only
  })

  it('reports an existing chain as alreadyLinked', () => {
    const a = shot('Shot 01')
    const b = shot('Shot 02')
    linkShots(videoId, [a.id, b.id])
    const plan = planLinkShots(videoId, [a.id, b.id])
    expect(plan.toLink).toEqual([])
    expect(plan.alreadyLinked).toEqual([
      { sourceNodeId: a.id, targetNodeId: b.id, alias: '@Video1' }
    ])
  })
})
