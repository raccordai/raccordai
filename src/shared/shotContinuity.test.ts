import { describe, expect, it } from 'vitest'
import {
  planContinuityChain,
  previousShotRole,
  TRANSITION_CONTRACT,
  type ShotForChain
} from './shotContinuity'

const shot = (n: number, overrides: Partial<ShotForChain> = {}): ShotForChain => ({
  id: `n${n}`,
  label: `Shot 0${n}`,
  durationSeconds: 4,
  ...overrides
})

describe('previousShotRole', () => {
  it('asks for the look and forbids continuing the action', () => {
    const role = previousShotRole('@Video1', 'Shot 03 — Against traffic')
    expect(role).toContain('@Video1')
    expect(role).toContain('Shot 03 — Against traffic')
    expect(role).toMatch(/match its lighting/i)
    expect(role).toMatch(/do NOT continue its action/i)
    expect(role).toMatch(/CUT to a new camera setup/i)
  })
})

describe('planContinuityChain', () => {
  it('links each consecutive pair, previous shot into the next one', () => {
    const { links, skipped } = planContinuityChain([shot(1), shot(2), shot(3)])
    expect(skipped).toEqual([])
    expect(links.map((l) => [l.sourceId, l.targetId])).toEqual([
      ['n1', 'n2'],
      ['n2', 'n3']
    ])
    // Each target gets its own @Video1: the chain is pairwise, not cumulative.
    expect(links.every((l) => l.alias === '@Video1')).toBe(true)
    expect(links[0]!.role).toContain('Shot 01')
  })

  it('has nothing to do with fewer than two shots', () => {
    expect(planContinuityChain([]).links).toEqual([])
    expect(planContinuityChain([shot(1)]).links).toEqual([])
  })

  it('numbers the alias after the references already wired on the target', () => {
    const links = planContinuityChain([
      shot(1),
      shot(2, { existingRefs: { count: 2, seconds: 6 } })
    ]).links
    expect(links[0]!.alias).toBe('@Video3')
    expect(links[0]!.role).toContain('@Video3')
  })

  it('skips a link that would overrun the handle count', () => {
    const { links, skipped } = planContinuityChain(
      [shot(1), shot(2, { existingRefs: { count: 3, seconds: 9 } })],
      { maxCount: 3, maxTotalSeconds: 15 }
    )
    expect(links).toEqual([])
    expect(skipped[0]!.reason).toContain('max 3')
  })

  it('skips a link that would overrun the combined-length budget', () => {
    // 12s already wired + a 4s previous shot = 16s > the 15s Seedance 2 allows.
    const { links, skipped } = planContinuityChain(
      [shot(1), shot(2, { existingRefs: { count: 1, seconds: 12 } })],
      { maxCount: 3, maxTotalSeconds: 15 }
    )
    expect(links).toEqual([])
    expect(skipped[0]!.reason).toContain('16s')
    expect(skipped[0]!.reason).toContain('max 15s')
  })

  it('keeps the pairs that fit when a later one does not', () => {
    const { links, skipped } = planContinuityChain(
      [shot(1), shot(2), shot(3, { existingRefs: { count: 1, seconds: 14 } })],
      { maxCount: 3, maxTotalSeconds: 15 }
    )
    expect(links.map((l) => l.targetId)).toEqual(['n2'])
    expect(skipped.map((s) => s.targetId)).toEqual(['n3'])
  })

  it('treats an unknown source duration as free rather than blocking the chain', () => {
    const { links } = planContinuityChain([shot(1, { durationSeconds: undefined }), shot(2)], {
      maxTotalSeconds: 15
    })
    expect(links).toHaveLength(1)
  })
})

describe('TRANSITION_CONTRACT', () => {
  it('states the entry frame, the exit frame and the screen-direction rule', () => {
    expect(TRANSITION_CONTRACT).toContain('OPENS ON:')
    expect(TRANSITION_CONTRACT).toContain('CLOSES ON:')
    expect(TRANSITION_CONTRACT).toMatch(/screen direction/i)
  })
})
