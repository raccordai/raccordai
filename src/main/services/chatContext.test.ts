import { describe, expect, it } from 'vitest'
import { formatAppContext } from './chatContext'

describe('formatAppContext', () => {
  it('returns null without a context', () => {
    expect(formatAppContext(undefined)).toBeNull()
  })

  it('returns null for an empty context (no block injected)', () => {
    expect(formatAppContext({})).toBeNull()
  })

  it('treats empty strings as absent', () => {
    expect(formatAppContext({ route: '', videoId: '', lastError: '' })).toBeNull()
  })

  it('renders only the provided fields, wrapped in <app-context>', () => {
    const block = formatAppContext({ route: '/', projectId: 'p1' })
    expect(block).toMatch(/^<app-context>\n/)
    expect(block).toMatch(/\n<\/app-context>$/)
    expect(block).toContain('route: /')
    expect(block).toContain('projectId: p1')
    expect(block).not.toContain('videoId')
    expect(block).not.toContain('selectedNodeId')
  })

  it('renders every field in a stable order', () => {
    const block = formatAppContext({
      route: '/projects/p1/videos/v1',
      projectId: 'p1',
      videoId: 'v1',
      selectedNodeId: 'n1',
      selectedGenerationId: 'g1',
      lastError: 'content policy violation'
    })!
    const order = [
      'route: /projects/p1/videos/v1',
      'projectId: p1',
      'videoId: v1',
      'selectedNodeId: n1',
      'selectedGenerationId: g1',
      'lastGenerationError: content policy violation'
    ]
    let cursor = -1
    for (const line of order) {
      const at = block.indexOf(line)
      expect(at, line).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('flags the block as app-injected, not user-written', () => {
    expect(formatAppContext({ route: '/' })).toContain('not written by the user')
  })
})
