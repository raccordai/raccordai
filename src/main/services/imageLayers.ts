import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { ImageLayer } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { imageLayers, videos } from '../db/schema'
import { broadcastWorkflowChanged } from '../events'

/**
 * The timeline's sticker track (§6.12d): image overlays in absolute
 * final-timeline seconds, composited over the film by the render's overlay
 * pass. Same doctrine as textLayers.ts — NOT in the graph journal (cheap to
 * recreate, and graphHistory only owns nodes+edges); the image source is an
 * image NODE's output or a project ASSET, exactly one of the two.
 */

const DEFAULTS = {
  x: 0.5,
  y: 0.5,
  widthPct: 25
}

function assertTiming(startSec: number, endSec: number): void {
  if (endSec <= startSec) throw new Error('A sticker must end after it starts.')
}

export function listImageLayers(videoId: string): ImageLayer[] {
  return getDb()
    .select()
    .from(imageLayers)
    .where(eq(imageLayers.videoId, videoId))
    .orderBy(asc(imageLayers.startSec), asc(imageLayers.createdAt))
    .all()
}

export function getImageLayer(id: string): ImageLayer | null {
  return getDb().select().from(imageLayers).where(eq(imageLayers.id, id)).get() ?? null
}

export function createImageLayer(
  input: Partial<Omit<ImageLayer, 'id' | 'createdAt'>> &
    Pick<ImageLayer, 'videoId' | 'startSec' | 'endSec'>
): ImageLayer {
  const db = getDb()
  if (!db.select().from(videos).where(eq(videos.id, input.videoId)).get()) {
    throw new Error(`Unknown videoId "${input.videoId}".`)
  }
  const nodeId = input.nodeId ?? null
  const assetId = input.assetId ?? null
  if ((nodeId === null) === (assetId === null)) {
    throw new Error('A sticker needs exactly one image source: nodeId OR assetId.')
  }
  assertTiming(input.startSec, input.endSec)
  const layer: ImageLayer = {
    id: randomUUID(),
    videoId: input.videoId,
    nodeId,
    assetId,
    startSec: input.startSec,
    endSec: input.endSec,
    x: input.x ?? DEFAULTS.x,
    y: input.y ?? DEFAULTS.y,
    widthPct: input.widthPct ?? DEFAULTS.widthPct,
    createdAt: Date.now()
  }
  db.insert(imageLayers).values(layer).run()
  broadcastWorkflowChanged(layer.videoId)
  return layer
}

export function updateImageLayer(
  id: string,
  patch: Partial<Omit<ImageLayer, 'id' | 'videoId' | 'nodeId' | 'assetId' | 'createdAt'>>
): ImageLayer {
  const db = getDb()
  const current = getImageLayer(id)
  if (!current) throw new Error(`Unknown sticker "${id}".`)
  const next = { ...current, ...patch }
  assertTiming(next.startSec, next.endSec)
  db.update(imageLayers).set(patch).where(eq(imageLayers.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
  return next
}

export function deleteImageLayer(id: string): void {
  const current = getImageLayer(id)
  if (!current) return
  getDb().delete(imageLayers).where(eq(imageLayers.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
}
