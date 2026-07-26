import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS } from './registry'

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
      'delete_asset',
      'delete_project',
      'delete_video',
      'remove_node',
      // §6.4 — a restore deletes every node created since the capture.
      'restore_checkpoint'
    ])
  })

  it('declares spending on everything that calls kie.ai generation', () => {
    const spending = AGENT_TOOLS.filter((t) => t.risk === 'spending').map((t) => t.name)
    expect(spending.sort()).toEqual([
      'finalize_video',
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
