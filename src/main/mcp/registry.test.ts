import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS, isToolMediaResult } from './registry'
import { DOC_TOPICS, getDoc } from './docs'

/**
 * Registry invariants (§4.10 phase 3). Every capability entry must be fully
 * declared: both agent surfaces (MCP + chat adapter) and the docs are driven
 * by these fields.
 */
describe('AGENT_TOOLS registry', () => {
  it('has unique snake_case names', () => {
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('declares scope and risk on every tool', () => {
    for (const tool of AGENT_TOOLS) {
      expect(['global', 'project', 'video'], tool.name).toContain(tool.scope)
      expect(['read', 'write', 'destructive', 'spending'], tool.name).toContain(tool.risk)
    }
  })

  it('keeps descriptions short (depth belongs in the docs tool)', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10)
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(400)
    }
  })

  it('scope matches the id params the schema asks for', () => {
    for (const tool of AGENT_TOOLS) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      )
      if (tool.scope === 'video') expect(properties, tool.name).toContain('videoId')
      if (tool.scope === 'project') expect(properties, tool.name).toContain('projectId')
      // Global tools must not silently depend on a binding id.
      if (tool.scope === 'global') {
        expect(properties, tool.name).not.toContain('videoId')
        expect(properties, tool.name).not.toContain('projectId')
      }
    }
  })

  it('never declares a confirm param (the chat adapter owns that flag)', () => {
    for (const tool of AGENT_TOOLS) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      )
      expect(properties, tool.name).not.toContain('confirm')
    }
  })

  it('declares the expected destructive set', () => {
    const destructive = AGENT_TOOLS.filter((t) => t.risk === 'destructive').map((t) => t.name)
    expect(destructive.sort()).toEqual([
      // A user note is unrecoverable once deleted.
      'delete_annotation',
      'delete_asset',
      // The captured state can never be restored again.
      'delete_checkpoint',
      // §6.13 — a user's review note is unrecoverable (prefer marking it done).
      'delete_feedback',
      // §7 — takes every tracked channel, video and transcript with it.
      'delete_niche',
      'delete_project',
      // §7b — a researched idea (evidence, drafts) is gone for good.
      'delete_roadmap_item',
      'delete_video',
      // §8 — forgetting a named voice; nodes keep their ids but the channel
      // loses the name→voice mapping its consistency rests on.
      'delete_voice_persona',
      'remove_niche_channel',
      'remove_node',
      // A model swap deletes the node's generations (a new model can't reuse them).
      'replace_node_model',
      // §6.4 — a restore deletes every node created since the capture.
      'restore_checkpoint'
    ])
  })

  it('declares spending on everything that calls kie.ai generation', () => {
    const spending = AGENT_TOOLS.filter((t) => t.risk === 'spending').map((t) => t.name)
    expect(spending.sort()).toEqual([
      'finalize_video',
      'refine_image_prompt',
      'review_clip',
      'review_generation',
      'run_batch',
      'run_node'
    ])
  })

  it('keeps settings and backup out of the registry', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.name).not.toMatch(/setting|backup|api_key|update_channel/)
    }
  })
})

describe('agent-facing model documentation', () => {
  // The bug this guards: an agent that cannot SEE the 4 s floor plans 2-3 s
  // beats from a script, and the run only fails after the user approved it.
  it('publishes the numeric bounds of every param in docs "model:<id>"', () => {
    const doc = getDoc('model:bytedance/seedance-2-fast')
    expect(doc).toContain('"duration"')
    expect(doc).toContain('allowed: 4..15')
    // Handle limits are part of the contract too.
    expect(doc).toContain('≤15s combined')
    expect(doc).toContain('FRAME ANCHOR')
  })

  it('exposes the same bounds through list_models', async () => {
    const listModels = AGENT_TOOLS.find((t) => t.name === 'list_models')!
    const models = (await listModels.execute({})) as Array<{
      id: string
      paramFields: Array<{ key: string; min?: number; max?: number }>
    }>
    const duration = models
      .find((m) => m.id === 'bytedance/seedance-2-fast')!
      .paramFields.find((f) => f.key === 'duration')
    expect(duration).toMatchObject({ min: 4, max: 15 })
  })

  it('serves the continuity topic and advertises it', () => {
    expect(DOC_TOPICS).toContain('continuity')
    const doc = getDoc('continuity')
    expect(doc).toContain('OPENS ON')
    expect(doc).toContain('CLOSES ON')
    expect(doc).toMatch(/screen direction/i)
    expect(doc).toContain('link_shots')
    expect(doc).toContain('shotboard')
  })
})

describe('isToolMediaResult', () => {
  it('recognizes only the tool-media shape', () => {
    expect(
      isToolMediaResult({
        kind: 'tool-media',
        text: '{}',
        images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }]
      })
    ).toBe(true)
    expect(isToolMediaResult({ kind: 'tool-media', text: '{}' })).toBe(false)
    expect(isToolMediaResult({ credits: 12 })).toBe(false)
    expect(isToolMediaResult('a plain string result')).toBe(false)
    expect(isToolMediaResult(null)).toBe(false)
  })
})
