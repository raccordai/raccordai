import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { FeedbackItem } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { feedbackItems, videos } from '../db/schema'
import { broadcastWorkflowChanged } from '../events'

/**
 * Feedback bucket (§6.13): review notes taken while watching the timeline —
 * a comment anchored to a final-timeline timecode and to the node under the
 * playhead. The node reference is a plain id + a label SNAPSHOT so the note
 * survives node deletion/renaming. Worked through in the UI and by agents
 * (MCP `list_feedback`/`update_feedback` mark items done). Not in the graph
 * journal — same doctrine as text_layers.
 */

export function listFeedback(videoId: string): FeedbackItem[] {
  return getDb()
    .select()
    .from(feedbackItems)
    .where(eq(feedbackItems.videoId, videoId))
    .orderBy(asc(feedbackItems.createdAt))
    .all()
}

export function getFeedbackItem(id: string): FeedbackItem | null {
  return getDb().select().from(feedbackItems).where(eq(feedbackItems.id, id)).get() ?? null
}

export function createFeedbackItem(
  input: Partial<Omit<FeedbackItem, 'id' | 'createdAt'>> & Pick<FeedbackItem, 'videoId' | 'comment'>
): FeedbackItem {
  const db = getDb()
  if (!db.select().from(videos).where(eq(videos.id, input.videoId)).get()) {
    throw new Error(`Unknown videoId "${input.videoId}".`)
  }
  const item: FeedbackItem = {
    id: randomUUID(),
    videoId: input.videoId,
    nodeId: input.nodeId ?? null,
    nodeLabel: input.nodeLabel ?? null,
    timecodeSec: input.timecodeSec ?? null,
    comment: input.comment,
    status: input.status ?? 'open',
    createdAt: Date.now()
  }
  db.insert(feedbackItems).values(item).run()
  broadcastWorkflowChanged(item.videoId)
  return item
}

export function updateFeedbackItem(
  id: string,
  patch: Partial<Omit<FeedbackItem, 'id' | 'videoId' | 'createdAt'>>
): FeedbackItem {
  const db = getDb()
  const current = getFeedbackItem(id)
  if (!current) throw new Error(`Unknown feedback item "${id}".`)
  const next = { ...current, ...patch }
  db.update(feedbackItems).set(patch).where(eq(feedbackItems.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
  return next
}

export function deleteFeedbackItem(id: string): void {
  const current = getFeedbackItem(id)
  if (!current) return
  getDb().delete(feedbackItems).where(eq(feedbackItems.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
}
