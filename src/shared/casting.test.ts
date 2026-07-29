import { describe, expect, it } from 'vitest'
import { castingRoleSentence, planCasting, type CastingRole, type ShotForCasting } from './casting'

const LEA: CastingRole = { name: 'Léa', subject: 'Léa, 20, pink hair', designId: 'character' }

const shot = (n: number, overrides: Partial<ShotForCasting> = {}): ShotForCasting => ({
  id: `n${n}`,
  label: `Shot 0${n}`,
  ...overrides
})

describe('castingRoleSentence', () => {
  it('names the identity, asks for it across shots, and forbids the sheet on screen', () => {
    const role = castingRoleSentence('@Image1', LEA)
    expect(role).toContain('@Image1')
    // The name is what makes it an identity rather than a look — in caps so the
    // model has a handle it can carry between prompts.
    expect(role).toContain('LÉA')
    expect(role).toContain('Léa, 20, pink hair')
    expect(role).toMatch(/every other shot/i)
    expect(role).toMatch(/never appear on screen/i)
  })

  it('describes invariance in the vocabulary of the sheet it was built from', () => {
    expect(castingRoleSentence('@Image1', { name: 'Léa', designId: 'character' })).toMatch(
      /face, hair, build/i
    )
    expect(castingRoleSentence('@Image1', { name: 'Le bar', designId: 'decor' })).toMatch(
      /location, architecture/i
    )
    // A prop is not kept "in character": asking for a face on a pack-shot
    // invites the model to put a person in the frame.
    const prop = castingRoleSentence('@Image1', { name: 'La fiole', designId: 'prop' })
    expect(prop).toMatch(/shape, materials/i)
    expect(prop).not.toMatch(/face/i)
  })

  it('falls back to a generic invariance clause for an unmarked sheet', () => {
    expect(castingRoleSentence('@Image1', { name: 'X' })).toMatch(/same design, colors/i)
  })

  it('appends the casting notes as their own sentence', () => {
    const role = castingRoleSentence('@Image1', { ...LEA, notes: 'always wears the red scarf' })
    expect(role).toContain('always wears the red scarf.')
  })

  it('leaves an already-punctuated note alone', () => {
    const role = castingRoleSentence('@Image1', { ...LEA, notes: 'Never smiles.' })
    expect(role).toContain('Never smiles.')
    expect(role).not.toContain('Never smiles..')
  })
})

describe('planCasting', () => {
  it('links the role onto every shot, each with its own alias numbering', () => {
    const { links, skipped, alreadyCast } = planCasting([shot(1), shot(2), shot(3)], LEA)
    expect(skipped).toEqual([])
    expect(alreadyCast).toEqual([])
    expect(links.map((l) => l.shotId)).toEqual(['n1', 'n2', 'n3'])
    // Each shot's budget is its own — casting is not cumulative like a chain.
    expect(links.every((l) => l.alias === '@Image1')).toBe(true)
    expect(links[0]!.role).toContain('@Image1')
  })

  it('numbers the alias after the references already wired on that shot', () => {
    const { links } = planCasting([shot(1, { existingRefs: { count: 2 } })], LEA)
    expect(links[0]!.alias).toBe('@Image3')
    expect(links[0]!.role).toContain('@Image3')
  })

  it('reports a shot that already carries the role instead of wiring it twice', () => {
    const { links, alreadyCast } = planCasting(
      [shot(1, { alreadyCastAt: 2, existingRefs: { count: 3 } }), shot(2)],
      LEA
    )
    expect(alreadyCast).toEqual([{ shotId: 'n1', alias: '@Image2' }])
    expect(links.map((l) => l.shotId)).toEqual(['n2'])
  })

  it('skips a shot whose reference handle is full, naming it and the role', () => {
    const { links, skipped } = planCasting([shot(1, { existingRefs: { count: 9 } })], LEA, {
      maxCount: 9
    })
    expect(links).toEqual([])
    expect(skipped[0]!.reason).toContain('Shot 01')
    expect(skipped[0]!.reason).toContain('max 9')
    expect(skipped[0]!.reason).toContain('Léa')
  })

  it('keeps the shots that fit when one does not', () => {
    const { links, skipped } = planCasting(
      [shot(1), shot(2, { existingRefs: { count: 9 } }), shot(3)],
      LEA,
      { maxCount: 9 }
    )
    expect(links.map((l) => l.shotId)).toEqual(['n1', 'n3'])
    expect(skipped.map((s) => s.shotId)).toEqual(['n2'])
  })

  it('has no budget to enforce when the handle declares no maxCount', () => {
    const { links, skipped } = planCasting([shot(1, { existingRefs: { count: 99 } })], LEA)
    expect(skipped).toEqual([])
    expect(links[0]!.alias).toBe('@Image100')
  })

  it('honours the handle alias it is given', () => {
    const { links } = planCasting([shot(1)], LEA, { alias: '@Ref' })
    expect(links[0]!.alias).toBe('@Ref1')
  })

  it('has nothing to do without shots', () => {
    expect(planCasting([], LEA)).toEqual({ links: [], skipped: [], alreadyCast: [] })
  })
})
