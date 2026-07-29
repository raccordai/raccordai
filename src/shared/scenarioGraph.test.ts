import { describe, expect, it } from 'vitest'
import { getRecipe, SHOT_RECIPES } from './designs/registry'
import { planScenario, type ScenarioBeat } from './scenario'
import {
  matchPace,
  matchShotRecipe,
  matchShotSize,
  planScenarioShots,
  shotRecipeValues
} from './scenarioGraph'

const SEEDANCE2 = 'bytedance/seedance-2-fast' // duration 4-15, step 1
const SEEDANCE_15 = 'bytedance/seedance-1.5-pro' // duration 4/8/12, no orbit/insert preset

const shot = (
  overrides: Partial<Parameters<typeof matchShotRecipe>[0]> = {}
): Parameters<typeof matchShotRecipe>[0] => ({ seconds: 6, ...overrides })

describe('matchShotRecipe — the camera line', () => {
  it.each([
    ['slow push-in on her face', 'shot-push-in'],
    ['travelling avant serré', 'shot-push-in'],
    ['travelling latéral qui suit le vélo', 'shot-tracking'],
    ['the camera tracks alongside her', 'shot-tracking'],
    ['pull-back reveal of the whole plaza', 'shot-pull-back'],
    ['travelling arrière qui dévoile la ville', 'shot-pull-back'],
    ['orbite lente autour du casque', 'shot-orbit'],
    ['whip-pan onto the scooter', 'shot-whip-pan'],
    ['caméra portée à l’épaule, nerveuse', 'shot-pov-handheld'],
    ['plan fixe sur la porte', 'shot-locked-off'],
    ['plan large d’ensemble sur la ville', 'shot-establishing'],
    ['insert macro sur la boucle', 'shot-insert'],
    ['gros plan sur son visage', 'shot-reaction']
  ])('reads "%s" as %s', (camera, expected) => {
    expect(matchShotRecipe(shot({ camera }), SEEDANCE2)?.recipeId).toBe(expected)
  })

  it('reports WHICH words it matched — the choice has to be explainable', () => {
    const match = matchShotRecipe(shot({ camera: 'travelling avant' }), SEEDANCE2)
    expect(match?.reason).toContain('travelling avant')
  })

  it('prefers what the camera DOES over how tight the frame is', () => {
    // "gros plan" alone is a reaction; with a move, the move wins and the
    // framing is carried by the shotSize field instead of fighting for the preset.
    const match = matchShotRecipe(shot({ camera: 'gros plan, travelling avant' }), SEEDANCE2)
    expect(match?.recipeId).toBe('shot-push-in')
    expect(matchShotSize('gros plan, travelling avant')).toBe('cu')
  })

  it('does not read an abbreviation out of the middle of a word', () => {
    // "focus" contains "cu", "flows" contains "ws" — a bare substring search
    // turned both into framing instructions.
    expect(matchShotSize('the camera focus falls off fast')).toBeUndefined()
    expect(matchShotSize('the crowd flows past')).toBeUndefined()
    expect(matchShotSize('CU on her hands')).toBe('cu')
  })

  it('reads inflections of a longer keyword', () => {
    expect(matchShotRecipe(shot({ camera: 'the camera tracked her' }), SEEDANCE2)?.recipeId).toBe(
      'shot-tracking'
    )
    expect(matchShotRecipe(shot({ camera: 'it reveals the skyline' }), SEEDANCE2)?.recipeId).toBe(
      'shot-pull-back'
    )
  })
})

describe('matchShotRecipe — fallbacks', () => {
  it('opens on an establishing shot when nothing is written', () => {
    expect(matchShotRecipe(shot({ seconds: 8 }), SEEDANCE2, 0)?.recipeId).toBe('shot-establishing')
  })

  it('makes a very short shot an insert — there is no room for a developed move', () => {
    const match = matchShotRecipe(shot({ seconds: 4 }), SEEDANCE2, 3)
    expect(match?.recipeId).toBe('shot-insert')
    expect(match?.reason).toContain('4s')
  })

  it('follows a travelling subject and pushes in on an approaching one', () => {
    expect(
      matchShotRecipe(shot({ seconds: 6, screenDirection: 'left-to-right' }), SEEDANCE2, 2)
        ?.recipeId
    ).toBe('shot-tracking')
    expect(
      matchShotRecipe(shot({ seconds: 6, screenDirection: 'toward-camera' }), SEEDANCE2, 2)
        ?.recipeId
    ).toBe('shot-push-in')
    expect(
      matchShotRecipe(shot({ seconds: 6, screenDirection: 'away-from-camera' }), SEEDANCE2, 2)
        ?.recipeId
    ).toBe('shot-pull-back')
  })

  it('falls back to a rigid frame — the shot every model delivers', () => {
    const match = matchShotRecipe(shot({ seconds: 6, screenDirection: 'static' }), SEEDANCE2, 2)
    expect(match?.recipeId).toBe('shot-locked-off')
  })
})

describe('matchShotRecipe — the target model', () => {
  it('substitutes a preset the model cannot run, keeping the original intent', () => {
    // Seedance 1.5 has no orbit preset; the match degrades instead of failing.
    const match = matchShotRecipe(shot({ camera: 'orbite autour du casque' }), SEEDANCE_15)
    expect(match?.substitutedFrom).toBe('shot-orbit')
    expect(match?.recipeId).toBe('shot-tracking')
    expect(getRecipe(match!.recipeId)?.supportedModels).toContain(SEEDANCE_15)
    expect(match?.reason).toContain('orbit')
  })

  it('every preset it can return actually runs on the model it was matched for', () => {
    for (const camera of ['orbit', 'insert macro', 'whip-pan', 'handheld', 'push-in', '']) {
      for (const modelId of [SEEDANCE2, SEEDANCE_15]) {
        const match = matchShotRecipe(shot({ camera, seconds: 4 }), modelId)
        expect(getRecipe(match!.recipeId)?.supportedModels).toContain(modelId)
      }
    }
  })

  it('returns nothing when no preset runs on the model at all', () => {
    expect(matchShotRecipe(shot({ camera: 'push-in' }), 'grok-imagine/text-to-video')).toBeNull()
  })

  it('only ever names presets that exist in the registry', () => {
    const ids = new Set(SHOT_RECIPES.map((recipe) => recipe.id))
    for (const camera of ['orbit', 'insert', 'whip', 'pov', 'wide', 'gros plan', 'fixe']) {
      const match = matchShotRecipe(shot({ camera }), SEEDANCE2)
      expect(ids.has(match!.recipeId)).toBe(true)
    }
  })
})

describe('matchPace', () => {
  it('reads urgency and slowness, and leaves the default alone', () => {
    expect(matchPace('fast whip-pan')).toBe('fast')
    expect(matchPace('travelling lent et posé')).toBe('slow')
    expect(matchPace('travelling latéral')).toBeUndefined()
  })
})

describe('shotRecipeValues', () => {
  const scenario = planScenario({
    brief: 'test',
    modelId: SEEDANCE2,
    beats: [
      {
        title: 'La sortie',
        action: 'Maya bursts out of the car park.',
        seconds: 6,
        camera: 'travelling latéral rapide',
        sound: 'sirens, breathing',
        opensOn: 'the door slamming open',
        closesOn: 'Maya entering the neon street at frame right',
        screenDirection: 'left-to-right',
        roles: ['Maya', ' maya ', 'Le poursuivant']
      }
    ]
  })

  it('copies what the scenario already decided instead of re-deriving it', () => {
    const values = shotRecipeValues(scenario.shots[0]!)
    expect(values).toMatchObject({
      description: 'Maya bursts out of the car park.',
      opensOn: 'the door slamming open',
      closesOn: 'Maya entering the neon street at frame right',
      screenDirection: 'left-to-right',
      sound: 'sirens, breathing',
      pace: 'fast'
    })
  })

  it('leaves a blank field out so the preset default applies', () => {
    const bare = planScenario({
      brief: 'test',
      modelId: SEEDANCE2,
      beats: [{ title: 'Un plan', action: 'Something happens.', seconds: 6 }]
    })
    const values = shotRecipeValues(bare.shots[0]!)
    expect(values.closesOn).toBeUndefined()
    expect(values.sound).toBeUndefined()
    expect(values.shotSize).toBeUndefined()
  })

  it('normalizes the roles the beat named', () => {
    expect(scenario.shots[0]!.roles).toEqual(['Maya', 'Le poursuivant'])
  })
})

describe('planScenarioShots', () => {
  const beats: ScenarioBeat[] = [
    {
      title: 'Le sac',
      action: 'Gloved hands buckle a backpack strap.',
      seconds: 4,
      camera: 'insert macro',
      closesOn: 'the buckle snapping shut'
    },
    {
      title: 'La sortie',
      action: 'Maya bursts out of the car park.',
      seconds: 6,
      camera: 'travelling latéral',
      closesOn: 'Maya entering the neon street',
      screenDirection: 'left-to-right',
      roles: ['Maya']
    },
    {
      title: 'Le regard',
      action: 'She looks back over her shoulder.',
      seconds: 5,
      camera: 'gros plan',
      roles: ['Maya']
    }
  ]
  const scenario = planScenario({ brief: 'Une course', modelId: SEEDANCE2, beats })

  it('turns every shot into a preset node carrying the shot’s own duration', () => {
    const plan = planScenarioShots(scenario)
    expect(plan.build.map((entry) => entry.recipeId)).toEqual([
      'shot-insert',
      'shot-tracking',
      'shot-reaction'
    ])
    expect(plan.build.map((entry) => entry.seconds)).toEqual([4, 6, 5])
    expect(plan.build.map((entry) => entry.key)).toEqual(['shot-01', 'shot-02', 'shot-03'])
  })

  it('carries the roles through, per shot', () => {
    const plan = planScenarioShots(scenario)
    expect(plan.build[0]!.roles).toEqual([])
    expect(plan.build[1]!.roles).toEqual(['Maya'])
    expect(plan.build[2]!.roles).toEqual(['Maya'])
  })

  it('reports a shot with no exit frame instead of silently cutting on nothing', () => {
    const plan = planScenarioShots(scenario)
    expect(plan.build[2]!.notes.join(' ')).toContain('closing frame')
    expect(plan.build[1]!.notes).toEqual([])
  })

  it('skips what already exists, so a rebuild adds instead of duplicating', () => {
    const plan = planScenarioShots(scenario, { existingKeys: ['shot-01', 'shot-02'] })
    expect(plan.alreadyBuilt.map((entry) => entry.key)).toEqual(['shot-01', 'shot-02'])
    expect(plan.build.map((entry) => entry.key)).toEqual(['shot-03'])
  })

  it('notes every substitution the target model forced', () => {
    const onOldModel = planScenario({ brief: 'Une course', modelId: SEEDANCE_15, beats })
    const plan = planScenarioShots(onOldModel)
    expect(plan.build[0]!.recipeId).toBe('shot-reaction') // insert does not run there
    expect(plan.build[0]!.notes.join(' ')).toContain('shot-insert')
  })

  it('skips a shot no preset can realize, with a usable reason', () => {
    const plan = planScenarioShots({ ...scenario, modelId: 'grok-imagine/text-to-video' })
    expect(plan.build).toEqual([])
    expect(plan.skipped).toHaveLength(3)
    expect(plan.skipped[0]!.reason).toContain('grok-imagine/text-to-video')
  })
})
