import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { fromResponsesOutput, toResponsesInput, toResponsesTools } from './chatOpenAIFormat'

describe('toResponsesTools', () => {
  it('maps Anthropic tools to Responses function tools', () => {
    const tools = [
      {
        name: 'create_project',
        description: 'Create a project.',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      }
    ] as Anthropic.Tool[]
    expect(toResponsesTools(tools)).toEqual([
      {
        type: 'function',
        name: 'create_project',
        description: 'Create a project.',
        parameters: tools[0]!.input_schema
      }
    ])
  })
})

describe('toResponsesInput', () => {
  it('converts plain text turns per role', () => {
    const items = toResponsesInput([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi', citations: null }] }
    ] as Anthropic.MessageParam[])
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }
    ])
  })

  it('converts attached images to input_image data URLs', () => {
    const items = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'use this as the key visual' }
        ]
      }
    ] as Anthropic.MessageParam[])
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'use this as the key visual' }] }
    ])
  })

  it('converts tool_use/tool_result to function_call pairs and drops thinking', () => {
    const items = toResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 's' },
          { type: 'tool_use', id: 'call_1', name: 'create_project', input: { name: 'X' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"projectId":"p1"}' }]
      }
    ] as Anthropic.MessageParam[])
    expect(items).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'create_project',
        arguments: '{"name":"X"}'
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"projectId":"p1"}' }
    ])
  })

  it('degrades vision blocks in a tool_result to text notes (never base64)', () => {
    const items = toResponsesInput([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' }
              },
              { type: 'text', text: '{"generationId":"g1","mediaKind":"image"}' }
            ]
          }
        ]
      }
    ] as Anthropic.MessageParam[])
    expect(items).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '[image]\n{"generationId":"g1","mediaKind":"image"}'
      }
    ])
  })
})

describe('fromResponsesOutput', () => {
  it('converts output_text and function_call items back to Anthropic blocks', () => {
    const { content, stop_reason } = fromResponsesOutput([
      { type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: 'Creating it.' }] },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'create_video',
        arguments: '{"projectId":"p1","name":"V"}'
      }
    ])
    expect(stop_reason).toBe('tool_use')
    expect(content).toEqual([
      { type: 'text', text: 'Creating it.', citations: null },
      {
        type: 'tool_use',
        id: 'call_2',
        name: 'create_video',
        input: { projectId: 'p1', name: 'V' }
      }
    ])
  })

  it('is end_turn without function calls, and survives bad arguments JSON', () => {
    const text = fromResponsesOutput([
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] }
    ])
    expect(text.stop_reason).toBe('end_turn')

    const broken = fromResponsesOutput([
      { type: 'function_call', call_id: 'c', name: 'x', arguments: '{oops' }
    ])
    expect(broken.content[0]).toMatchObject({ type: 'tool_use', input: {} })
  })

  it('handles an empty/missing output array', () => {
    expect(fromResponsesOutput(undefined)).toEqual({ content: [], stop_reason: 'end_turn' })
  })
})
