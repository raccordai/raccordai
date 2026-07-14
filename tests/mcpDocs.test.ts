import { describe, expect, it } from 'vitest'
import { MODELS } from '../src/shared/models'
import { STYLES } from '../src/shared/styles/registry'
import { WORKFLOW_TEMPLATES } from '../src/shared/templates/registry'
import { DOC_TOPICS, getDoc } from '../src/main/mcp/docs'

describe('agent docs topics', () => {
  it('serves a prompting guide for every model that declares one', () => {
    for (const m of MODELS.filter((m) => m.promptGuide)) {
      const doc = getDoc(`prompting:${m.id}`)
      expect(doc).toContain(m.label)
      expect(doc.length).toBeGreaterThan(500)
    }
    expect(getDoc('prompting:nope')).toContain('Unknown model')
  })

  it('the model sheet points to the prompting topic when a guide exists', () => {
    for (const m of MODELS.filter((m) => m.promptGuide)) {
      expect(getDoc(`model:${m.id}`)).toContain(`prompting:${m.id}`)
    }
  })

  it('serves the styles index with every style bible', () => {
    const doc = getDoc('styles')
    for (const s of STYLES) {
      expect(doc).toContain(s.id)
      expect(doc).toContain(s.styleBible)
    }
  })

  it('serves the template index and each blueprint as valid workflow JSON', () => {
    const index = getDoc('templates')
    for (const t of WORKFLOW_TEMPLATES) {
      expect(index).toContain(t.id)
      const detail = getDoc(`template:${t.id}`)
      const jsonStart = detail.indexOf('{')
      const workflow = JSON.parse(detail.slice(jsonStart))
      expect(workflow.version).toBe(1)
      expect(workflow.nodes.length).toBeGreaterThan(0)
    }
    expect(getDoc('template:nope')).toContain('Unknown template')
  })

  it('lists every topic family in DOC_TOPICS and the overview', () => {
    for (const topic of ['prompting:<id>', 'styles', 'templates', 'template:<id>']) {
      expect(DOC_TOPICS).toContain(topic)
    }
    const overview = getDoc('overview')
    expect(overview).toContain('styles')
    expect(overview).toContain('templates')
  })
})
