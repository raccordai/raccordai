import { describe, expect, it } from 'vitest'
import enCommon from '../i18n/locales/en/common.json'
import frCommon from '../i18n/locales/fr/common.json'
import { getModel } from '../models'
import { mentionsMotion } from '../promptLint'
import { CAMERA_MODES, beatCountFor, detectCameraDoctrines } from '../prompting/seedance'
import { SCREEN_DIRECTIONS } from '../scenario'
import { STYLES, getStyle } from '../styles/registry'
import {
  DESIGN_RECIPES,
  RECIPES,
  RECIPE_FIELDS,
  SHOT_RECIPES,
  buildRecipePrompt,
  defaultModeOf,
  designRecipeIds,
  getDesignRecipe,
  getRecipe,
  recipeFieldsFor,
  recipeIds,
  recipeIntent,
  recipeModelChoices,
  recipeNodeParams,
  resolveRecipeHandle,
  type RecipeField
} from './registry'

const anime = getStyle('anime')!

/** Resolves a dotted i18n key against a locale resource, or undefined. */
function lookup(resource: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], resource)
}

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

function expectLocalized(key: string): void {
  for (const [locale, resource] of LOCALES) {
    expect(typeof lookup(resource, key), `${key} missing in ${locale}/common.json`).toBe('string')
  }
}

/** Params that are deliberately markers, not model fields. */
const RECIPE_MARKERS: string[] = [
  'recipeId',
  'recipeMode',
  'designId',
  'designSubject',
  'applyVideoStyle'
]

/** Every field descriptor actually used by at least one recipe. */
const usedFields = new Map<string, RecipeField>()
for (const recipe of RECIPES) {
  for (const field of recipe.fields) usedFields.set(field.key, field)
}

describe('recipe registry', () => {
  it('has unique ids and resolves by id', () => {
    expect(new Set(recipeIds).size).toBe(RECIPES.length)
    for (const r of RECIPES) expect(getRecipe(r.id)).toBe(r)
    expect(getRecipe('nope')).toBeUndefined()
  })

  it('splits the two kinds and never resolves a shot as a design sheet', () => {
    expect(DESIGN_RECIPES.length + SHOT_RECIPES.length).toBe(RECIPES.length)
    for (const r of DESIGN_RECIPES) expect(getDesignRecipe(r.id)).toBe(r)
    // `params.designId` means "this output is a reference sheet" — the lint and
    // the design library key off it, so a shot recipe must never answer to it.
    for (const r of SHOT_RECIPES) expect(getDesignRecipe(r.id)).toBeUndefined()
    expect(designRecipeIds).toEqual(DESIGN_RECIPES.map((r) => r.id))
  })

  it('keeps the shared screen-direction vocabulary in sync with the scenario', () => {
    const values = RECIPE_FIELDS.screenDirection.options.map((o) => o.value)
    expect(values).toEqual([...SCREEN_DIRECTIONS])
  })

  describe('field vocabulary', () => {
    it('declares no field no recipe uses (dead vocabulary)', () => {
      for (const key of Object.keys(RECIPE_FIELDS)) {
        expect(usedFields.has(key), `field "${key}" is declared but used by no recipe`).toBe(true)
      }
    })

    it('every used field is a descriptor from the shared vocabulary', () => {
      const declared = Object.values(RECIPE_FIELDS) as RecipeField[]
      for (const [key, field] of usedFields) {
        expect(declared.includes(field), `field "${key}" is not RECIPE_FIELDS.${key}`).toBe(true)
        expect(field.key).toBe(key)
      }
    })

    it('select fields carry non-empty option fragments with unique values', () => {
      for (const [key, field] of usedFields) {
        if (field.type !== 'select') {
          expect(field.options, `${key}: only select fields take options`).toBeUndefined()
          continue
        }
        expect(field.options, `${key}: a select needs options`).toBeDefined()
        const values = field.options!.map((o) => o.value)
        expect(new Set(values).size, `${key}: duplicate option values`).toBe(values.length)
        for (const option of field.options!) {
          expect(
            option.fragment.trim().length,
            `${key}.${option.value}: empty fragment`
          ).toBeGreaterThan(0)
        }
        expect(
          values.includes(field.defaultValue ?? ''),
          `${key}: defaultValue must name one of its options`
        ).toBe(true)
      }
    })

    it('labels, placeholders and option names resolve in both locales', () => {
      for (const [key, field] of usedFields) {
        expectLocalized(`recipeFields.${key}.label`)
        // `description` takes its placeholder per recipe (designs.<id>.placeholder).
        if (key !== 'description' && field.type !== 'select') {
          expectLocalized(`recipeFields.${key}.placeholder`)
        }
        for (const option of field.options ?? []) {
          expectLocalized(`recipeFields.${key}.options.${option.value}`)
        }
      }
    })

    it('declares no i18n entry without a matching field or option (both directions)', () => {
      const section = lookup(frCommon, 'recipeFields') as Record<string, Record<string, unknown>>
      for (const key of Object.keys(section)) {
        const field = usedFields.get(key)
        expect(field, `recipeFields.${key} has no field in the registry`).toBeDefined()
        const options = section[key]!.options as Record<string, unknown> | undefined
        for (const value of Object.keys(options ?? {})) {
          expect(
            (field!.options ?? []).some((o) => o.value === value),
            `recipeFields.${key}.options.${value} has no option in the registry`
          ).toBe(true)
        }
      }
    })

    it('mode names resolve in both locales', () => {
      const modeIds = new Set(RECIPES.flatMap((r) => r.modes.map((m) => m.id)))
      for (const id of modeIds) expectLocalized(`recipeModes.${id}.label`)
    })
  })

  for (const recipe of RECIPES) {
    describe(recipe.id, () => {
      it('declares modes on known models of its own kind', () => {
        expect(recipe.modes.length).toBeGreaterThan(0)
        const expectedKind = recipe.kind === 'shot' ? 'video' : 'image'
        for (const mode of recipe.modes) {
          const model = getModel(mode.modelId)
          expect(model, `${mode.id}: unknown model ${mode.modelId}`).toBeDefined()
          expect(model!.kind, `${mode.id}: ${mode.modelId} is not a ${expectedKind} model`).toBe(
            expectedKind
          )
          expect(
            recipe.supportedModels.includes(mode.modelId),
            `${mode.id}: ${mode.modelId} is missing from supportedModels`
          ).toBe(true)
        }
        expect(new Set(recipe.modes.map((m) => m.id)).size).toBe(recipe.modes.length)
      })

      it('supports only known models of one kind', () => {
        expect(recipe.supportedModels.length).toBeGreaterThan(0)
        for (const modelId of recipe.supportedModels) {
          const model = getModel(modelId)
          expect(model, `unknown supported model ${modelId}`).toBeDefined()
          expect(model!.kind).toBe(recipe.kind === 'shot' ? 'video' : 'image')
        }
      })

      it('byModel overrides only reference supported models', () => {
        for (const modelId of Object.keys(recipe.byModel ?? {})) {
          expect(
            recipe.supportedModels.includes(modelId),
            `byModel["${modelId}"] is not in supportedModels`
          ).toBe(true)
        }
      })

      it('asks for the description first and only for known fields', () => {
        expect(recipe.fields[0]).toBe(RECIPE_FIELDS.description)
        const keys = recipe.fields.map((f) => f.key)
        expect(new Set(keys).size, 'duplicate field').toBe(keys.length)
        for (const field of recipe.fields) {
          if (!field.modes) continue
          for (const modeId of field.modes) {
            expect(
              recipe.modes.some((m) => m.id === modeId),
              `field "${field.key}" is restricted to unknown mode "${modeId}"`
            ).toBe(true)
          }
        }
      })

      it('resolves every source mode to a real input handle of the right role', () => {
        for (const mode of recipe.modes) {
          if (!mode.source) continue
          for (const modelId of recipeModelChoices(recipe, mode)) {
            const handle = resolveRecipeHandle(modelId, mode.source)
            expect(handle, `${mode.id}: no ${mode.source.role} handle on ${modelId}`).toBeDefined()
            expect(handle!.accepts).toContain(mode.source.accepts)
            expect(handle!.frameAnchor ?? false).toBe(mode.source.role === 'anchor')
          }
        }
      })

      it('states what a from-image sheet must preserve (no silent drift)', () => {
        if (recipe.kind !== 'reference') return
        const fromImage = recipe.modes.find((m) => m.source?.accepts === 'image')
        if (!fromImage) return
        expect(
          recipe.fields.includes(RECIPE_FIELDS.preserve),
          'an image-to-image recipe without a preserve clause drifts on every iteration'
        ).toBe(true)
        expect(recipeFieldsFor(recipe, fromImage)).toContain(RECIPE_FIELDS.preserve)
        expect(
          recipeFieldsFor(recipe, defaultModeOf(recipe)).includes(RECIPE_FIELDS.preserve)
        ).toBe(fromImage === defaultModeOf(recipe))
      })

      it('names its i18n entries in both locales', () => {
        for (const suffix of ['name', 'desc', 'placeholder']) {
          expectLocalized(`designs.${recipe.id}.${suffix}`)
        }
      })

      it('keeps its slot when the description is empty', () => {
        expect(recipe.slot).toMatch(/^\[[A-Z ]+\]$/)
        const prompt = buildRecipePrompt(recipe, defaultModeOf(recipe).modelId, {
          values: { description: '  ' }
        })
        expect(prompt).toContain(recipe.slot)
      })

      it('injects the description, never the bible', () => {
        const prompt = buildRecipePrompt(recipe, defaultModeOf(recipe).modelId, {
          values: { description: 'Léa, pink hair' },
          style: anime,
          mode: defaultModeOf(recipe)
        })
        expect(prompt).toContain('Léa, pink hair')
        expect(prompt).not.toContain(recipe.slot)
        // Stills bake the image fragment in; a SHOT stores only the body of the
        // sandwich — its universe is selected at payload time, so a style
        // switch re-selects it (§6.9).
        if (recipe.kind === 'reference') expect(prompt).toContain(anime.imageFragment)
        else expect(prompt).not.toContain(anime.imageFragment)
        // The bible is composed in at payload time via the applyVideoStyle
        // marker, never baked into the stored prompt.
        expect(prompt).not.toContain(anime.styleBible)
        expect(prompt).not.toContain(anime.styleBibleCompact)
      })

      it('builds a clean prompt for every style, mode and offered model', () => {
        for (const style of [undefined, ...STYLES]) {
          for (const mode of recipe.modes) {
            for (const modelId of recipeModelChoices(recipe, mode)) {
              const prompt = buildRecipePrompt(recipe, modelId, {
                values: { description: 'subject' },
                ...(style ? { style } : {}),
                mode
              })
              expect(prompt.length).toBeGreaterThan(40)
              // Newlines are structural in a bracketed timeline; runs of spaces
              // inside a line are the actual defect.
              for (const line of prompt.split('\n')) {
                expect(line, `${mode.id}/${modelId}: collapsed whitespace`).not.toMatch(/ {2,}/)
                expect(line, `${mode.id}/${modelId}: ragged line`).toBe(line.trimEnd())
              }
              expect(prompt, `${mode.id}/${modelId}: unresolved fragment`).not.toContain(
                'undefined'
              )
            }
          }
        }
      })

      it('produces params that validate against every offered model schema', () => {
        for (const mode of recipe.modes) {
          for (const modelId of recipeModelChoices(recipe, mode)) {
            const params = recipeNodeParams({
              recipe,
              mode,
              modelId,
              values: { description: 'subject' },
              style: anime
            })
            expect(params.recipeId).toBe(recipe.id)
            expect(params.recipeMode).toBe(mode.id)
            expect(params.applyVideoStyle).toBe(true)
            // Only reference sheets claim the design marker.
            expect(params.designId).toBe(recipe.kind === 'reference' ? recipe.id : undefined)
            const model = getModel(modelId)!
            const parsed = model.paramsSchema.safeParse(params)
            expect(
              parsed.success,
              `${mode.id}/${modelId}: invalid params — ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`
            ).toBe(true)
            // Apart from the deliberate markers, only declared model fields.
            const known = new Set(model.paramFields.map((f) => f.key))
            for (const key of Object.keys(params)) {
              if (RECIPE_MARKERS.includes(key)) continue
              expect(known.has(key), `param "${key}" is not a ${modelId} field`).toBe(true)
            }
          }
        }
      })

      it('stamps the subject marker only when a description is given', () => {
        const mode = defaultModeOf(recipe)
        const withSubject = recipeNodeParams({
          recipe,
          mode,
          values: { description: '  Léa, pink hair  ' }
        })
        expect(withSubject.designSubject).toBe('Léa, pink hair')
        const withoutSubject = recipeNodeParams({ recipe, mode, values: { description: '  ' } })
        expect('designSubject' in withoutSubject).toBe(false)
      })

      it('rejects a model it does not support', () => {
        expect(() =>
          recipeNodeParams({
            recipe,
            mode: defaultModeOf(recipe),
            modelId: 'not-a-model',
            values: {}
          })
        ).toThrow(/not supported by recipe/)
      })

      it('states its wiring rule in the intent (template-test convention)', () => {
        const intent = recipeIntent(recipe)
        expect(intent).toMatch(recipe.kind === 'shot' ? /camera setup/i : /reference/i)
      })
    })
  }

  describe('shot presets — the stored body', () => {
    it('is a bracketed timeline whose beats cover the clip exactly once', () => {
      for (const recipe of SHOT_RECIPES) {
        const seconds = Number((recipe.params ?? {}).duration)
        const prompt = buildRecipePrompt(recipe, defaultModeOf(recipe).modelId, {
          values: { description: 'a courier in traffic' },
          mode: defaultModeOf(recipe)
        })
        expect(prompt, `${recipe.id}: no timeline`).toContain('[TIMELINE]')
        const beats = [...prompt.matchAll(/^(\d+(?:\.\d)?)-(\d+(?:\.\d)?)s: (\[[^\]]+\])/gm)]
        expect(beats.length, `${recipe.id}: beat count`).toBe(beatCountFor(seconds))
        expect(Number(beats[0]![1]), `${recipe.id}: first beat starts at 0`).toBe(0)
        expect(Number(beats.at(-1)![2]), `${recipe.id}: last beat ends at the clip length`).toBe(
          seconds
        )
        // Contiguous: every beat starts where the previous one ended.
        for (let i = 1; i < beats.length; i++) {
          expect(Number(beats[i]![1]), `${recipe.id}: gap before beat ${i + 1}`).toBe(
            Number(beats[i - 1]![2])
          )
        }
        // ONE camera mode per beat, and every bracket from the vocabulary.
        for (const beat of beats) {
          expect(
            CAMERA_MODES.some((m) => m.bracket === beat[3]),
            `${recipe.id}: "${beat[3]}" is not a camera-mode bracket`
          ).toBe(true)
        }
      }
    })

    it('speaks the register of the video’s art direction, never both at once', () => {
      for (const recipe of SHOT_RECIPES) {
        for (const style of [undefined, ...STYLES]) {
          const prompt = buildRecipePrompt(recipe, defaultModeOf(recipe).modelId, {
            values: { description: 'a courier in traffic' },
            ...(style ? { style } : {}),
            mode: defaultModeOf(recipe)
          })
          const doctrines = detectCameraDoctrines(prompt)
          expect(
            doctrines.embodied && doctrines.disembodied,
            `${recipe.id}/${style?.id ?? 'no style'}: a body AND a ghost`
          ).toBe(false)
        }
      }
    })

    it('drops to a real model parameter where one exists, instead of asking in words', () => {
      // Seedance 1.5 documents `fixed_lens: true` as THE way to lock the camera.
      const locked = getRecipe('shot-locked-off')!
      const params = recipeNodeParams({
        recipe: locked,
        mode: defaultModeOf(locked),
        modelId: 'bytedance/seedance-1.5-pro',
        values: { description: 'the workshop door' }
      })
      expect(params.fixed_lens).toBe(true)
      const orbit = getRecipe('shot-orbit')!
      expect(
        recipeNodeParams({
          recipe: orbit,
          mode: defaultModeOf(orbit),
          values: { description: 'the headphones' }
        }).fixed_lens
      ).toBeUndefined()
    })
  })

  // A preset earns its place by turning a lint warning green BY CONSTRUCTION —
  // otherwise it is decoration on top of the same empty textarea.
  describe('shot presets', () => {
    it('always describe how the shot moves (the motion lint rule, pre-satisfied)', () => {
      for (const recipe of SHOT_RECIPES) {
        for (const mode of recipe.modes) {
          for (const style of [undefined, anime]) {
            const prompt = buildRecipePrompt(recipe, mode.modelId, {
              values: { description: 'a courier in traffic' },
              ...(style ? { style } : {}),
              mode
            })
            expect(mentionsMotion(prompt), `${recipe.id}/${mode.id}: no motion vocabulary`).toBe(
              true
            )
          }
        }
      }
    })

    it('never chain the previous clip’s last frame (the cut doctrine)', () => {
      for (const recipe of SHOT_RECIPES) {
        for (const mode of recipe.modes) {
          if (!mode.source) continue
          // An image source is the shot's OWN opening still; continuity comes
          // from an @Video reference, never from a generated closing frame.
          const handle = resolveRecipeHandle(mode.modelId, mode.source)!
          expect(handle.key).not.toBe('lastFrame')
        }
      }
    })
  })
})
