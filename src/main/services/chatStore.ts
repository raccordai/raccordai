import type Anthropic from '@anthropic-ai/sdk'
import { desc, eq } from 'drizzle-orm'
import { HOME_CHAT_ID, type ChatItem } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { chatHomeSession, chatSessions, videos } from '../db/schema'

/**
 * Persistence of assistant conversations (one row per video, plus one row for
 * the home session in its own table — chat_sessions.video_id has a FK to
 * videos). The chat service owns the in-memory session; this module only
 * loads/saves it so a restart resumes the transcript — including the watched
 * generation ids that drive the automatic wake-up.
 */

export interface PersistedChatSession {
  /** '' for the home session (not tied to a project). */
  projectId: string
  history: Anthropic.MessageParam[]
  items: ChatItem[]
  watched: string[]
}

export function loadChatSession(videoId: string): PersistedChatSession | null {
  if (videoId === HOME_CHAT_ID) {
    const row = getDb()
      .select()
      .from(chatHomeSession)
      .where(eq(chatHomeSession.id, HOME_CHAT_ID))
      .get()
    if (!row) return null
    return {
      projectId: '',
      history: (row.history as Anthropic.MessageParam[] | null) ?? [],
      items: (row.items as ChatItem[] | null) ?? [],
      watched: row.watched ?? []
    }
  }
  const row = getDb().select().from(chatSessions).where(eq(chatSessions.videoId, videoId)).get()
  if (!row) return null
  return {
    projectId: row.projectId,
    history: (row.history as Anthropic.MessageParam[] | null) ?? [],
    items: (row.items as ChatItem[] | null) ?? [],
    watched: row.watched ?? []
  }
}

export function saveChatSession(videoId: string, session: PersistedChatSession): void {
  if (videoId === HOME_CHAT_ID) {
    const value = {
      id: HOME_CHAT_ID,
      history: session.history,
      items: session.items,
      watched: session.watched,
      updatedAt: Date.now()
    }
    getDb()
      .insert(chatHomeSession)
      .values(value)
      .onConflictDoUpdate({ target: chatHomeSession.id, set: value })
      .run()
    return
  }
  const value = {
    videoId,
    projectId: session.projectId,
    history: session.history,
    items: session.items,
    watched: session.watched,
    updatedAt: Date.now()
  }
  getDb()
    .insert(chatSessions)
    .values(value)
    .onConflictDoUpdate({ target: chatSessions.videoId, set: value })
    .run()
}

/**
 * Persisted per-video threads for the sidebar's conversation switcher (§4.10
 * phase 5): legacy threads stay readable/resumable, new ones are no longer
 * auto-created (the global thread is the default everywhere).
 */
export function listChatSessions(): {
  videoId: string
  projectId: string
  videoName: string | null
  updatedAt: number
}[] {
  return getDb()
    .select({
      videoId: chatSessions.videoId,
      projectId: chatSessions.projectId,
      videoName: videos.name,
      updatedAt: chatSessions.updatedAt
    })
    .from(chatSessions)
    .leftJoin(videos, eq(videos.id, chatSessions.videoId))
    .orderBy(desc(chatSessions.updatedAt))
    .all()
}

export function deleteChatSession(videoId: string): void {
  if (videoId === HOME_CHAT_ID) {
    getDb().delete(chatHomeSession).where(eq(chatHomeSession.id, HOME_CHAT_ID)).run()
    return
  }
  getDb().delete(chatSessions).where(eq(chatSessions.videoId, videoId)).run()
}
