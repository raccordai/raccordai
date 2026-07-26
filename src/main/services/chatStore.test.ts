import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOME_CHAT_ID } from '@shared/ipc/contracts'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { getDb } from '../db/client'
import { chatHomeSession, chatSessions, chatThreads } from '../db/schema'
import { createProject } from './projects'
import { createVideo, deleteVideo } from './videos'
import {
  backfillChatThreads,
  chatThreadExists,
  createChatThread,
  deleteChatSession,
  findThreadIdsWatching,
  listChatThreads,
  loadChatSession,
  renameChatThread,
  saveChatSession,
  unbindThreadsOfVideo
} from './chatStore'

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
  videoId: null,
  title: null,
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

describe('chat threads', () => {
  it('returns null when nothing is persisted', () => {
    expect(loadChatSession('nope')).toBeNull()
    expect(chatThreadExists('nope')).toBe(false)
  })

  it('round-trips a full session', () => {
    const id = createChatThread()
    saveChatSession(id, { ...SAMPLE, projectId })
    const loaded = loadChatSession(id)
    expect(loaded?.projectId).toBe(projectId)
    expect(loaded?.history).toEqual(SAMPLE.history)
    expect(loaded?.items).toEqual(SAMPLE.items)
    expect(loaded?.watched).toEqual(['gen-1', 'gen-2'])
  })

  it('round-trips an unbound thread (videoId null = home behaviour)', () => {
    const id = createChatThread()
    saveChatSession(id, SAMPLE)
    expect(loadChatSession(id)?.videoId).toBeNull()
  })

  it('persists a thread that has no project — the old guard dropped these', () => {
    // persistSession used to skip any session without a projectId, so a new
    // unbound thread was never written and vanished on restart.
    const id = createChatThread()
    saveChatSession(id, { ...SAMPLE, projectId: '' })
    expect(loadChatSession(id)).not.toBeNull()
  })

  it('drops assistant turns a dead stream left empty', () => {
    // A provider stream that closed before its first block used to be stored
    // as {role:'assistant', content:[]}; the Messages API refuses to accept
    // such a message back, so the thread stayed broken forever.
    const id = createChatThread()
    saveChatSession(id, {
      ...SAMPLE,
      projectId,
      history: [
        { role: 'user', content: 'Le scénario…' },
        { role: 'assistant', content: [] },
        { role: 'user', content: 'tu as créé le workflow ?' }
      ]
    })
    const history = loadChatSession(id)?.history
    expect(history).toHaveLength(2)
    expect(history?.every((m) => m.role === 'user')).toBe(true)
  })

  it('upserts on repeated saves', () => {
    const id = createChatThread()
    saveChatSession(id, { ...SAMPLE, projectId })
    saveChatSession(id, { ...SAMPLE, projectId, watched: [] })
    expect(loadChatSession(id)?.watched).toEqual([])
    expect(listChatThreads()).toHaveLength(1)
  })

  it('saves a thread that was never created explicitly', () => {
    saveChatSession('adhoc', { ...SAMPLE, projectId })
    expect(chatThreadExists('adhoc')).toBe(true)
  })

  it('deleteChatSession removes the row', () => {
    const id = createChatThread()
    saveChatSession(id, { ...SAMPLE, projectId })
    deleteChatSession(id)
    expect(loadChatSession(id)).toBeNull()
  })

  it('renames a thread', () => {
    const id = createChatThread()
    renameChatThread(id, 'Anime project')
    expect(loadChatSession(id)?.title).toBe('Anime project')
  })
})

describe('listChatThreads', () => {
  it('lists most recently updated first', () => {
    // Timestamps are written directly: two saveChatSession calls land in the
    // same millisecond, which would make the assertion depend on tie-breaking.
    for (const [id, updatedAt] of [
      ['old', 100],
      ['fresh', 300],
      ['mid', 200]
    ] as const) {
      getDb()
        .insert(chatThreads)
        .values({
          id,
          title: id,
          projectId: '',
          videoId: null,
          history: [],
          items: [],
          watched: [],
          createdAt: updatedAt,
          updatedAt
        })
        .run()
    }
    expect(listChatThreads().map((r) => r.id)).toEqual(['fresh', 'mid', 'old'])
  })

  it('resolves the bound video name, and leaves it null when unbound', () => {
    const bound = createChatThread({ videoId })
    saveChatSession(bound, { ...SAMPLE, projectId, videoId })
    const unbound = createChatThread()
    saveChatSession(unbound, SAMPLE)

    const rows = listChatThreads()
    expect(rows.find((r) => r.id === bound)?.videoName).toBe('V')
    expect(rows.find((r) => r.id === unbound)?.videoName).toBeNull()
  })

  it('survives the deletion of the video it was bound to', () => {
    // No FK on video_id: the conversation outlives the video, unbound.
    const id = createChatThread({ videoId })
    saveChatSession(id, { ...SAMPLE, projectId, videoId })
    deleteVideo(videoId)

    expect(loadChatSession(id)).not.toBeNull()
    expect(loadChatSession(id)?.videoId).toBeNull()
    expect(listChatThreads()).toHaveLength(1)
  })

  it('unbindThreadsOfVideo leaves other threads alone', () => {
    const other = createVideo(projectId, 'Other').id
    const bound = createChatThread({ videoId })
    const untouched = createChatThread({ videoId: other })
    saveChatSession(bound, { ...SAMPLE, videoId })
    saveChatSession(untouched, { ...SAMPLE, videoId: other })

    unbindThreadsOfVideo(videoId)

    expect(loadChatSession(bound)?.videoId).toBeNull()
    expect(loadChatSession(untouched)?.videoId).toBe(other)
  })
})

describe('findThreadIdsWatching', () => {
  it('finds the threads watching a generation, ignoring the others', () => {
    const watching = createChatThread()
    const idle = createChatThread()
    saveChatSession(watching, { ...SAMPLE, watched: ['gen-a', 'gen-b'] })
    saveChatSession(idle, { ...SAMPLE, watched: ['gen-z'] })

    expect(findThreadIdsWatching('gen-a')).toEqual([watching])
    expect(findThreadIdsWatching('gen-z')).toEqual([idle])
    expect(findThreadIdsWatching('gen-unknown')).toEqual([])
  })

  it('finds a thread that is only on disk (wake-up after a restart)', () => {
    saveChatSession('cold', { ...SAMPLE, watched: ['gen-cold'] })
    expect(findThreadIdsWatching('gen-cold')).toEqual(['cold'])
  })
})

describe('backfillChatThreads', () => {
  function seedLegacy(): void {
    const db = getDb()
    db.insert(chatHomeSession)
      .values({
        id: HOME_CHAT_ID,
        history: SAMPLE.history,
        items: SAMPLE.items,
        watched: ['gen-home'],
        updatedAt: 1000
      })
      .run()
    db.insert(chatSessions)
      .values({
        videoId,
        projectId,
        history: SAMPLE.history,
        items: SAMPLE.items,
        watched: [],
        updatedAt: 900
      })
      .run()
  }

  it('imports the home session under HOME_CHAT_ID and per-video ones as bound threads', () => {
    seedLegacy()
    let done = false
    const result = backfillChatThreads(
      () => done,
      () => {
        done = true
      }
    )

    expect(result.imported).toBe(2)
    expect(loadChatSession(HOME_CHAT_ID)?.videoId).toBeNull()
    expect(loadChatSession(HOME_CHAT_ID)?.items).toEqual(SAMPLE.items)
    const legacy = listChatThreads().find((r) => r.videoId === videoId)
    expect(legacy?.projectId).toBe(projectId)
    expect(done).toBe(true)
  })

  it('keeps the watched ids so a pending wake-up survives the migration', () => {
    seedLegacy()
    let done = false
    backfillChatThreads(
      () => done,
      () => {
        done = true
      }
    )
    expect(findThreadIdsWatching('gen-home')).toEqual([HOME_CHAT_ID])
  })

  it('never runs twice — deleting every thread must not resurrect the legacy ones', () => {
    seedLegacy()
    let done = false
    const markDone = (): void => {
      done = true
    }
    backfillChatThreads(() => done, markDone)
    for (const row of listChatThreads()) deleteChatSession(row.id)

    expect(backfillChatThreads(() => done, markDone).imported).toBe(0)
    expect(listChatThreads()).toEqual([])
  })

  it('is a no-op when there is nothing legacy to import', () => {
    let done = false
    const result = backfillChatThreads(
      () => done,
      () => {
        done = true
      }
    )
    expect(result.imported).toBe(0)
    expect(listChatThreads()).toEqual([])
  })
})
