import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { desc, eq } from 'drizzle-orm'
import { HOME_CHAT_ID, type ChatItem } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { chatHomeSession, chatSessions, chatThreads, videos } from '../db/schema'

/**
 * Persistence of assistant conversations, as THREADS: the user opens a new
 * chat whenever they want instead of erasing the only one there is. The chat
 * service owns the in-memory session; this module loads/saves it so a restart
 * resumes the transcript — including the watched generation ids that drive the
 * automatic wake-up.
 *
 * Threads are unbound by default (`videoId` null → home prompt + explicit-id
 * toolset). Threads backfilled from the legacy per-video table keep their
 * videoId and stay bound. There is no FK on `video_id`: deleting a video
 * demotes its thread to unbound rather than destroying the conversation.
 */

export interface PersistedChatSession {
  /** '' when the thread is not tied to a project. */
  projectId: string
  /** null for an unbound thread (home behaviour). */
  videoId: string | null
  title: string | null
  history: Anthropic.MessageParam[]
  items: ChatItem[]
  watched: string[]
}

export interface ChatThreadSummary {
  id: string
  title: string | null
  projectId: string
  videoId: string | null
  /** Name of the bound video, when it still exists. */
  videoName: string | null
  createdAt: number
  updatedAt: number
}

/** Creates an empty thread and returns its id. */
export function createChatThread(
  options: {
    projectId?: string
    videoId?: string | null
    title?: string | null
    /** Explicit id — only the backfill uses it (to keep HOME_CHAT_ID stable). */
    id?: string
  } = {}
): string {
  const id = options.id ?? randomUUID()
  const now = Date.now()
  getDb()
    .insert(chatThreads)
    .values({
      id,
      title: options.title ?? null,
      projectId: options.projectId ?? '',
      videoId: options.videoId ?? null,
      history: [],
      items: [],
      watched: [],
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .run()
  return id
}

export function loadChatSession(threadId: string): PersistedChatSession | null {
  const row = getDb().select().from(chatThreads).where(eq(chatThreads.id, threadId)).get()
  if (!row) return null
  return {
    projectId: row.projectId,
    videoId: row.videoId,
    title: row.title,
    history: (row.history as Anthropic.MessageParam[] | null) ?? [],
    items: (row.items as ChatItem[] | null) ?? [],
    watched: row.watched ?? []
  }
}

export function saveChatSession(threadId: string, session: PersistedChatSession): void {
  const now = Date.now()
  getDb()
    .insert(chatThreads)
    .values({
      id: threadId,
      title: session.title,
      projectId: session.projectId,
      videoId: session.videoId,
      history: session.history,
      items: session.items,
      watched: session.watched,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: chatThreads.id,
      // createdAt is NOT updated — the thread list sorts on updatedAt.
      set: {
        title: session.title,
        projectId: session.projectId,
        videoId: session.videoId,
        history: session.history,
        items: session.items,
        watched: session.watched,
        updatedAt: now
      }
    })
    .run()
}

/** Threads for the sidebar switcher, most recently used first. */
export function listChatThreads(): ChatThreadSummary[] {
  return getDb()
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      projectId: chatThreads.projectId,
      videoId: chatThreads.videoId,
      videoName: videos.name,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt
    })
    .from(chatThreads)
    .leftJoin(videos, eq(videos.id, chatThreads.videoId))
    .orderBy(desc(chatThreads.updatedAt))
    .all()
}

export function renameChatThread(threadId: string, title: string): void {
  getDb()
    .update(chatThreads)
    .set({ title, updatedAt: Date.now() })
    .where(eq(chatThreads.id, threadId))
    .run()
}

export function deleteChatSession(threadId: string): void {
  getDb().delete(chatThreads).where(eq(chatThreads.id, threadId)).run()
}

export function chatThreadExists(threadId: string): boolean {
  return (
    getDb()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .get() !== undefined
  )
}

/**
 * Threads watching a generation. The settle wake-up used to probe two hardcoded
 * keys (the event's videoId and 'home'); with opaque thread ids there is
 * nothing to derive, so the watch list is queried instead — and it works for
 * threads that are not in memory, which is what makes a generation still
 * polling across a restart wake its conversation up.
 */
export function findThreadIdsWatching(generationId: string): string[] {
  return getDb()
    .select({ id: chatThreads.id, watched: chatThreads.watched })
    .from(chatThreads)
    .all()
    .filter((row) => (row.watched ?? []).includes(generationId))
    .map((row) => row.id)
}

/** A video was deleted: its threads survive, unbound (no FK does this for us). */
export function unbindThreadsOfVideo(videoId: string): void {
  getDb().update(chatThreads).set({ videoId: null }).where(eq(chatThreads.videoId, videoId)).run()
}

/**
 * One-time import of the pre-thread tables. Idempotent through a marker row in
 * `settings` rather than "chat_threads is empty" — otherwise a user who
 * deletes all their threads would see the legacy ones resurrected on the next
 * launch. The home session keeps the literal HOME_CHAT_ID so the default
 * selection stays stable across the upgrade.
 */
export function backfillChatThreads(
  hasRun: () => boolean,
  markDone: () => void
): { imported: number } {
  if (hasRun()) return { imported: 0 }
  const db = getDb()
  let imported = 0

  const home = db.select().from(chatHomeSession).where(eq(chatHomeSession.id, HOME_CHAT_ID)).get()
  if (home) {
    db.insert(chatThreads)
      .values({
        id: HOME_CHAT_ID,
        title: null,
        projectId: '',
        videoId: null,
        history: home.history ?? [],
        items: home.items ?? [],
        watched: home.watched ?? [],
        createdAt: home.updatedAt,
        updatedAt: home.updatedAt
      })
      .onConflictDoNothing()
      .run()
    imported += 1
  }

  for (const row of db.select().from(chatSessions).all()) {
    db.insert(chatThreads)
      .values({
        id: `legacy-${row.videoId}`,
        title: null,
        projectId: row.projectId,
        videoId: row.videoId,
        history: row.history ?? [],
        items: row.items ?? [],
        watched: row.watched ?? [],
        createdAt: row.updatedAt,
        updatedAt: row.updatedAt
      })
      .onConflictDoNothing()
      .run()
    imported += 1
  }

  markDone()
  return { imported }
}
