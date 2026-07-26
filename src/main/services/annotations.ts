import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { buildEditPrompt, type Annotation, type Region } from '@shared/annotations'
import { getModel } from '@shared/models'
import { APPLY_VIDEO_STYLE_PARAM } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { generationAnnotations, generations, nodes } from '../db/schema'
import { broadcastGenerationsChanged } from '../events'
import * as graph from './graph'
import { withGraphHistoryGroup } from './graphHistory'

/**
 * Regional feedback (§6.3) — the I/O half. The user's marks live next to the
 * generation they judge (cascade-deleted with it); the wording that turns them
 * into a prompt is pure and unit-tested in `@shared/annotations`.
 */

/** The image model an "edit this region" node is built on. */
const EDIT_MODEL_ID = 'gpt-image-2-image-to-image'

type AnnotationRow = typeof generationAnnotations.$inferSelect

function toAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    region: row.region ?? null,
    timecodeSec: row.timecodeSec ?? null,
    comment: row.comment
  }
}

export function listAnnotations(generationId: string): Annotation[] {
  return getDb()
    .select()
    .from(generationAnnotations)
    .where(eq(generationAnnotations.generationId, generationId))
    .orderBy(asc(generationAnnotations.createdAt))
    .all()
    .map(toAnnotation)
}

export function addAnnotation(args: {
  generationId: string
  comment: string
  region?: Region | null
  timecodeSec?: number | null
}): Annotation {
  const gen = getDb().select().from(generations).where(eq(generations.id, args.generationId)).get()
  if (!gen) throw new Error('Generation not found')
  const comment = args.comment.trim()
  if (!comment) throw new Error('An annotation needs a comment')

  const row: AnnotationRow = {
    id: randomUUID(),
    generationId: args.generationId,
    videoId: gen.videoId,
    region: args.region ?? null,
    timecodeSec: args.timecodeSec ?? null,
    comment,
    createdAt: Date.now()
  }
  getDb().insert(generationAnnotations).values(row).run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
  return toAnnotation(row)
}

export function deleteAnnotation(annotationId: string): void {
  const db = getDb()
  const row = db
    .select()
    .from(generationAnnotations)
    .where(eq(generationAnnotations.id, annotationId))
    .get()
  if (!row) return
  db.delete(generationAnnotations).where(eq(generationAnnotations.id, annotationId)).run()
  const gen = db.select().from(generations).where(eq(generations.id, row.generationId)).get()
  if (gen) broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
}

/** The kind the annotations describe — drives the prompt wording. */
function kindOfGeneration(nodeId: string): 'image' | 'video' {
  const node = getDb().select().from(nodes).where(eq(nodes.id, nodeId)).get()
  return getModel(node?.modelId ?? '')?.kind === 'video' ? 'video' : 'image'
}

/**
 * Builds the "select + fix" edit node (§6.3): a `gpt-image-2-image-to-image`
 * node whose prompt is composed from the annotations, wired to the annotated
 * generation's node. The annotated generation is promoted to the source node's
 * selection first — the edit must consume the exact image the user judged, not
 * whichever output happens to be selected.
 *
 * Video generations have no in-place edit path: the returned prompt is a
 * regeneration brief the caller applies to the shot itself.
 */
export function createEditNodeFromAnnotations(generationId: string): {
  nodeId: string
  prompt: string
} {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen) throw new Error('Generation not found')
  if (gen.status !== 'success') throw new Error('Only a successful generation can be edited')
  const source = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  if (!source) throw new Error('Source node not found')
  if (kindOfGeneration(gen.nodeId) !== 'image') {
    throw new Error('Video outputs are regenerated, not edited — use the annotations as a prompt')
  }

  const annotations = listAnnotations(generationId)
  if (annotations.length === 0) throw new Error('Add at least one note before building an edit')
  const prompt = buildEditPrompt(annotations, 'image')

  const editModel = getModel(EDIT_MODEL_ID)
  const inputHandle = editModel?.inputs.find((h) => h.accepts.includes('image'))?.key
  if (!inputHandle) throw new Error(`Model "${EDIT_MODEL_ID}" has no image input`)

  // Select + create + connect is ONE gesture for the user — one undo step.
  const node = withGraphHistoryGroup(gen.videoId, () => {
    if (source.selectedGenerationId !== generationId) {
      graph.setSelectedGeneration(source.id, generationId)
    }
    const created = graph.createNode({
      videoId: gen.videoId,
      modelId: EDIT_MODEL_ID,
      label: `${source.label ?? source.key} — fix`,
      intent: annotations.map((a) => a.comment).join(' · '),
      params: { prompt, [APPLY_VIDEO_STYLE_PARAM]: true },
      position: { x: source.positionX + 420, y: source.positionY }
    })
    graph.connectNodes({
      videoId: gen.videoId,
      sourceNodeId: source.id,
      sourceHandle: 'output',
      targetNodeId: created.id,
      targetHandle: inputHandle
    })
    return created
  })
  return { nodeId: node.id, prompt }
}
