import { describe, expect, it } from 'vitest'
import { planRun, type PlannerEdge, type PlannerNode } from './runPlanner'

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
})
