import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../mcp/registry'
import {
  approvalGate,
  injectBindingIds,
  toAnthropicTools,
  APPROVAL_REQUIRED_RESULT
} from './chatToolAdapter'

function tool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: 'sample_tool',
    description: 'A sample tool.',
    inputSchema: {
      type: 'object',
      properties: { videoId: { type: 'string' }, other: { type: 'string' } },
      required: ['videoId', 'other']
    },
    scope: 'video',
    risk: 'write',
    execute: () => ({ ok: true }),
    ...overrides
  }
}

describe('toAnthropicTools', () => {
  it('drops videoId for video-scoped tools in a bound session', () => {
    const [adapted] = toAnthropicTools([tool({})], true)
    const schema = adapted!.input_schema as { properties: object; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(['other'])
    expect(schema.required).toEqual(['other'])
  })

  it('drops projectId for project-scoped tools in a bound session', () => {
    const projectTool = tool({
      scope: 'project',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, query: { type: 'string' } },
        required: ['projectId', 'query']
      }
    })
    const [adapted] = toAnthropicTools([projectTool], true)
    const schema = adapted!.input_schema as { properties: object; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(['query'])
    expect(schema.required).toEqual(['query'])
  })

  it('keeps explicit ids required for the global session', () => {
    const [adapted] = toAnthropicTools([tool({})], false)
    const schema = adapted!.input_schema as { properties: object; required: string[] }
    expect(Object.keys(schema.properties)).toContain('videoId')
    expect(schema.required).toContain('videoId')
  })

  it('leaves global-scoped tools untouched in both bindings', () => {
    const globalTool = tool({
      scope: 'global',
      inputSchema: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId']
      }
    })
    for (const bound of [true, false]) {
      const [adapted] = toAnthropicTools([globalTool], bound)
      const schema = adapted!.input_schema as { properties: object; required: string[] }
      expect(Object.keys(schema.properties)).toEqual(['nodeId'])
      expect(schema.required).toEqual(['nodeId'])
    }
  })

  it('adds the confirm flag to destructive tools only', () => {
    const tools = [tool({ name: 'delete_thing', risk: 'destructive' }), tool({ name: 'safe' })]
    const adapted = toAnthropicTools(tools, false)
    const destructive = adapted[0]!.input_schema as { properties: Record<string, unknown> }
    const safe = adapted[1]!.input_schema as { properties: Record<string, unknown> }
    expect(destructive.properties['confirm']).toBeDefined()
    // confirm stays optional: the first (unconfirmed) call must be schema-valid.
    expect((adapted[0]!.input_schema as { required: string[] }).required).not.toContain('confirm')
    expect(safe.properties['confirm']).toBeUndefined()
  })

  it('does not mutate the registry schema (shared with the MCP surface)', () => {
    const shared = tool({ risk: 'destructive' })
    toAnthropicTools([shared], true)
    const schema = shared.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(['videoId', 'other'])
    expect(schema.required).toEqual(['videoId', 'other'])
    expect(schema.properties['confirm']).toBeUndefined()
  })
})

describe('injectBindingIds', () => {
  const binding = { videoId: 'v1', projectId: 'p1' }

  it('injects the session videoId for video-scoped tools', () => {
    expect(injectBindingIds(tool({}), {}, binding)).toEqual({ videoId: 'v1' })
  })

  it('injects the session projectId for project-scoped tools', () => {
    expect(injectBindingIds(tool({ scope: 'project' }), { query: 'cat' }, binding)).toEqual({
      query: 'cat',
      projectId: 'p1'
    })
  })

  it('lets an explicit id from the model win', () => {
    expect(injectBindingIds(tool({}), { videoId: 'v2' }, binding)).toEqual({ videoId: 'v2' })
  })

  it('injects nothing without a binding (global session) or for global tools', () => {
    expect(injectBindingIds(tool({}), {}, null)).toEqual({})
    expect(injectBindingIds(tool({ scope: 'global' }), {}, binding)).toEqual({})
  })
})

describe('approvalGate', () => {
  it('blocks destructive calls without confirm', () => {
    const gate = approvalGate(tool({ risk: 'destructive' }), { videoId: 'v1' })
    expect(gate.approved).toBe(false)
  })

  it('blocks destructive calls with a non-true confirm', () => {
    for (const confirm of [false, 'true', 1, null]) {
      expect(approvalGate(tool({ risk: 'destructive' }), { confirm }).approved).toBe(false)
    }
  })

  it('approves destructive calls with confirm: true and strips the flag', () => {
    const gate = approvalGate(tool({ risk: 'destructive' }), { videoId: 'v1', confirm: true })
    expect(gate.approved).toBe(true)
    expect(gate.args).toEqual({ videoId: 'v1' })
  })

  it('passes non-destructive calls through untouched', () => {
    for (const risk of ['read', 'write', 'spending'] as const) {
      const gate = approvalGate(tool({ risk }), { videoId: 'v1' })
      expect(gate.approved).toBe(true)
      expect(gate.args).toEqual({ videoId: 'v1' })
    }
  })

  it('the approval-required result tells the model to wait and re-call with confirm', () => {
    expect(APPROVAL_REQUIRED_RESULT).toContain('nothing was executed')
    expect(APPROVAL_REQUIRED_RESULT).toContain('"confirm": true')
  })
})
