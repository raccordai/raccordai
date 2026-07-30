import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { TextLayer } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { textLayers, videos } from '../db/schema'
import { broadcastWorkflowChanged } from '../events'

/**
 * The timeline's title track (§6.12b): free text layers in absolute
 * final-timeline seconds, positioned anywhere on the frame with their own
 * typography. Not part of the graph journal — a layer is cheap to recreate
 * and touching graphHistory for a non-graph table would complicate undo.
 */

const DEFAULTS = {
  x: 0.5,
  y: 0.5,
  anchor: 5,
  fontFamily: null as string | null,
  sizePct: 6,
  bold: false,
  italic: false,
  colorHex: '#ffffff'
}

function assertTiming(startSec: number, endSec: number): void {
  if (endSec <= startSec) throw new Error('A text layer must end after it starts.')
}

export function listTextLayers(videoId: string): TextLayer[] {
  return getDb()
    .select()
    .from(textLayers)
    .where(eq(textLayers.videoId, videoId))
    .orderBy(asc(textLayers.startSec), asc(textLayers.createdAt))
    .all()
}

export function getTextLayer(id: string): TextLayer | null {
  return getDb().select().from(textLayers).where(eq(textLayers.id, id)).get() ?? null
}

export function createTextLayer(
  input: Omit<TextLayer, 'id' | 'createdAt'> extends infer T
    ? Partial<T> & Pick<TextLayer, 'videoId' | 'content' | 'startSec' | 'endSec'>
    : never
): TextLayer {
  const db = getDb()
  if (!db.select().from(videos).where(eq(videos.id, input.videoId)).get()) {
    throw new Error(`Unknown videoId "${input.videoId}".`)
  }
  assertTiming(input.startSec, input.endSec)
  const layer: TextLayer = {
    id: randomUUID(),
    videoId: input.videoId,
    content: input.content,
    startSec: input.startSec,
    endSec: input.endSec,
    x: input.x ?? DEFAULTS.x,
    y: input.y ?? DEFAULTS.y,
    anchor: input.anchor ?? DEFAULTS.anchor,
    fontFamily: input.fontFamily ?? DEFAULTS.fontFamily,
    sizePct: input.sizePct ?? DEFAULTS.sizePct,
    bold: input.bold ?? DEFAULTS.bold,
    italic: input.italic ?? DEFAULTS.italic,
    colorHex: input.colorHex ?? DEFAULTS.colorHex,
    createdAt: Date.now()
  }
  db.insert(textLayers).values(layer).run()
  broadcastWorkflowChanged(layer.videoId)
  return layer
}

export function updateTextLayer(
  id: string,
  patch: Partial<Omit<TextLayer, 'id' | 'videoId' | 'createdAt'>>
): TextLayer {
  const db = getDb()
  const current = getTextLayer(id)
  if (!current) throw new Error(`Unknown text layer "${id}".`)
  const next = { ...current, ...patch }
  assertTiming(next.startSec, next.endSec)
  db.update(textLayers).set(patch).where(eq(textLayers.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
  return next
}

export function deleteTextLayer(id: string): void {
  const current = getTextLayer(id)
  if (!current) return
  getDb().delete(textLayers).where(eq(textLayers.id, id)).run()
  broadcastWorkflowChanged(current.videoId)
}
