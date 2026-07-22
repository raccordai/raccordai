import { describe, expect, it } from 'vitest'
import enCommon from '../i18n/locales/en/common.json'
import frCommon from '../i18n/locales/fr/common.json'
import { MODELS, getModel } from '../models'
import { getStyle } from '../styles/registry'
import {
  WORKFLOW_TEMPLATES,
  fillTemplateSlots,
  getWorkflowTemplate,
  workflowTemplateIds
} from './registry'

describe('workflow template registry', () => {
  it('has unique ids and resolves by id', () => {
    expect(new Set(workflowTemplateIds).size).toBe(WORKFLOW_TEMPLATES.length)
    for (const t of WORKFLOW_TEMPLATES) expect(getWorkflowTemplate(t.id)).toBe(t)
    expect(getWorkflowTemplate('nope')).toBeUndefined()
  })

  it('references a valid style template', () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(getStyle(t.styleId), `${t.id}: unknown style ${t.styleId}`).toBeDefined()
    }
  })

  for (const t of WORKFLOW_TEMPLATES) {
    describe(t.id, () => {
      it('nodes use known models and params that validate against their schema', () => {
        for (const node of t.workflow.nodes) {
          const model = getModel(node.modelId)
          expect(model, `${node.key}: unknown model ${node.modelId}`).toBeDefined()
          const parsed = model!.paramsSchema.safeParse(node.params)
          expect(
            parsed.success,
            `${node.key}: invalid params — ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`
          ).toBe(true)
        }
      })

      it('params only use keys the model declares (catches model-swap leftovers)', () => {
        for (const node of t.workflow.nodes) {
          const model = getModel(node.modelId)!
          const known = new Set(model.paramFields.map((f) => f.key))
          for (const key of Object.keys(node.params)) {
            expect(known.has(key), `${node.key}: param "${key}" is not a ${model.id} field`).toBe(
              true
            )
          }
        }
      })

      it('edges wire existing nodes through valid input handles', () => {
        const keys = new Set(t.workflow.nodes.map((n) => n.key))
        expect(keys.size).toBe(t.workflow.nodes.length)
        for (const edge of t.workflow.edges) {
          expect(keys.has(edge.from), `edge from unknown node ${edge.from}`).toBe(true)
          expect(keys.has(edge.to), `edge to unknown node ${edge.to}`).toBe(true)
          const target = getModel(t.workflow.nodes.find((n) => n.key === edge.to)!.modelId)!
          expect(
            target.inputs.some((h) => h.key === edge.input),
            `${edge.to}: no input handle "${edge.input}" on ${target.id}`
          ).toBe(true)
          if (edge.output === 'lastFrame') {
            const source = getModel(t.workflow.nodes.find((n) => n.key === edge.from)!.modelId)!
            expect(
              source.outputs.some((o) => o.key === 'lastFrame'),
              `${edge.from}: ${source.id} has no lastFrame output`
            ).toBe(true)
          }
        }
      })

      it('declares exactly the slot tokens present in the blueprint (no drift)', () => {
        // Whole-workflow scan (prompts, labels, intents, music titles…) — the
        // slot form string-replaces across the full JSON, so parity must hold
        // everywhere, in both directions.
        const found = new Set(JSON.stringify(t.workflow).match(/\[[A-Z][A-Z_ ]*\]/g) ?? [])
        const declared = new Set(t.slots.map((s) => s.token))
        expect(declared).toEqual(found)
        for (const slot of t.slots) {
          expect(slot.token).toMatch(/^\[[A-Z][A-Z_ ]*\]$/)
          expect(slot.example.trim().length, `${slot.token}: empty example`).toBeGreaterThan(0)
        }
      })

      it('slot labels resolve in both locales', () => {
        for (const slot of t.slots) {
          expect(slot.i18nKey).toMatch(/^templates\.slots\./)
          for (const [locale, resource] of [
            ['fr', frCommon],
            ['en', enCommon]
          ] as const) {
            const value = slot.i18nKey
              .split('.')
              .reduce<unknown>(
                (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
                resource
              )
            expect(typeof value, `${slot.i18nKey} missing in ${locale}/common.json`).toBe('string')
          }
        }
      })

      it('visual prompts carry the style bible for cross-shot consistency', () => {
        const bible = getStyle(t.styleId)!.styleBible
        for (const node of t.workflow.nodes) {
          const model = getModel(node.modelId)!
          if (model.kind === 'audio') continue
          expect(
            String(node.params.prompt).includes(bible),
            `${node.key}: prompt is missing the style bible`
          ).toBe(true)
        }
      })

      it('is serializable as importable workflow JSON', () => {
        const json = JSON.stringify(t.workflow)
        const roundTrip = JSON.parse(json)
        expect(roundTrip.version).toBe(1)
        expect(Array.isArray(roundTrip.nodes)).toBe(true)
        expect(Array.isArray(roundTrip.edges)).toBe(true)
      })
    })
  }

  describe('fillTemplateSlots', () => {
    const t = getWorkflowTemplate('product-commercial')!

    it('replaces every occurrence of filled tokens across the whole blueprint', () => {
      const filled = fillTemplateSlots(t.workflow, {
        '[PRODUCT]': 'Aurora headphones',
        '[SETTING]': 'a sunlit loft',
        '[TAGLINE]': 'Sound, redefined.'
      })
      const text = JSON.stringify(filled)
      expect(text).not.toMatch(/\[[A-Z][A-Z_ ]*\]/)
      expect(text).toContain('Aurora headphones')
      // Intents are covered too, not just prompts ([TAGLINE] only appears there).
      expect(filled.nodes.find((n) => n.key === 'shot-3')!.intent).toContain('Sound, redefined.')
    })

    it('leaves the token in place for empty or blank values', () => {
      const filled = fillTemplateSlots(t.workflow, {
        '[PRODUCT]': 'Aurora headphones',
        '[SETTING]': '   ',
        '[TAGLINE]': ''
      })
      const text = JSON.stringify(filled)
      expect(text).toContain('[SETTING]')
      expect(text).toContain('[TAGLINE]')
      expect(text).not.toContain('[PRODUCT]')
    })

    it('is safe with quotes, backslashes and replacement-pattern characters', () => {
      const value = 'the "Über-$&\\1" bottle'
      const filled = fillTemplateSlots(t.workflow, { '[PRODUCT]': value })
      const prompt = String(filled.nodes.find((n) => n.key === 'hero-image')!.params.prompt)
      expect(prompt).toContain(value)
      expect(() => JSON.parse(JSON.stringify(filled))).not.toThrow()
    })

    it('does not mutate the source blueprint', () => {
      const before = JSON.stringify(t.workflow)
      fillTemplateSlots(t.workflow, { '[PRODUCT]': 'mutated?' })
      expect(JSON.stringify(t.workflow)).toBe(before)
    })
  })

  // Frame anchors (seedance-1.5 input_urls, grok image_urls) put the image ON
  // SCREEN — a design/reference image wired there leaks into the clip (the
  // anime-sequence storyboard bug). References may only feed reference-capable
  // handles, and prompts must assign them a role.
  describe('input semantics', () => {
    it('image nodes marked as references never feed a frame-anchor handle', () => {
      // Derived from the registry: each InputHandle declares its own semantics,
      // PER MODEL — the same key can be a frame anchor on one model (seedance-1.5
      // "input_urls") and a plain edit input on another (gpt-image-2-i2i).
      expect(MODELS.some((m) => m.inputs.some((h) => h.frameAnchor))).toBe(true)
      for (const t of WORKFLOW_TEMPLATES) {
        for (const edge of t.workflow.edges) {
          const source = t.workflow.nodes.find((n) => n.key === edge.from)!
          const isReferenceImage = /reference/i.test(source.intent ?? '')
          if (isReferenceImage) {
            const target = getModel(t.workflow.nodes.find((n) => n.key === edge.to)!.modelId)!
            const handle = target.inputs.find((h) => h.key === edge.input)
            expect(
              handle?.frameAnchor ?? false,
              `${t.id}: reference image "${edge.from}" wired to frame-anchor "${edge.input}" of "${edge.to}" — it would appear on screen`
            ).toBe(false)
          }
        }
      }
    })

    it('storyboard-sequence wires sheet @Image1, storyboard @Image2, continuity @Image3', () => {
      const t = getWorkflowTemplate('storyboard-sequence')!
      // The storyboard is built FROM the character sheet (identity locked at storyboard stage).
      expect(t.workflow.edges[0]).toEqual({
        from: 'character-sheet',
        to: 'storyboard',
        input: 'input_urls',
        output: 'output'
      })
      for (const shot of ['shot-1', 'shot-2', 'shot-3']) {
        const incoming = t.workflow.edges.filter((e) => e.to === shot)
        // Edge array order IS the @Image numbering (import preserves it).
        expect(incoming[0]!.from, `${shot}: @Image1 must be the character sheet`).toBe(
          'character-sheet'
        )
        expect(incoming[1]!.from, `${shot}: @Image2 must be the storyboard`).toBe('storyboard')
        const prompt = String(t.workflow.nodes.find((n) => n.key === shot)!.params.prompt)
        expect(prompt).toContain('@Image1')
        expect(prompt).toContain('@Image2 is the 9-panel storyboard')
        expect(prompt).toContain('left to right, top to bottom')
        // Anti-grid guard: without it the model may render the storyboard grid
        // itself in the video instead of treating it as a staging plan.
        expect(prompt).toContain('must NEVER appear on screen')
        expect(prompt).toContain('no 3x3 grid, no panel borders, no panel numbers')
        if (incoming.length > 2) {
          expect(incoming[2]!.output).toBe('lastFrame')
          expect(prompt).toContain('@Image3 as the first frame')
        }
      }
    })

    it('anime-sequence wires the key visual as @Image1 on every shot, continuity second', () => {
      const t = getWorkflowTemplate('anime-sequence')!
      for (const shot of ['shot-1', 'shot-2', 'shot-3']) {
        const incoming = t.workflow.edges.filter((e) => e.to === shot)
        // Edge array order IS the @Image numbering (import preserves it).
        expect(incoming[0]!.from, `${shot}: @Image1 must be the key visual`).toBe('key-visual')
        const prompt = String(t.workflow.nodes.find((n) => n.key === shot)!.params.prompt)
        expect(prompt).toContain('@Image1')
        if (incoming.length > 1) {
          expect(incoming[1]!.output).toBe('lastFrame')
          expect(prompt).toContain('@Image2 as the first frame')
        }
      }
    })
  })
})
