import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject, deleteProject } from './projects'
import { createVideo } from './videos'
import { deleteChatSession, loadChatSession, saveChatSession } from './chatStore'

let projectId: string
let videoId: string

beforeEach(() => {
  useTestDatabase()
  projectId = createProject('P').id
  videoId = createVideo(projectId, 'V').id
})

afterEach(() => resetTestDatabase())

const SAMPLE = {
  projectId: '',
  history: [
    { role: 'user' as const, content: 'make a clip' },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'On it.' }] }
  ],
  items: [
    { type: 'user' as const, text: 'make a clip' },
    { type: 'tool' as const, name: 'add_node', label: 'Node created', ok: true }
  ],
  watched: ['gen-1', 'gen-2']
}

describe('chat store', () => {
  it('returns null when nothing is persisted', () => {
    expect(loadChatSession(videoId)).toBeNull()
  })

  it('round-trips a full session', () => {
    saveChatSession(videoId, { ...SAMPLE, projectId })
    const loaded = loadChatSession(videoId)
    expect(loaded?.projectId).toBe(projectId)
    expect(loaded?.history).toEqual(SAMPLE.history)
    expect(loaded?.items).toEqual(SAMPLE.items)
    expect(loaded?.watched).toEqual(['gen-1', 'gen-2'])
  })

  it('upserts on repeated saves', () => {
    saveChatSession(videoId, { ...SAMPLE, projectId })
    saveChatSession(videoId, { ...SAMPLE, projectId, watched: [] })
    expect(loadChatSession(videoId)?.watched).toEqual([])
  })

  it('deleteChatSession removes the row', () => {
    saveChatSession(videoId, { ...SAMPLE, projectId })
    deleteChatSession(videoId)
    expect(loadChatSession(videoId)).toBeNull()
  })

  it('cascades away with its project', () => {
    saveChatSession(videoId, { ...SAMPLE, projectId })
    deleteProject(projectId)
    expect(loadChatSession(videoId)).toBeNull()
  })
})
