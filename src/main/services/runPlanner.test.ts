import { describe, expect, it } from 'vitest'
import { MAX_VARIANTS } from '@shared/config'
import { clampVariants, planRun, type PlannerEdge, type PlannerNode } from './runPlanner'

function node(id: string, modelId = 'model/x'): PlannerNode {
  return { id, modelId, label: `L-${id}`, key: `k-${id}` }
}
const edge = (from: string, to: string): PlannerEdge => ({ sourceNodeId: from, targetNodeId: to })

// A ── B ── D      A is shared by B and C; D consumes both branches.
//  └── C ───┘
const DIAMOND = {
  nodes: [node('A'), node('B'), node('C'), node('D')],
  edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')]
}

describe('planRun', () => {
  it('walks the upstream closure in topological order', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    const ids = plan.order.map((e) => e.id)
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'))
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('C'))
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('D'))
    expect(ids.indexOf('C')).toBeLessThan(ids.indexOf('D'))
    expect(plan.planned.map((e) => e.id).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('plans a shared dependency exactly once across several targets', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['B', 'C'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.order.filter((e) => e.id === 'A')).toHaveLength(1)
    expect(plan.planned.map((e) => e.id).sort()).toEqual(['A', 'B', 'C'])
  })

  it('dependencies always reuse; targets reuse only in batch mode', () => {
    const single = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    const byId = Object.fromEntries(single.order.map((e) => [e.id, e]))
    expect(byId['A']!.reuse).toBe(true)
    expect(byId['B']!.reuse).toBe(true)
    expect(byId['D']!.reuse).toBe(false)

    const batch = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: true,
      satisfiedNodeIds: []
    })
    expect(batch.order.find((e) => e.id === 'D')!.reuse).toBe(true)
  })

  it('skips satisfied nodes that reuse, but an explicit non-batch target re-runs', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: ['B', 'D']
    })
    const byId = Object.fromEntries(plan.order.map((e) => [e.id, e]))
    // B is a satisfied dependency → skipped; D is the clicked target → runs.
    expect(byId['B']!.run).toBe(false)
    expect(byId['D']!.run).toBe(true)
    expect(plan.planned.map((e) => e.id).sort()).toEqual(['A', 'C', 'D'])

    // In batch mode the satisfied target is skipped too (no churned credits).
    const batch = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: true,
      satisfiedNodeIds: ['D']
    })
    expect(batch.planned.map((e) => e.id).sort()).toEqual(['A', 'B', 'C'])
  })

  it('ancestors of a skipped satisfied node still run (cost-modal parity)', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: true,
      satisfiedNodeIds: ['B']
    })
    // B reuses its output, but A (unsatisfied) is still planned.
    expect(plan.planned.map((e) => e.id).sort()).toEqual(['A', 'C', 'D'])
  })

  it('excludes asset nodes from the planned set but keeps them as parents', () => {
    const plan = planRun({
      nodes: [node('asset', 'studio/asset'), node('S')],
      edges: [edge('asset', 'S')],
      targetNodeIds: ['S'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.planned.map((e) => e.id)).toEqual(['S'])
    expect(plan.order.find((e) => e.id === 'S')!.parents).toEqual(['asset'])
  })

  it('labels fall back to the node key and unknown ids are ignored', () => {
    const plan = planRun({
      nodes: [{ id: 'X', modelId: 'm', label: null, key: 'k-X' }],
      edges: [edge('ghost', 'X')],
      targetNodeIds: ['X', 'missing'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.order).toHaveLength(1)
    expect(plan.order[0]!.label).toBe('k-X')
    expect(plan.order[0]!.parents).toEqual([])
  })

  it('does not hang on a cyclic graph', () => {
    const plan = planRun({
      nodes: [node('A'), node('B')],
      edges: [edge('A', 'B'), edge('B', 'A')],
      targetNodeIds: ['B'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.order.map((e) => e.id).sort()).toEqual(['A', 'B'])
  })

  it('deduplicates parallel edges between the same two nodes', () => {
    const plan = planRun({
      nodes: [node('A'), node('B')],
      edges: [edge('A', 'B'), edge('A', 'B')],
      targetNodeIds: ['B'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.order.find((e) => e.id === 'B')!.parents).toEqual(['A'])
  })

  // ── Variants ×N (§6.6) ────────────────────────────────────────────────────

  it('claims one generation per node by default', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: []
    })
    expect(plan.planned.every((e) => e.runs === 1)).toBe(true)
  })

  it('multiplies the explicit targets only — dependencies still run once', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: [],
      variants: 3
    })
    const byId = Object.fromEntries(plan.order.map((e) => [e.id, e]))
    expect(byId['D']!.runs).toBe(3)
    expect(byId['A']!.runs).toBe(1)
    expect(byId['B']!.runs).toBe(1)
    expect(byId['C']!.runs).toBe(1)
  })

  it('gives every explicit target its own N candidates', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['B', 'C'],
      reuseTargets: false,
      satisfiedNodeIds: [],
      variants: 2
    })
    const byId = Object.fromEntries(plan.order.map((e) => [e.id, e]))
    expect([byId['B']!.runs, byId['C']!.runs]).toEqual([2, 2])
    expect(byId['A']!.runs).toBe(1)
  })

  it('reports 0 runs for a node that is skipped, whatever the variant count', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: true,
      satisfiedNodeIds: ['D'],
      variants: 4
    })
    expect(plan.order.find((e) => e.id === 'D')!.runs).toBe(0)
    expect(plan.planned.some((e) => e.id === 'D')).toBe(false)
  })

  it('clamps the variant count into [1, MAX_VARIANTS]', () => {
    expect(clampVariants(undefined)).toBe(1)
    expect(clampVariants(0)).toBe(1)
    expect(clampVariants(-3)).toBe(1)
    expect(clampVariants('nope')).toBe(1)
    expect(clampVariants(2.7)).toBe(2)
    expect(clampVariants(MAX_VARIANTS)).toBe(MAX_VARIANTS)
    expect(clampVariants(99)).toBe(MAX_VARIANTS)
  })

  it('caps an over-large variant request instead of honouring it', () => {
    const plan = planRun({
      ...DIAMOND,
      targetNodeIds: ['D'],
      reuseTargets: false,
      satisfiedNodeIds: [],
      variants: 99
    })
    expect(plan.order.find((e) => e.id === 'D')!.runs).toBe(MAX_VARIANTS)
  })
})
