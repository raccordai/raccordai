import { describe, expect, it } from 'vitest'
import { ANTI_GRID_GUARD } from './models/seedance2-prompting'
import { planScenario, type ScenarioBeat } from './scenario'

const MODEL = 'bytedance/seedance-2-fast' // duration 4-15, step 1
const SEEDANCE_15 = 'bytedance/seedance-1.5-pro' // duration 4/8/12

const beat = (overrides: Partial<ScenarioBeat> & { title: string }): ScenarioBeat => ({
  action: `${overrides.title} happens.`,
  seconds: 4,
  ...overrides
})

/** "LE COLIS" — the 20s script that exposed every one of these problems. */
const COLIS: ScenarioBeat[] = [
  beat({
    title: 'Le sac',
    seconds: 3,
    action: 'Gloved hands buckle a backpack strap.',
    closesOn: 'the buckle snapping shut, hands still in frame'
  }),
  beat({
    title: 'La sortie',
    seconds: 3,
    action: 'Maya bursts out of a car park, two silhouettes give chase.',
    screenDirection: 'left-to-right',
    closesOn: 'Maya entering the neon street at frame right'
  }),
  beat({
    title: 'Contresens',
    seconds: 4,
    action: 'She rides against traffic and threads between two vans.',
    screenDirection: 'left-to-right',
    closesOn: 'the gap between the vans closing behind her'
  }),
  beat({
    title: 'Le scooter',
    seconds: 3,
    action: 'A pursuer mounts a scooter, rear wheel spinning.',
    screenDirection: 'left-to-right',
    closesOn: 'the scooter launching forward'
  })
]

describe('planScenario', () => {
  // The default keeps the director's cut list: a 3s beat is a 4s shot, never a
  // 3s clip the API refuses — and never a silent merge with the next subject.
  it('runs a sub-floor beat at the floor and keeps it its own shot', () => {
    const scenario = planScenario({ brief: 'Chase', modelId: MODEL, beats: COLIS })
    expect(scenario.shots).toHaveLength(COLIS.length)
    for (const shot of scenario.shots) {
      expect(shot.seconds).toBeGreaterThanOrEqual(4)
      expect(shot.seconds).toBeLessThanOrEqual(15)
    }
    expect(scenario.shots.map((s) => s.seconds)).toEqual([4, 4, 4, 4])
    expect(scenario.shots[0]!.requestedSeconds).toBe(3)
    expect(scenario.warnings.join(' ')).toContain('this model delivers 4s (+1s')
  })

  it('folds sub-floor beats together under the merge policy', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: COLIS,
      shortBeatPolicy: 'merge'
    })
    // 3+3 = one 6s shot; the trailing 3s beat folds into the 4s one before it.
    expect(scenario.shots.map((s) => s.seconds)).toEqual([6, 7])
    expect(scenario.shots[0]!.mergedFrom).toEqual(['Le sac', 'La sortie'])
    expect(scenario.shots[0]!.action).toContain('Then,')
    expect(scenario.warnings.join(' ')).toContain('merged into one 6s shot')
  })

  it('honours an explicit mergeWithNext whatever the policy', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [
        beat({ title: 'A', seconds: 6, mergeWithNext: true }),
        beat({ title: 'B', seconds: 5, closesOn: 'x' }),
        beat({ title: 'C', seconds: 4, closesOn: 'y' })
      ]
    })
    expect(scenario.shots).toHaveLength(2)
    expect(scenario.shots[0]!.mergedFrom).toEqual(['A', 'B'])
    expect(scenario.shots[0]!.seconds).toBe(11)
  })

  it('chains each shot onto the frame the previous one closes on', () => {
    const scenario = planScenario({ brief: 'Chase', modelId: MODEL, beats: COLIS })
    const second = scenario.shots[1]!
    expect(second.opensOn).toContain('the buckle snapping shut')
    expect(second.promptScaffold).toContain('OPENS ON:')
    expect(second.promptScaffold).toContain('CLOSES ON:')
    expect(second.promptScaffold).toContain('this is a cut, not a continuation')
    // The first shot opens the film — nothing to hand over to it.
    expect(scenario.shots[0]!.promptScaffold).not.toContain('this is a cut')
  })

  it('keeps an explicit opening over the derived one', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [
        beat({ title: 'A', closesOn: 'a door slamming' }),
        beat({ title: 'B', opensOn: 'a wide street, empty' })
      ]
    })
    expect(scenario.shots[1]!.opensOn).toBe('a wide street, empty')
  })

  it('falls back to a plain cut when the previous shot says nothing about its exit', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [beat({ title: 'A' }), beat({ title: 'B' })]
    })
    expect(scenario.shots[1]!.opensOn).toContain('A cut from "A"')
    expect(scenario.warnings.join(' ')).toContain('does not say what frame it CLOSES ON')
  })

  it('splits a beat above the ceiling into legal parts', () => {
    const scenario = planScenario({
      brief: 'Long take',
      modelId: MODEL,
      beats: [beat({ title: 'La poursuite', seconds: 24, closesOn: 'the barrier' })]
    })
    expect(scenario.shots).toHaveLength(2)
    expect(scenario.shots.map((s) => s.seconds)).toEqual([12, 12])
    expect(scenario.shots[0]!.title).toBe('La poursuite (1/2)')
    // Only the last part carries the exit frame.
    expect(scenario.shots[0]!.closesOn).toBe('')
    expect(scenario.shots[1]!.closesOn).toBe('the barrier')
    expect(scenario.warnings.join(' ')).toContain('above the 15s ceiling')
  })

  it('snaps to the discrete lengths a model accepts', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: SEEDANCE_15,
      beats: [beat({ title: 'A', seconds: 7 }), beat({ title: 'B', seconds: 11 })]
    })
    expect(scenario.shots.map((s) => s.seconds)).toEqual([8, 12])
    expect(scenario.shots[0]!.requestedSeconds).toBe(7)
    expect(scenario.warnings.join(' ')).toContain('this model delivers 8s')
  })

  // The exact drift that turned a 20s script into a 28s film, said out loud.
  it('reconciles the total with the brief instead of letting it drift', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: COLIS,
      targetSeconds: 13
    })
    expect(scenario.totalSeconds).toBe(16)
    expect(scenario.warnings.join(' ')).toContain('totals 16s for a 13s brief (+3s)')
  })

  it('says nothing about the total when it matches the brief', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [beat({ title: 'A', seconds: 4 }), beat({ title: 'B', seconds: 6 })],
      targetSeconds: 10
    })
    expect(scenario.warnings.join(' ')).not.toContain('totals')
  })

  // The bike/scooter defect: same references, opposite directions across a cut.
  it('flags a screen-direction reversal across a cut', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [
        beat({
          title: 'Le vélo',
          screenDirection: 'left-to-right',
          closesOn: 'she exits frame right'
        }),
        beat({
          title: 'Le scooter',
          screenDirection: 'right-to-left',
          closesOn: 'the scooter leaves'
        })
      ]
    })
    const warning = scenario.warnings.find((w) => w.includes('reversal'))
    expect(warning).toContain('"Le vélo" travels left to right')
    expect(warning).toContain('"Le scooter" travels right to left')
    expect(scenario.shots[0]!.promptScaffold).toContain(
      'Screen direction: the subject travels left to right'
    )
  })

  it('does not flag a direction change involving a static shot', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [
        beat({ title: 'A', screenDirection: 'left-to-right', closesOn: 'x' }),
        beat({ title: 'B', screenDirection: 'static', closesOn: 'y' })
      ]
    })
    expect(scenario.warnings.join(' ')).not.toContain('reversal')
  })

  it('adds the anti-grid guard only to board-driven shots', () => {
    const scenario = planScenario({
      brief: 'Chase',
      modelId: MODEL,
      beats: [
        beat({ title: 'A', boardDriven: true, closesOn: 'x' }),
        beat({ title: 'B', closesOn: 'y' })
      ]
    })
    expect(scenario.shots[0]!.promptScaffold).toContain(ANTI_GRID_GUARD)
    expect(scenario.shots[1]!.promptScaffold).not.toContain(ANTI_GRID_GUARD)
  })

  it('produces node-ready keys and survives an empty script', () => {
    const scenario = planScenario({ brief: 'x', modelId: MODEL, beats: [] })
    expect(scenario.shots).toEqual([])
    expect(scenario.totalSeconds).toBe(0)
    const filled = planScenario({
      brief: 'x',
      modelId: MODEL,
      beats: [beat({ title: 'A' }), beat({ title: 'B' })]
    })
    expect(filled.shots.map((s) => s.key)).toEqual(['shot-01', 'shot-02'])
  })

  it('warns instead of throwing on an unknown model', () => {
    const scenario = planScenario({
      brief: 'x',
      modelId: 'nope/none',
      beats: [beat({ title: 'A', seconds: 2 })]
    })
    expect(scenario.shots[0]!.seconds).toBe(2)
    expect(scenario.warnings.join(' ')).toContain('Unknown model')
  })

  it('folds a trailing short beat into the shot before it (merge policy)', () => {
    const scenario = planScenario({
      brief: 'x',
      modelId: MODEL,
      shortBeatPolicy: 'merge',
      beats: [beat({ title: 'A', seconds: 6 }), beat({ title: 'B', seconds: 2 })]
    })
    expect(scenario.shots).toHaveLength(1)
    expect(scenario.shots[0]!.mergedFrom).toEqual(['A', 'B'])
    expect(scenario.shots[0]!.seconds).toBe(8)
  })

  it('lifts a whole script shorter than one legal clip up to the floor', () => {
    const scenario = planScenario({
      brief: 'x',
      modelId: MODEL,
      beats: [beat({ title: 'A', seconds: 1 })]
    })
    expect(scenario.shots).toHaveLength(1)
    expect(scenario.shots[0]!.seconds).toBe(4)
  })
})
