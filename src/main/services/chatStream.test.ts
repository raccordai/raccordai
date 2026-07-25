import { describe, expect, it } from 'vitest'
import { SseParser, createAnthropicAccumulator, createResponsesAccumulator } from './chatStream'

describe('SseParser', () => {
  it('splits complete events and keeps partial ones buffered', () => {
    const parser = new SseParser()
    expect(parser.push('event: x\ndata: {"a":1}\n\ndata: {"b"')).toEqual(['{"a":1}'])
    expect(parser.push(':2}\n\n')).toEqual(['{"b":2}'])
    expect(parser.flush()).toEqual([])
  })

  it('joins multi-line data and normalizes CRLF', () => {
    const parser = new SseParser()
    expect(parser.push('data: line1\r\ndata: line2\r\n\r\n')).toEqual(['line1\nline2'])
  })

  it('flushes a trailing event without a final blank line', () => {
    const parser = new SseParser()
    expect(parser.push('data: tail')).toEqual([])
    expect(parser.flush()).toEqual(['tail'])
  })

  it('ignores comments and events without data', () => {
    const parser = new SseParser()
    expect(parser.push(': keepalive\n\nevent: ping\n\n')).toEqual([])
  })
})

describe('createAnthropicAccumulator', () => {
  it('rebuilds text + tool_use blocks and surfaces text deltas', () => {
    const deltas: string[] = []
    const acc = createAnthropicAccumulator((d) => deltas.push(d))
    acc.push({ type: 'message_start', message: {} })
    acc.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })
    acc.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bon' } })
    acc.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'jour' }
    })
    acc.push({ type: 'content_block_stop', index: 0 })
    acc.push({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'get_workflow', input: {} }
    })
    acc.push({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"video' }
    })
    acc.push({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'Id":"v1"}' }
    })
    acc.push({ type: 'content_block_stop', index: 1 })
    acc.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
    acc.push({ type: 'message_stop' })

    const message = acc.finish()
    expect(deltas.join('')).toBe('Bonjour')
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toHaveLength(2)
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'Bonjour' })
    expect(message.content[1]).toMatchObject({
      type: 'tool_use',
      name: 'get_workflow',
      input: { videoId: 'v1' }
    })
  })

  it('tolerates malformed tool JSON (empty input) and reports stream errors', () => {
    const acc = createAnthropicAccumulator()
    acc.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu', name: 'x', input: {} }
    })
    acc.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{broken' }
    })
    acc.push({ type: 'content_block_stop', index: 0 })
    acc.push({ type: 'error', error: { type: 'overloaded', message: 'try later' } })
    const message = acc.finish()
    expect(message.content[0]).toMatchObject({ input: {} })
    expect(message.error).toMatchObject({ message: 'try later' })
  })
})

describe('createResponsesAccumulator', () => {
  it('surfaces deltas and returns the completed output array', () => {
    const deltas: string[] = []
    const acc = createResponsesAccumulator((d) => deltas.push(d))
    acc.push({ type: 'response.output_text.delta', delta: 'Hel' })
    acc.push({ type: 'response.output_text.delta', delta: 'lo' })
    acc.push({
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }]
      }
    })
    expect(deltas.join('')).toBe('Hello')
    expect(acc.finish().output).toHaveLength(1)
  })

  it('captures failures', () => {
    const acc = createResponsesAccumulator()
    acc.push({ type: 'response.failed', response: { error: { message: 'quota' } } })
    expect(acc.finish().error).toMatchObject({ message: 'quota' })
  })
})
