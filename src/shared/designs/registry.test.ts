import { describe, expect, it } from 'vitest'
import { getModel } from '../models'
import { STYLES, getStyle } from '../styles/registry'
import {
  DESIGN_RECIPES,
  buildDesignPrompt,
  designIntent,
  designNodeParams,
  designRecipeIds,
  getDesignRecipe
} from './registry'

const anime = getStyle('anime')!

describe('design recipe registry', () => {
  it('has unique ids and resolves by id', () => {
    expect(new Set(designRecipeIds).size).toBe(DESIGN_RECIPES.length)
    for (const r of DESIGN_RECIPES) expect(getDesignRecipe(r.id)).toBe(r)
    expect(getDesignRecipe('nope')).toBeUndefined()
  })

  for (const recipe of DESIGN_RECIPES) {
    describe(recipe.id, () => {
      it('targets a known image model', () => {
        const model = getModel(recipe.defaultModelId)
        expect(model, `unknown model ${recipe.defaultModelId}`).toBeDefined()
        expect(model!.kind).toBe('image')
      })

      it('byModel overrides only reference known models', () => {
        for (const modelId of Object.keys(recipe.byModel ?? {})) {
          expect(getModel(modelId), `unknown override model ${modelId}`).toBeDefined()
        }
      })

      it('keeps its slot when the description is empty', () => {
        expect(recipe.slot).toMatch(/^\[[A-Z ]+\]$/)
        const prompt = buildDesignPrompt(recipe, recipe.defaultModelId, { description: '  ' })
        expect(prompt).toContain(recipe.slot)
      })

      it('injects the description and the image fragment, never the bible', () => {
        const prompt = buildDesignPrompt(recipe, recipe.defaultModelId, {
          description: 'Léa, pink hair',
          style: anime
        })
        expect(prompt).toContain('Léa, pink hair')
        expect(prompt).not.toContain(recipe.slot)
        expect(prompt).toContain(anime.imageFragment)
        // The bible is appended at payload time via the applyVideoStyle marker,
        // not baked into the stored prompt.
        expect(prompt).not.toContain(anime.styleBible)
      })

      it('builds a valid prompt for every style (and none)', () => {
        for (const style of [undefined, ...STYLES]) {
          const prompt = buildDesignPrompt(recipe, recipe.defaultModelId, {
            description: 'subject',
            style
          })
          expect(prompt.length).toBeGreaterThan(40)
          expect(prompt).not.toMatch(/\s{2,}/)
        }
      })

      it('produces params that validate against the model schema', () => {
        const params = designNodeParams(recipe, recipe.defaultModelId, {
          description: 'subject',
          style: anime
        })
        expect(params.designId).toBe(recipe.id)
        expect(params.applyVideoStyle).toBe(true)
        const model = getModel(recipe.defaultModelId)!
        const parsed = model.paramsSchema.safeParse(params)
        expect(
          parsed.success,
          `invalid params — ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`
        ).toBe(true)
        // Apart from the deliberate markers, only declared model fields.
        const known = new Set(model.paramFields.map((f) => f.key))
        for (const key of Object.keys(params)) {
          if (key === 'designId' || key === 'designSubject' || key === 'applyVideoStyle') continue
          expect(known.has(key), `param "${key}" is not a ${model.id} field`).toBe(true)
        }
      })

      it('stamps the subject marker only when a description is given', () => {
        const withSubject = designNodeParams(recipe, recipe.defaultModelId, {
          description: '  Léa, pink hair  '
        })
        expect(withSubject.designSubject).toBe('Léa, pink hair')
        const withoutSubject = designNodeParams(recipe, recipe.defaultModelId, {
          description: '  '
        })
        expect('designSubject' in withoutSubject).toBe(false)
      })

      it('rejects unknown models', () => {
        expect(() => designNodeParams(recipe, 'nope', { description: '' })).toThrow(/Unknown model/)
      })

      it('states the reference-only rule in the intent (template-test convention)', () => {
        expect(designIntent(recipe)).toMatch(/reference/i)
      })
    })
  }
})
