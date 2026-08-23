import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { WORKFLOW_TEMPLATES } from '@shared/templates/registry'
import { createProject } from './projects'
import { getVideo } from './videos'
import { listGraph } from './graph'
import { createVideoFromTemplate } from './templates'

let projectId: string

beforeEach(() => {
  useTestDatabase()
  projectId = createProject('P').id
})

afterEach(() => resetTestDatabase())

// Any template with at least one slot keeps the test honest about filling.
const template = WORKFLOW_TEMPLATES.find((t) => t.slots.length > 0)!

describe('createVideoFromTemplate', () => {
  it('creates the video, imports the blueprint with slots filled and applies the style', () => {
    const firstSlot = template.slots[0]!
    const result = createVideoFromTemplate({
      projectId,
      templateId: template.id,
      name: 'From template',
      slots: { [firstSlot.token]: firstSlot.example }
    })
    expect(result.nodeCount).toBe(template.workflow.nodes.length)
    expect(result.styleId).toBe(template.styleId)
    // The filled token is gone from every prompt; unfilled ones are reported.
    const { nodes } = listGraph(result.videoId)
    const allPrompts = nodes
      .map((n) => (n.params as { prompt?: unknown } | null)?.prompt)
      .filter((p): p is string => typeof p === 'string')
      .join('\n')
    expect(allPrompts).not.toContain(firstSlot.token)
    expect(result.unfilledTokens).toEqual(template.slots.slice(1).map((s) => s.token))
    expect(getVideo(result.videoId)?.styleId).toBe(template.styleId)
    expect(getVideo(result.videoId)?.name).toBe('From template')
  })

  it('defaults the name to the template label and rejects unknown ids/slots', () => {
    const result = createVideoFromTemplate({ projectId, templateId: template.id })
    expect(getVideo(result.videoId)?.name).toBe(template.label)

    expect(() => createVideoFromTemplate({ projectId, templateId: 'nope' })).toThrow(
      'Unknown templateId'
    )
    expect(() =>
      createVideoFromTemplate({ projectId, templateId: template.id, slots: { '[NOPE]': 'x' } })
    ).toThrow('has no slot')
  })
})
