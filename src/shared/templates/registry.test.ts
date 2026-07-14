import { describe, expect, it } from 'vitest'
import { getModel } from '../models'
import { getStyle } from '../styles/registry'
import { WORKFLOW_TEMPLATES, getWorkflowTemplate, workflowTemplateIds } from './registry'

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

      it('declared slots all appear in the blueprint', () => {
        const text = JSON.stringify(t.workflow)
        for (const slot of t.slots) {
          expect(slot).toMatch(/^\[[A-Z ]+\]$/)
          expect(text.includes(slot), `slot ${slot} not used`).toBe(true)
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

  // Frame anchors (seedance-1.5 input_urls, grok image_urls) put the image ON
  // SCREEN — a design/reference image wired there leaks into the clip (the
  // anime-sequence storyboard bug). References may only feed reference-capable
  // handles, and prompts must assign them a role.
  describe('input semantics', () => {
    it('image nodes marked as references never feed a frame-anchor handle', () => {
      const FRAME_ANCHORS = new Set(['input_urls', 'image_urls'])
      for (const t of WORKFLOW_TEMPLATES) {
        for (const edge of t.workflow.edges) {
          const source = t.workflow.nodes.find((n) => n.key === edge.from)!
          const isReferenceImage = /reference/i.test(source.intent ?? '')
          if (isReferenceImage) {
            expect(
              FRAME_ANCHORS.has(edge.input),
              `${t.id}: reference image "${edge.from}" wired to frame-anchor "${edge.input}" of "${edge.to}" — it would appear on screen`
            ).toBe(false)
          }
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
