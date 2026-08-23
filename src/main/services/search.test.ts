import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo } from './videos'
import { createNode } from './graph'
import { createFeedbackItem } from './feedback'
import { buildSnippet, searchAll } from './search'

const SEEDANCE = 'bytedance/seedance-2-fast'

let projectId: string
let videoId: string

beforeEach(() => {
  useTestDatabase()
  projectId = createProject('Moto chase film').id
  videoId = createVideo(projectId, 'Desert chase').id
})

afterEach(() => resetTestDatabase())

describe('buildSnippet', () => {
  it('windows around the first case-insensitive match with ellipses', () => {
    const text = `${'a'.repeat(100)} Léa rides through the dunes ${'b'.repeat(100)}`
    const snippet = buildSnippet(text, 'léa')
    expect(snippet).toContain('Léa rides')
    expect(snippet!.startsWith('…')).toBe(true)
    expect(snippet!.endsWith('…')).toBe(true)
  })

  it('returns null when the text does not match', () => {
    expect(buildSnippet('nothing here', 'léa')).toBeNull()
  })
})

describe('searchAll', () => {
  it('refuses queries under 2 characters', () => {
    expect(() => searchAll(' a ')).toThrow('at least 2 characters')
  })

  it('finds projects, videos, node prompts and feedback in one call', () => {
    const node = createNode({
      videoId,
      modelId: SEEDANCE,
      label: 'Shot 01',
      params: { prompt: 'Léa rides through the dunes at dawn', duration: 4 }
    })
    createFeedbackItem({ videoId, comment: 'Léa looks off-model here', timecodeSec: 3 })

    const { hits } = searchAll('Léa')
    const types = hits.map((h) => h.type)
    expect(types).toContain('node')
    expect(types).toContain('feedback')
    const nodeHit = hits.find((h) => h.type === 'node')!
    expect(nodeHit.id).toBe(node.id)
    expect(nodeHit.videoId).toBe(videoId)
    expect(nodeHit.snippet).toContain('rides through the dunes')

    const chase = searchAll('chase')
    expect(chase.hits.map((h) => h.type).sort()).toEqual(['project', 'video'])
  })

  it('restricts to the requested types and treats wildcards literally', () => {
    createNode({
      videoId,
      modelId: SEEDANCE,
      label: 'Weird 100%_done shot',
      params: { prompt: 'plain', duration: 4 }
    })
    const { hits } = searchAll('100%_done', { types: ['node'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.type).toBe('node')
    // A wildcard query must not match everything.
    expect(searchAll('%%', { types: ['node'] }).hits).toHaveLength(0)
  })
})
