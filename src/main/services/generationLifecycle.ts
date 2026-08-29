import { desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { generations } from '../db/schema'
import { emitGenerationSettled } from '../bus'
import { broadcastGenerationsChanged } from '../events'

/**
 * Terminal transitions of a generation row, extracted from the run engine so
 * the DELETE paths (node/video/project) can settle in-flight rows without
 * importing the engine — graph/videos sit underneath it (runEngine → qc →
 * mediaPreview → graph), so importing runEngine from there would cycle.
 * Settling here still releases the queue slot: the engine listens on the
 * generationSettled bus event these emit.
 */

export function failGeneration(generationId: string, errorMessage: string): void {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  db.update(generations)
    .set({ status: 'failed', errorMessage, completedAt: Date.now() })
    .where(eq(generations.id, generationId))
    .run()
  if (gen) {
    broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
    emitGenerationSettled({
      generationId,
      videoId: gen.videoId,
      nodeId: gen.nodeId,
      status: 'failed',
      errorMessage
    })
  }
}

/**
 * Cancels EVERY run in flight on the node — a variants batch (§6.6) puts N of
 * them there and one Cancel click must stop the whole exploration, not peel
 * candidates off one at a time. Also called before the node is deleted, so
 * its queue slots settle instead of leaking with the rows.
 */
export function cancelGeneration(nodeId: string): { cancelled: boolean } {
  const inFlight = getDb()
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()
    .filter((g) => g.status === 'running' || g.status === 'pending')
  for (const gen of inFlight) failGeneration(gen.id, 'Cancelled by user.')
  return { cancelled: inFlight.length > 0 }
}

/**
 * Settles every in-flight generation of a video — called BEFORE the video (or
 * its whole project) is deleted. Without it the rows vanish under the poller,
 * which exits silently, and the queue slots leak until restart: with the
 * default limit of 2, two such deletions freeze all generation.
 */
export function cancelGenerationsForVideo(videoId: string): void {
  const inFlight = getDb()
    .select()
    .from(generations)
    .where(eq(generations.videoId, videoId))
    .all()
    .filter((g) => g.status === 'running' || g.status === 'pending')
  for (const gen of inFlight) failGeneration(gen.id, 'Cancelled: the video was deleted.')
}
