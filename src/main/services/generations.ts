import { and, desc, eq } from 'drizzle-orm'
import { estimateCreditsFor, getModel } from '@shared/models'
import type { GraphNode } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { generations, nodes, videos } from '../db/schema'
import { getAsset } from './assets'

export type GenerationRow = typeof generations.$inferSelect

export function listGenerationsForNode(nodeId: string): GenerationRow[] {
  return getDb()
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()
}

export function listGenerationsForVideo(videoId: string): GenerationRow[] {
  return getDb()
    .select()
    .from(generations)
    .where(eq(generations.videoId, videoId))
    .orderBy(desc(generations.createdAt))
    .all()
}

export function getGeneration(id: string): GenerationRow | null {
  return getDb().select().from(generations).where(eq(generations.id, id)).get() ?? null
}

/**
 * Indicative credit cost of running this node right now (its current params),
 * null when the model declares no rates. See ModelDefinition.estimateCredits.
 */
export function estimateNodeRunCredits(nodeId: string): number | null {
  const node = getDb().select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node || node.modelId === 'studio/asset') return null
  return estimateCreditsFor(node.modelId, node.params)
}

/**
 * Estimated kie.ai credits spent across a project (sum of the per-generation
 * estimates stamped at claim time) plus the raw attempt count. Estimates only —
 * the kie.ai dashboard is the authority on real spend.
 */
export function projectCreditsUsage(projectId: string): {
  estimatedCredits: number
  generationCount: number
} {
  const rows = getDb()
    .select({ credits: generations.creditsEstimated })
    .from(generations)
    .innerJoin(videos, eq(generations.videoId, videos.id))
    .where(eq(videos.projectId, projectId))
    .all()
  return {
    estimatedCredits: rows.reduce((sum, r) => sum + (r.credits ?? 0), 0),
    generationCount: rows.length
  }
}

export interface HistoryRow extends GenerationRow {
  nodeLabel: string | null
  modelId: string
  isSelected: boolean
  nodeExists: boolean
}

export function historyForVideo(videoId: string): HistoryRow[] {
  const db = getDb()
  const gens = listGenerationsForVideo(videoId)
  const nodeRows = db.select().from(nodes).where(eq(nodes.videoId, videoId)).all()
  const nodeById = new Map(nodeRows.map((n) => [n.id, n]))
  return gens.map((g) => {
    const node = nodeById.get(g.nodeId)
    return {
      ...g,
      nodeLabel: node?.label ?? null,
      modelId: node?.modelId ?? 'unknown',
      isSelected: node?.selectedGenerationId === g.id,
      nodeExists: node !== undefined
    }
  })
}

/**
 * Display URL of a node's selected output (asset url, or the selected/latest
 * successful generation), honoring the edge's sourceHandle ('output' | 'lastFrame').
 * Local port of convex/generations.ts resolveSelectedOutputUrl.
 */
export function resolveSelectedOutputUrl(
  node: Pick<GraphNode, 'id' | 'modelId' | 'params' | 'selectedGenerationId'>,
  sourceHandle: string
): string | null {
  if (node.modelId === 'studio/asset') {
    const assetId = (node.params as { assetId?: string } | undefined)?.assetId
    if (!assetId) return null
    const asset = getAsset(assetId)
    if (!asset) return null
    return asset.filePath ? `media://asset/${asset.id}` : asset.sourceUrl
  }

  const db = getDb()
  let gen: GenerationRow | null = null
  if (node.selectedGenerationId) {
    gen = getGeneration(node.selectedGenerationId)
    if (gen && gen.status !== 'success') gen = null
  }
  gen ??=
    db
      .select()
      .from(generations)
      .where(and(eq(generations.nodeId, node.id), eq(generations.status, 'success')))
      .orderBy(desc(generations.createdAt))
      .get() ?? null
  if (!gen) return null

  if (sourceHandle === 'lastFrame') {
    return gen.lastFramePath ? `media://generation/${gen.id}/lastFrame` : null
  }
  return gen.resultPath ? `media://generation/${gen.id}/result` : gen.resultUrl
}

/**
 * Still-frame fallback for video nodes whose generations all failed:
 * maps nodeId → URL of the first connected image input. Port of
 * convex/nodes.ts timelineFallbackImages.
 */
export function timelineFallbackImages(
  videoId: string,
  graph: {
    nodes: GraphNode[]
    edges: Array<{
      sourceNodeId: string
      targetNodeId: string
      targetHandle: string
      sourceHandle: string
      createdAt: number
    }>
  }
): Record<string, string> {
  void videoId
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const out: Record<string, string> = {}

  for (const node of graph.nodes) {
    const model = getModel(node.modelId)
    if (model?.kind !== 'video') continue
    const imageInputs = new Set(
      model.inputs.filter((h) => h.accepts.includes('image')).map((h) => h.key)
    )
    if (imageInputs.size === 0) continue

    const gens = listGenerationsForNode(node.id)
    const hasSuccess = gens.some((g) => g.status === 'success')
    const anyActive = gens.some((g) => g.status === 'running' || g.status === 'pending')
    const hasFailure = gens.some((g) => g.status === 'failed')
    if (hasSuccess || anyActive || !hasFailure) continue

    const incoming = graph.edges
      .filter((e) => e.targetNodeId === node.id && imageInputs.has(e.targetHandle))
      .sort((a, b) => a.createdAt - b.createdAt)

    for (const edge of incoming) {
      const source = nodeById.get(edge.sourceNodeId)
      if (!source) continue
      const url = resolveSelectedOutputUrl(source, edge.sourceHandle)
      if (url) {
        out[node.id] = url
        break
      }
    }
  }
  return out
}
