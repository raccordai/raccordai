import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { defaultParamsFor, getModelOrThrow } from '@shared/models'
import type { GraphEdge, GraphNode, WorkflowExport } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { assets, edges, generations, nodes } from '../db/schema'
import { deleteMediaFile } from '../media/files'
import { withGraphHistory } from './graphHistory'
import { getVideo, touchVideo } from './videos'

/**
 * Faithful port of video-studio's convex/nodes.ts onto SQLite.
 * Positions are stored as columns but exposed as { x, y } to keep the
 * UI-facing shape identical to the original.
 */

type NodeRow = typeof nodes.$inferSelect

function toGraphNode(row: NodeRow): GraphNode {
  const { positionX, positionY, ...rest } = row
  return { ...rest, position: { x: positionX, y: positionY }, params: row.params ?? {} }
}

export function listGraph(videoId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const db = getDb()
  return {
    nodes: db
      .select()
      .from(nodes)
      .where(eq(nodes.videoId, videoId))
      .orderBy(asc(nodes.createdAt))
      .all()
      .map(toGraphNode),
    edges: db
      .select()
      .from(edges)
      .where(eq(edges.videoId, videoId))
      .orderBy(asc(edges.createdAt))
      .all()
  }
}

function randomKey(): string {
  return `node_${Math.random().toString(36).slice(2, 8)}`
}

function keyExists(videoId: string, key: string): boolean {
  return (
    getDb()
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.videoId, videoId), eq(nodes.key, key)))
      .get() !== undefined
  )
}

export function createNode(args: {
  videoId: string
  modelId: string
  position: { x: number; y: number }
  key?: string
  params?: unknown
  label?: string
  intent?: string
}): GraphNode {
  // Asset nodes skip the model registry check.
  if (args.modelId !== 'studio/asset') getModelOrThrow(args.modelId)

  const now = Date.now()
  let resolvedKey = args.key ?? randomKey()
  while (keyExists(args.videoId, resolvedKey)) resolvedKey = randomKey()

  const params =
    args.params ?? (args.modelId === 'studio/asset' ? {} : defaultParamsFor(args.modelId))

  const row: NodeRow = {
    id: randomUUID(),
    videoId: args.videoId,
    key: resolvedKey,
    modelId: args.modelId,
    label: args.label ?? null,
    intent: args.intent ?? null,
    positionX: args.position.x,
    positionY: args.position.y,
    params,
    selectedGenerationId: null,
    createdAt: now,
    updatedAt: now
  }
  withGraphHistory(args.videoId, () => getDb().insert(nodes).values(row).run())
  touchVideo(args.videoId)
  return toGraphNode(row)
}

/** Runs a node mutation inside the undo journal, resolving its videoId first. */
function patchNodeWithHistory(nodeId: string, patch: Partial<NodeRow>): void {
  const node = getDb()
    .select({ videoId: nodes.videoId })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .get()
  if (!node) return
  withGraphHistory(node.videoId, () => patchNode(nodeId, patch))
}

function patchNode(nodeId: string, patch: Partial<NodeRow>): void {
  getDb()
    .update(nodes)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(nodes.id, nodeId))
    .run()
}

export function updateNodeParams(nodeId: string, params: unknown): void {
  patchNodeWithHistory(nodeId, { params })
}

export function updateNodePosition(nodeId: string, position: { x: number; y: number }): void {
  patchNodeWithHistory(nodeId, { positionX: position.x, positionY: position.y })
}

export function updateNodePositions(
  updates: Array<{ nodeId: string; position: { x: number; y: number } }>
): void {
  const db = getDb()
  const first = updates[0]
  if (!first) return
  const node = db
    .select({ videoId: nodes.videoId })
    .from(nodes)
    .where(eq(nodes.id, first.nodeId))
    .get()
  const apply = (): void => {
    db.transaction((tx) => {
      const now = Date.now()
      for (const u of updates) {
        tx.update(nodes)
          .set({ positionX: u.position.x, positionY: u.position.y, updatedAt: now })
          .where(eq(nodes.id, u.nodeId))
          .run()
      }
    })
  }
  if (node) withGraphHistory(node.videoId, apply)
  else apply()
}

export function updateNodeLabel(nodeId: string, label: string): void {
  patchNodeWithHistory(nodeId, { label })
}

/** Empty string clears the intent (matches video-studio behavior). */
export function updateNodeIntent(nodeId: string, intent: string): void {
  patchNodeWithHistory(nodeId, { intent: intent.trim() === '' ? null : intent })
}

export function setSelectedGeneration(nodeId: string, generationId: string | null): void {
  patchNode(nodeId, { selectedGenerationId: generationId })
}

function deleteGenerationsForNode(nodeId: string): void {
  const db = getDb()
  const gens = db.select().from(generations).where(eq(generations.nodeId, nodeId)).all()
  for (const gen of gens) {
    deleteMediaFile(gen.resultPath)
    deleteMediaFile(gen.lastFramePath)
  }
  db.delete(generations).where(eq(generations.nodeId, nodeId)).run()
}

export function removeNode(nodeId: string): void {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) return
  // Undoing this restores the node and its edges, not its generations
  // (their media files are deleted for good here).
  withGraphHistory(node.videoId, () => {
    deleteGenerationsForNode(nodeId)
    // Edges on either side go away via ON DELETE CASCADE.
    db.delete(nodes).where(eq(nodes.id, nodeId)).run()
  })
  touchVideo(node.videoId)
}

/**
 * Swap a node's model in place. Keeps position/label; params start from the new
 * model's defaults with shared keys carried over; edges are kept, remapped by
 * media kind, or dropped; generations are deleted (stale under the new model).
 */
export function replaceNodeModel(nodeId: string, modelId: string): void {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) throw new Error('Node not found')
  if (node.modelId === 'studio/asset') throw new Error('Asset nodes have no model to replace')
  if (node.modelId === modelId) return

  const oldModel = getModelOrThrow(node.modelId)
  const newModel = getModelOrThrow(modelId)

  const newDefaults = defaultParamsFor(modelId)
  const newFieldKeys = new Set(newModel.paramFields.map((f) => f.key))
  const oldParams = (node.params ?? {}) as Record<string, unknown>
  const nextParams: Record<string, unknown> = { ...newDefaults }
  for (const [k, val] of Object.entries(oldParams)) {
    if (newFieldKeys.has(k)) nextParams[k] = val
  }

  const videoEdges = db.select().from(edges).where(eq(edges.videoId, node.videoId)).all()
  const newInputKeys = new Set(newModel.inputs.map((i) => i.key))
  const newOutputKeys = new Set(newModel.outputs.map((o) => o.key))

  withGraphHistory(node.videoId, () => {
    for (const e of videoEdges) {
      if (e.targetNodeId === nodeId) {
        if (newInputKeys.has(e.targetHandle)) continue
        const oldInput = oldModel.inputs.find((i) => i.key === e.targetHandle)
        const replacement = oldInput
          ? newModel.inputs.find((i) => i.accepts.some((k) => oldInput.accepts.includes(k)))
          : undefined
        if (replacement) {
          db.update(edges).set({ targetHandle: replacement.key }).where(eq(edges.id, e.id)).run()
        } else {
          db.delete(edges).where(eq(edges.id, e.id)).run()
        }
        continue
      }
      if (e.sourceNodeId === nodeId) {
        if (newOutputKeys.has(e.sourceHandle)) continue
        const oldOutput = oldModel.outputs.find((o) => o.key === e.sourceHandle)
        const replacement = oldOutput
          ? newModel.outputs.find((o) => o.kind === oldOutput.kind)
          : undefined
        if (replacement) {
          db.update(edges).set({ sourceHandle: replacement.key }).where(eq(edges.id, e.id)).run()
        } else {
          db.delete(edges).where(eq(edges.id, e.id)).run()
        }
      }
    }

    deleteGenerationsForNode(nodeId)
    patchNode(nodeId, { modelId, params: nextParams, selectedGenerationId: null })
  })
  touchVideo(node.videoId)
}

// ── Edges ────────────────────────────────────────────────────────────────────

export function connectNodes(args: {
  videoId: string
  sourceNodeId: string
  sourceHandle: string
  targetNodeId: string
  targetHandle: string
}): GraphEdge {
  const db = getDb()
  const existing = db.select().from(edges).where(eq(edges.videoId, args.videoId)).all()
  for (const e of existing) {
    if (
      e.targetNodeId === args.targetNodeId &&
      e.targetHandle === args.targetHandle &&
      e.sourceNodeId === args.sourceNodeId &&
      e.sourceHandle === args.sourceHandle
    ) {
      return e
    }
  }
  const edge: GraphEdge = { id: randomUUID(), ...args, createdAt: Date.now() }
  withGraphHistory(args.videoId, () => db.insert(edges).values(edge).run())
  touchVideo(args.videoId)
  return edge
}

export function disconnectEdge(edgeId: string): void {
  const db = getDb()
  const edge = db.select().from(edges).where(eq(edges.id, edgeId)).get()
  if (!edge) return
  withGraphHistory(edge.videoId, () => db.delete(edges).where(eq(edges.id, edgeId)).run())
}

// ── JSON workflow import / export ────────────────────────────────────────────

export function exportWorkflow(videoId: string): WorkflowExport {
  const video = getVideo(videoId)
  if (!video) throw new Error('Video not found')
  const { nodes: videoNodes, edges: videoEdges } = listGraph(videoId)

  const referencedAssetIds = new Set<string>()
  for (const n of videoNodes) {
    if (n.modelId === 'studio/asset') {
      const aid = (n.params as { assetId?: string } | undefined)?.assetId
      if (aid) referencedAssetIds.add(aid)
    }
  }
  const db = getDb()
  const assetById = new Map(
    [...referencedAssetIds]
      .map((aid) => db.select().from(assets).where(eq(assets.id, aid)).get())
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => [a.id, a])
  )

  const exportedNodes = videoNodes.map((n) => {
    let exportedParams: Record<string, unknown> = (n.params ?? {}) as Record<string, unknown>
    if (n.modelId === 'studio/asset') {
      const aid = (n.params as { assetId?: string } | undefined)?.assetId
      const a = aid ? assetById.get(aid) : undefined
      exportedParams = { assetKey: a?.key ?? null }
    }
    return {
      key: n.key,
      modelId: n.modelId,
      label: n.label ?? undefined,
      intent: n.intent ?? undefined,
      position: n.position,
      params: exportedParams
    }
  })

  const nodeById = new Map(videoNodes.map((n) => [n.id, n]))
  const exportedEdges = videoEdges.map((e) => ({
    from: nodeById.get(e.sourceNodeId)?.key,
    to: nodeById.get(e.targetNodeId)?.key,
    input: e.targetHandle,
    output: e.sourceHandle
  }))

  const exportedAssets = [...assetById.values()].map((a) => ({
    key: a.key,
    name: a.name,
    kind: a.kind,
    mimeType: a.mimeType ?? undefined,
    description: a.description ?? ''
  }))

  return { version: 1, assets: exportedAssets, nodes: exportedNodes, edges: exportedEdges }
}

export function importWorkflow(
  videoId: string,
  json: string,
  replace: boolean
): { nodeCount: number; edgeCount: number } {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err
    })
  }
  const incomingNodes = Array.isArray(parsed?.nodes) ? parsed.nodes : []
  const incomingEdges = Array.isArray(parsed?.edges) ? parsed.edges : []
  const declaredAssets: Array<{ key?: string; name?: string }> = Array.isArray(parsed?.assets)
    ? parsed.assets
    : []

  const video = getVideo(videoId)
  if (!video) throw new Error('Target video not found')
  const projectId = video.projectId
  const db = getDb()

  function resolveAssetParams(rawParams: unknown): Record<string, unknown> {
    const params = { ...((rawParams as Record<string, unknown> | null | undefined) ?? {}) }
    const assetKey = typeof params.assetKey === 'string' ? params.assetKey : undefined
    const assetId = typeof params.assetId === 'string' ? params.assetId : undefined
    if (assetKey) {
      const found = db
        .select()
        .from(assets)
        .where(and(eq(assets.projectId, projectId), eq(assets.key, assetKey)))
        .get()
      if (!found) {
        const declared = declaredAssets.find((a) => a?.key === assetKey)
        const hint = declared?.name ? ` ("${declared.name}")` : ''
        throw new Error(
          `Asset with key "${assetKey}"${hint} is not in this project. Import it first, then re-import.`
        )
      }
      delete params.assetKey
      params.assetId = found.id
      return params
    }
    if (assetId) {
      const found = db.select().from(assets).where(eq(assets.id, assetId)).get()
      if (!found || found.projectId !== projectId) {
        throw new Error(
          `Asset id "${assetId}" is not in this project. Use "assetKey" instead — keys are portable across projects.`
        )
      }
      return params
    }
    return params
  }

  withGraphHistory(videoId, () =>
    db.transaction((tx) => {
      if (replace) {
        const existingNodes = tx.select().from(nodes).where(eq(nodes.videoId, videoId)).all()
        for (const n of existingNodes) {
          const gens = tx.select().from(generations).where(eq(generations.nodeId, n.id)).all()
          for (const g of gens) {
            deleteMediaFile(g.resultPath)
            deleteMediaFile(g.lastFramePath)
          }
        }
        // Edges and generations cascade with their nodes.
        tx.delete(nodes).where(eq(nodes.videoId, videoId)).run()
      }

      const now = Date.now()
      const keyToId = new Map<string, string>()

      for (const raw of incomingNodes) {
        if (!raw?.key || !raw?.modelId) {
          throw new Error('Each node must have a "key" and "modelId"')
        }
        if (raw.modelId !== 'studio/asset') getModelOrThrow(raw.modelId)

        const params =
          raw.modelId === 'studio/asset'
            ? resolveAssetParams(raw.params)
            : (raw.params ?? defaultParamsFor(raw.modelId))

        const position = raw.position ?? { x: 0, y: 0 }
        const id = randomUUID()
        tx.insert(nodes)
          .values({
            id,
            videoId,
            key: raw.key,
            modelId: raw.modelId,
            label: raw.label ?? null,
            intent: typeof raw.intent === 'string' ? raw.intent : null,
            positionX: Number(position.x) || 0,
            positionY: Number(position.y) || 0,
            params,
            selectedGenerationId: null,
            createdAt: now,
            updatedAt: now
          })
          .run()
        keyToId.set(raw.key, id)
      }

      for (const [i, raw] of incomingEdges.entries()) {
        const { from, to, input } = raw ?? {}
        if (!from || !to || !input) {
          throw new Error('Each edge must specify "from", "to", and "input" (target handle)')
        }
        const sourceId = keyToId.get(from)
        const targetId = keyToId.get(to)
        if (!sourceId || !targetId) {
          throw new Error(`Edge references unknown node key: from=${from}, to=${to}`)
        }
        tx.insert(edges)
          .values({
            id: randomUUID(),
            videoId,
            sourceNodeId: sourceId,
            sourceHandle: raw.output ?? 'output',
            targetNodeId: targetId,
            targetHandle: input,
            // Strictly increasing: reference numbering (@Image1, @Image2, …) sorts
            // by edge createdAt — a shared timestamp would make it nondeterministic.
            createdAt: now + i
          })
          .run()
      }
    })
  )

  touchVideo(videoId)
  return { nodeCount: incomingNodes.length, edgeCount: incomingEdges.length }
}
