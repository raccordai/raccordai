import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { cacheableMessages, cacheableSystem, cacheableTools } from './chatCache'

const EPHEMERAL = { type: 'ephemeral' }

describe('cacheableSystem', () => {
  it('wraps the prompt in a single cached text block', () => {
    expect(cacheableSystem('You are the assistant.')).toEqual([
      { type: 'text', text: 'You are the assistant.', cache_control: EPHEMERAL }
    ])
  })
})

describe('cacheableTools', () => {
  const tool = (name: string): Anthropic.Tool => ({
    name,
    input_schema: { type: 'object' as const }
  })

  it('marks only the last tool', () => {
    const tools = [tool('a'), tool('b')]
    const out = cacheableTools(tools)
    expect(out[0]).not.toHaveProperty('cache_control')
    expect(out[1]).toMatchObject({ name: 'b', cache_control: EPHEMERAL })
  })

  it('does not mutate the shared definitions array', () => {
    const tools = [tool('a')]
    cacheableTools(tools)
    expect(tools[0]).not.toHaveProperty('cache_control')
  })

  it('passes an empty array through', () => {
    expect(cacheableTools([])).toEqual([])
  })
})

describe('cacheableMessages', () => {
  it('converts a string last message into a cached text block', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: 'earlier' },
      { role: 'user', content: 'hello' }
    ]
    const out = cacheableMessages(messages)
    expect(out[0]).toEqual(messages[0])
    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: EPHEMERAL }]
    })
  })

  it('marks only the last block of a block-content message', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one' },
          { type: 'tool_result', tool_use_id: 'b', content: 'two' }
        ]
      }
    ]
    const out = cacheableMessages(messages)
    const content = out[0]!.content as Anthropic.ContentBlockParam[]
    expect(content[0]).not.toHaveProperty('cache_control')
    expect(content[1]).toMatchObject({ tool_use_id: 'b', cache_control: EPHEMERAL })
  })

  it('leaves messages untouched when the last block cannot carry the marker', () => {
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }]
      }
    ] as Anthropic.MessageParam[]
    expect(cacheableMessages(messages)).toEqual(messages)
  })

  it('does not mutate the session history', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }]
    cacheableMessages(messages)
    expect(messages[0]!.content).toBe('hello')
  })

  it('passes an empty history through', () => {
    expect(cacheableMessages([])).toEqual([])
  })
})
