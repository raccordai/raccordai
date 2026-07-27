import { eq } from 'drizzle-orm'
import { lintNode, type LintConnection, type LintFinding } from '@shared/promptLint'
import { getModel } from '@shared/models'
import { getDb } from '../db/client'
import { assets, edges, nodes } from '../db/schema'

/**
 * Prompt lint (§6.5) — the I/O half: read a node's model, params and wiring
 * from the database and hand them to the pure `lintNode`. The renderer lints
 * locally (it already holds the graph); this module serves the agents
 * (`lint_node`), the run confirm and the vision-QC report.
 */

/** `params.designId` of a source node — resolved through the asset for asset nodes. */
function designIdOf(node: typeof nodes.$inferSelect): string | undefined {
  const params = (node.params ?? {}) as { designId?: unknown; assetId?: unknown }
  if (typeof params.designId === 'string') return params.designId
  if (node.modelId === 'studio/asset' && typeof params.assetId === 'string') {
    const asset = getDb().select().from(assets).where(eq(assets.id, params.assetId)).get()
    return asset?.designId ?? undefined
  }
  return undefined
}

/**
 * The node's incoming connections in the SAME order the run engine numbers
 * them (edge createdAt), so `@Image2` here is `@Image2` at payload time.
 */
export function connectionsFor(nodeId: string): LintConnection[] {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) return []
  const model = getModel(node.modelId)
  const handleByKey = new Map((model?.inputs ?? []).map((h) => [h.key, h]))
  const incoming = db
    .select()
    .from(edges)
    .where(eq(edges.targetNodeId, nodeId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)

  const counters = new Map<string, number>()
  return incoming.map((edge) => {
    const index = (counters.get(edge.targetHandle) ?? 0) + 1
    counters.set(edge.targetHandle, index)
    const handle = handleByKey.get(edge.targetHandle)
    const source = db.select().from(nodes).where(eq(nodes.id, edge.sourceNodeId)).get()
    const sourceDuration = (source?.params as { duration?: unknown } | null)?.duration
    return {
      edgeId: edge.id,
      handleKey: edge.targetHandle,
      ...(handle?.referenceAlias ? { alias: `${handle.referenceAlias}${index}` } : {}),
      ...(source ? { sourceLabel: source.label ?? source.key } : {}),
      ...(source && designIdOf(source) ? { designId: designIdOf(source) } : {}),
      ...(typeof sourceDuration === 'number' && Number.isFinite(sourceDuration)
        ? { sourceDurationSeconds: sourceDuration }
        : {})
    }
  })
}

/** Lint one node by id (empty for an unknown node — nothing to say). */
export function lintNodeById(nodeId: string): LintFinding[] {
  const node = getDb().select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) return []
  return lintNode({
    modelId: node.modelId,
    params: (node.params ?? {}) as Record<string, unknown>,
    connections: connectionsFor(nodeId)
  })
}
