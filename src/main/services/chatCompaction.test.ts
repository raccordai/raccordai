import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import {
  COMPACTION_MESSAGE_THRESHOLD,
  needsCompaction,
  renderForSummary,
  reassembleHistory,
  splitForCompaction,
  stripImageBlocks
} from './chatCompaction'

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })
const assistant = (text: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'text', text }]
})
const toolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'get_workflow', input: {} }]
})
const toolResult = (id: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: '{"ok":true}' }]
})
const image = (): Anthropic.MessageParam => ({
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'use this' }
  ]
})

/** N alternating user/assistant text turns. */
function turns(n: number): Anthropic.MessageParam[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`)))
}

describe('needsCompaction', () => {
  it('triggers past the message threshold', () => {
    expect(needsCompaction(turns(COMPACTION_MESSAGE_THRESHOLD))).toBe(false)
    expect(needsCompaction(turns(COMPACTION_MESSAGE_THRESHOLD + 2))).toBe(true)
  })

  it('triggers past the byte threshold even with few messages', () => {
    const fat = [user('x'.repeat(400_000))]
    expect(needsCompaction(fat)).toBe(true)
  })
})

describe('splitForCompaction', () => {
  it('splits near two-thirds on a plain user turn', () => {
    const history = turns(30)
    const split = splitForCompaction(history)!
    expect(split.head.length + split.tail.length).toBe(30)
    expect(split.head.length).toBeGreaterThanOrEqual(18)
    expect(split.tail[0]!.role).toBe('user')
  })

  it('never starts the tail on a tool_result (pairing preserved)', () => {
    // …u, a(tool_use), u(tool_result), a, u, a … around the 2/3 mark.
    const history = [
      ...turns(20),
      toolUse('t1'),
      toolResult('t1'),
      assistant('done'),
      user('next'),
      assistant('ok'),
      user('more'),
      assistant('fin')
    ]
    const split = splitForCompaction(history)!
    const first = split.tail[0]!
    expect(first.role).toBe('user')
    expect(
      Array.isArray(first.content) && first.content.some((b) => b.type === 'tool_result')
    ).toBe(false)
    // The pair stays whole on one side of the split.
    const headStr = JSON.stringify(split.head)
    expect(headStr.includes('"tool_use"')).toBe(headStr.includes('"tool_result"'))
  })

  it('returns null when no safe split exists', () => {
    const history = [toolUse('t1'), toolResult('t1'), toolUse('t2'), toolResult('t2')]
    expect(splitForCompaction(history)).toBeNull()
  })
})

describe('stripImageBlocks', () => {
  it('replaces images with a note and keeps other blocks', () => {
    const stripped = stripImageBlocks([image(), user('plain')])
    const first = stripped[0]!
    expect(JSON.stringify(first)).not.toContain('base64')
    expect(Array.isArray(first.content) && first.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(first)).toContain('image attachment removed')
    expect(JSON.stringify(first)).toContain('use this')
    expect(stripped[1]).toEqual(user('plain'))
  })
})

describe('renderForSummary', () => {
  it('renders roles, text and tool pairs compactly', () => {
    const rendered = renderForSummary([user('hello'), toolUse('t1'), toolResult('t1')])
    expect(rendered).toContain('## user')
    expect(rendered).toContain('hello')
    expect(rendered).toContain('[tool_use get_workflow {}]')
    expect(rendered).toContain('[tool_result {"ok":true}]')
  })
})

describe('reassembleHistory', () => {
  it('prefixes the summary to the first kept user message (no extra turn)', () => {
    const tail = [user('latest question'), assistant('answer')]
    const rebuilt = reassembleHistory('THE SUMMARY', tail)
    expect(rebuilt).toHaveLength(2)
    expect(rebuilt[0]!.role).toBe('user')
    expect(rebuilt[0]!.content).toContain('<conversation-summary>')
    expect(rebuilt[0]!.content).toContain('THE SUMMARY')
    expect(rebuilt[0]!.content).toContain('latest question')
  })

  it('handles a block-array first message', () => {
    const tail: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'question' }] }
    ]
    const rebuilt = reassembleHistory('S', tail)
    const content = rebuilt[0]!.content as Anthropic.TextBlockParam[]
    expect(content[0]!.text).toContain('<conversation-summary>')
    expect(content[1]!.text).toBe('question')
  })
})
