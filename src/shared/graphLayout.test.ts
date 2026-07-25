import { describe, expect, it } from 'vitest'
import {
  autoLayoutPositions,
  needsLayout,
  resolveOverlaps,
  type LayoutEdge,
  type LayoutNode
} from './graphLayout'

let seq = 0
function node(overrides: Partial<LayoutNode> = {}): LayoutNode {
  seq += 1
  return {
    id: `n${seq}`,
    type: 'modelNode',
    position: { x: 0, y: 0 },
    createdAt: seq,
    ...overrides
  }
}

/** Do two laid-out nodes' bounding boxes intersect? (default model node size) */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w = 288,
  h = 260
): boolean {
  return Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h
}

describe('needsLayout', () => {
  it('flags a graph whose nodes all sit on the same spot', () => {
    // What an agent produces when it omits `position` entirely: every node
    // falls back to the origin and the graph imports as one pile.
    expect(
      needsLayout([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 }
      ])
    ).toBe(true)
    expect(
      needsLayout([
        { x: 12, y: 34 },
        { x: 12, y: 34 }
      ])
    ).toBe(true)
  })

  it('leaves authored positions alone', () => {
    expect(
      needsLayout([
        { x: 0, y: 0 },
        { x: 420, y: 0 }
      ])
    ).toBe(false)
  })

  it('never asks to lay out a graph too small to be piled up', () => {
    expect(needsLayout([])).toBe(false)
    expect(needsLayout([{ x: 0, y: 0 }])).toBe(false)
  })
})

describe('autoLayoutPositions', () => {
  it('returns nothing for an empty graph', () => {
    expect(autoLayoutPositions([], [])).toEqual([])
  })

  it('separates every node of a stacked graph', () => {
    const nodes = Array.from({ length: 6 }, () => node())
    const edges: LayoutEdge[] = [
      { source: nodes[0]!.id, target: nodes[1]!.id },
      { source: nodes[1]!.id, target: nodes[2]!.id }
    ]

    const placed = autoLayoutPositions(nodes, edges)

    expect(placed).toHaveLength(6)
    for (const a of placed) {
      for (const b of placed) {
        if (a.id === b.id) continue
        expect(overlaps(a.position, b.position), `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
  })

  it('reads the pipeline left to right (LR): a source sits left of its target', () => {
    const asset = node({ type: 'assetNode' })
    const image = node()
    const clip = node()
    const placed = autoLayoutPositions(
      [asset, image, clip],
      [
        { source: asset.id, target: image.id },
        { source: image.id, target: clip.id }
      ]
    )
    const at = (id: string): { x: number; y: number } => placed.find((p) => p.id === id)!.position

    expect(at(asset.id).x).toBeLessThan(at(image.id).x)
    expect(at(image.id).x).toBeLessThan(at(clip.id).x)
  })

  it('puts a shot and its image on the same row, and orders rows by shot number', () => {
    const img2 = node({ label: '02 — Harbor', key: 'img_02' })
    const clip2 = node({ label: 'Shot 02 — Harbor', key: 'clip_02' })
    const img1 = node({ label: '01 — Opening', key: 'img_01' })
    const clip1 = node({ label: 'Shot 01 — Opening', key: 'clip_01' })
    const placed = autoLayoutPositions(
      [img2, clip2, img1, clip1],
      [
        { source: img1.id, target: clip1.id },
        { source: img2.id, target: clip2.id }
      ]
    )
    const at = (id: string): { x: number; y: number } => placed.find((p) => p.id === id)!.position

    expect(at(img1.id).y).toBe(at(clip1.id).y)
    expect(at(img2.id).y).toBe(at(clip2.id).y)
    // Shot 1 above shot 2, whatever the array order.
    expect(at(img1.id).y).toBeLessThan(at(img2.id).y)
  })

  it('lays out top to bottom in TB, source above target', () => {
    const a = node()
    const b = node()
    const placed = autoLayoutPositions([a, b], [{ source: a.id, target: b.id }], 'TB')
    const at = (id: string): { x: number; y: number } => placed.find((p) => p.id === id)!.position

    expect(at(a.id).y).toBeLessThan(at(b.id).y)
  })

  it('ignores edges pointing outside the node set', () => {
    const a = node()
    const b = node()
    const placed = autoLayoutPositions(
      [a, b],
      [
        { source: a.id, target: 'ghost' },
        { source: 'ghost', target: b.id }
      ]
    )
    expect(placed).toHaveLength(2)
  })

  it('honours measured sizes when spacing nodes', () => {
    const wide = node({ measured: { width: 900, height: 260 } })
    const next = node()
    const placed = autoLayoutPositions([wide, next], [{ source: wide.id, target: next.id }])
    const at = (id: string): { x: number; y: number } => placed.find((p) => p.id === id)!.position

    expect(at(next.id).x - at(wide.id).x).toBeGreaterThanOrEqual(900)
  })
})

describe('resolveOverlaps', () => {
  it('pushes a node off the one that grew, and reports only what moved', () => {
    const grown = node({ position: { x: 0, y: 0 }, measured: { width: 288, height: 600 } })
    const under = node({ position: { x: 0, y: 300 } })
    const far = node({ position: { x: 2000, y: 2000 } })

    const moved = resolveOverlaps([grown, under, far], [grown.id])

    expect(moved.map((m) => m.id)).toEqual([under.id])
    expect(moved[0]!.position.y).toBeGreaterThanOrEqual(600)
  })

  it('leaves a graph with no overlap untouched', () => {
    const a = node({ position: { x: 0, y: 0 } })
    const b = node({ position: { x: 1000, y: 0 } })
    expect(resolveOverlaps([a, b], [a.id])).toEqual([])
  })

  it('never moves a frozen node', () => {
    const grown = node({ position: { x: 0, y: 0 } })
    const dragged = node({ position: { x: 40, y: 40 } })
    expect(resolveOverlaps([grown, dragged], [grown.id], new Set([dragged.id]))).toEqual([])
  })

  it('cascades: a pushed node pushes its own neighbour', () => {
    const grown = node({ position: { x: 0, y: 0 } })
    const middle = node({ position: { x: 0, y: 100 } })
    const outer = node({ position: { x: 0, y: 200 } })

    const moved = resolveOverlaps([grown, middle, outer], [grown.id])

    expect(moved.map((m) => m.id).sort()).toEqual([middle.id, outer.id].sort())
    const byId = new Map(moved.map((m) => [m.id, m.position]))
    expect(overlaps(byId.get(middle.id)!, byId.get(outer.id)!)).toBe(false)
  })

  it('ignores seed ids that are not in the graph', () => {
    const a = node({ position: { x: 0, y: 0 } })
    expect(resolveOverlaps([a], ['ghost'])).toEqual([])
  })
})
