import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { defaultParamsFor, getModel, getModelOrThrow, videoDefaultParams } from '@shared/models'
import {
  autoLayoutPositions,
  needsLayout,
  resolveOverlaps,
  type LayoutEdge,
  type LayoutNode
} from '@shared/graphLayout'
import { APPLY_VIDEO_STYLE_PARAM } from '@shared/styles/registry'
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

/** Default params of a freshly created node: model defaults + video defaults + style flag. */
function defaultCreationParams(videoId: string, modelId: string): Record<string, unknown> {
  if (modelId === 'studio/asset') return {}
  const model = getModelOrThrow(modelId)
  return {
    ...defaultParamsFor(modelId),
    ...videoDefaultParams(modelId, getVideo(videoId)),
    ...(model.kind !== 'audio' ? { [APPLY_VIDEO_STYLE_PARAM]: true } : {})
  }
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

/** Column pitch of the left-to-right flow convention (matches the templates). */
const COLUMN_PITCH = 420

/**
 * Free slot for a node created without an explicit position — the next column
 * to the right of the graph, aligned on its top row. Agents call add_node
 * without x/y all the time; defaulting to the origin piled every one of them
 * onto the same spot.
 */
export function nextFreePosition(videoId: string): { x: number; y: number } {
  const existing = getDb()
    .select({ x: nodes.positionX, y: nodes.positionY })
    .from(nodes)
    .where(eq(nodes.videoId, videoId))
    .all()
  if (existing.length === 0) return { x: 40, y: 40 }
  return {
    x: Math.max(...existing.map((n) => n.x)) + COLUMN_PITCH,
    y: Math.min(...existing.map((n) => n.y))
  }
}

export function createNode(args: {
  videoId: string
  modelId: string
  /** Omit to drop the node in the next free slot (see nextFreePosition). */
  position?: { x: number; y: number }
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

  // Caller-provided params are taken verbatim (templates, designs and agents
  // manage their own markers); the plain-creation path pre-fills the video's
  // defaults and opts visual nodes into style-at-payload.
  const params = args.params ?? defaultCreationParams(args.videoId, args.modelId)
  const position = args.position ?? nextFreePosition(args.videoId)

  const row: NodeRow = {
    id: randomUUID(),
    videoId: args.videoId,
    key: resolvedKey,
    modelId: args.modelId,
    label: args.label ?? null,
    intent: args.intent ?? null,
    positionX: position.x,
    positionY: position.y,
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

/** Node id → its video + label (focus_node tools); null when unknown. */
export function getNodeRef(
  nodeId: string
): { id: string; videoId: string; label: string | null } | null {
  const row = getDb()
    .select({ id: nodes.id, videoId: nodes.videoId, label: nodes.label })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .get()
  return row ?? null
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
  // The style-at-payload marker survives a model swap between visual models.
  if (newModel.kind !== 'audio' && oldParams[APPLY_VIDEO_STYLE_PARAM] === true) {
    nextParams[APPLY_VIDEO_STYLE_PARAM] = true
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

/**
 * Reorder the connections of one input handle (§4.6). Reference numbering
 * (@Image1, @Image2…) sorts by edge createdAt, so reordering = redistributing
 * the handle's existing timestamps over the requested order (kept strictly
 * increasing so ties can never make the numbering ambiguous). One journaled
 * step — the whole reorder undoes at once.
 */
export function reorderEdges(args: {
  videoId: string
  targetNodeId: string
  targetHandle: string
  edgeIds: string[]
}): void {
  const db = getDb()
  const current = db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.videoId, args.videoId),
        eq(edges.targetNodeId, args.targetNodeId),
        eq(edges.targetHandle, args.targetHandle)
      )
    )
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)

  const currentIds = new Set(current.map((e) => e.id))
  const requested = new Set(args.edgeIds)
  if (
    requested.size !== args.edgeIds.length ||
    currentIds.size !== requested.size ||
    ![...requested].every((id) => currentIds.has(id))
  ) {
    throw new Error('edgeIds must be a permutation of the handle’s current connections')
  }

  const timestamps: number[] = []
  for (const e of current) {
    const prev = timestamps[timestamps.length - 1]
    timestamps.push(prev !== undefined && e.createdAt <= prev ? prev + 1 : e.createdAt)
  }

  withGraphHistory(args.videoId, () =>
    db.transaction((tx) => {
      args.edgeIds.forEach((id, i) => {
        tx.update(edges).set({ createdAt: timestamps[i] }).where(eq(edges.id, id)).run()
      })
    })
  )
  touchVideo(args.videoId)
}

/**
 * Move one edge to another input handle of the SAME target node (§6.5's
 * one-click fix for a design sheet wired to a frame anchor). One journaled
 * step — a disconnect + connect pair would cost the user two undos and, in
 * between, leave the reference numbering of the handle inconsistent.
 */
export function rewireEdge(edgeId: string, targetHandle: string): GraphEdge {
  const db = getDb()
  const edge = db.select().from(edges).where(eq(edges.id, edgeId)).get()
  if (!edge) throw new Error('Edge not found')
  if (edge.targetHandle === targetHandle) return edge
  const target = db.select().from(nodes).where(eq(nodes.id, edge.targetNodeId)).get()
  const model = target ? getModel(target.modelId) : undefined
  const handle = model?.inputs.find((h) => h.key === targetHandle)
  if (!handle) throw new Error(`"${targetHandle}" is not an input of the target node`)

  // Land last on the new handle: the numbering is by createdAt, and a moved
  // edge must not silently steal @Image1 from an existing connection.
  const siblings = db
    .select()
    .from(edges)
    .where(and(eq(edges.targetNodeId, edge.targetNodeId), eq(edges.targetHandle, targetHandle)))
    .all()
  const createdAt = Math.max(Date.now(), ...siblings.map((e) => e.createdAt + 1))

  withGraphHistory(edge.videoId, () =>
    db.update(edges).set({ targetHandle, createdAt }).where(eq(edges.id, edgeId)).run()
  )
  touchVideo(edge.videoId)
  return { ...edge, targetHandle, createdAt }
}

export function disconnectEdge(edgeId: string): void {
  const db = getDb()
  const edge = db.select().from(edges).where(eq(edges.id, edgeId)).get()
  if (!edge) return
  withGraphHistory(edge.videoId, () => db.delete(edges).where(eq(edges.id, edgeId)).run())
}

/**
 * Bulk-apply the video's defaults (aspect ratio / resolution) to every
 * existing node whose model supports the values — the explicit "apply to N
 * nodes" gesture. One journaled step, so the whole sweep undoes at once.
 */
export function applyVideoDefaultsToNodes(videoId: string): { updated: number } {
  const video = getVideo(videoId)
  if (!video) throw new Error('Video not found')
  const db = getDb()
  const rows = db.select().from(nodes).where(eq(nodes.videoId, videoId)).all()

  const updates: Array<{ id: string; params: Record<string, unknown> }> = []
  for (const node of rows) {
    if (!getModel(node.modelId)) continue
    const patch = videoDefaultParams(node.modelId, video)
    const params = (node.params ?? {}) as Record<string, unknown>
    if (Object.entries(patch).some(([k, v]) => params[k] !== v)) {
      updates.push({ id: node.id, params: { ...params, ...patch } })
    }
  }
  if (updates.length === 0) return { updated: 0 }

  withGraphHistory(videoId, () =>
    db.transaction((tx) => {
      const now = Date.now()
      for (const u of updates) {
        tx.update(nodes).set({ params: u.params, updatedAt: now }).where(eq(nodes.id, u.id)).run()
      }
    })
  )
  touchVideo(videoId)
  return { updated: updates.length }
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

/** Vertical gap left between an existing graph and an appended import. */
const IMPORT_APPEND_GAP = 120

/**
 * Positions for an imported graph. Agents routinely omit `position` entirely
 * (every node then defaulted to the origin — the "all my nodes are stacked on
 * top of each other" bug) or reuse one coordinate for the whole workflow, so
 * the layout is computed here rather than trusted. When positions ARE usable
 * they win, and only genuine overlaps get pushed apart.
 *
 * Appending (replace=false) shifts the result below the existing graph so the
 * import never lands on top of what is already on the canvas.
 */
function planImportPositions(
  videoId: string,
  incomingNodes: Array<{ key?: string; modelId?: string; label?: string; position?: unknown }>,
  incomingEdges: Array<{ from?: string; to?: string }>,
  replace: boolean
): Map<string, { x: number; y: number }> {
  const usable = incomingNodes.filter(
    (n): n is typeof n & { key: string } => typeof n?.key === 'string' && n.key !== ''
  )
  if (usable.length === 0) return new Map()

  const coord = (raw: unknown): { x: number; y: number } => {
    const p = (raw ?? {}) as { x?: unknown; y?: unknown }
    return { x: Number(p.x) || 0, y: Number(p.y) || 0 }
  }
  const layoutNodes: LayoutNode[] = usable.map((n, i) => ({
    id: n.key,
    type: n.modelId === 'studio/asset' ? 'assetNode' : 'modelNode',
    position: coord(n.position),
    label: typeof n.label === 'string' ? n.label : undefined,
    key: n.key,
    // No timestamps in a blueprint — array order IS the authored order.
    createdAt: i
  }))
  const layoutEdges: LayoutEdge[] = incomingEdges
    .filter((e) => typeof e?.from === 'string' && typeof e?.to === 'string')
    .map((e) => ({ source: e.from!, target: e.to! }))

  const positions = new Map<string, { x: number; y: number }>()
  if (needsLayout(layoutNodes.map((n) => n.position))) {
    for (const { id, position } of autoLayoutPositions(layoutNodes, layoutEdges)) {
      positions.set(id, position)
    }
  } else {
    for (const n of layoutNodes) positions.set(n.id, n.position)
    // Authored positions are kept as-is; only real collisions are resolved.
    const seeds = layoutNodes.map((n) => n.id)
    for (const { id, position } of resolveOverlaps(layoutNodes, seeds)) {
      positions.set(id, position)
    }
  }

  if (!replace) {
    const existing = getDb()
      .select({ y: nodes.positionY })
      .from(nodes)
      .where(eq(nodes.videoId, videoId))
      .all()
    if (existing.length > 0) {
      // Approximate node height is enough — the gap absorbs the difference.
      const bottom = Math.max(...existing.map((n) => n.y)) + 260 + IMPORT_APPEND_GAP
      const top = Math.min(...[...positions.values()].map((p) => p.y))
      const shift = bottom - top
      if (shift > 0) {
        for (const [id, p] of positions) positions.set(id, { x: p.x, y: p.y + shift })
      }
    }
  }
  return positions
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

  const placed = planImportPositions(videoId, incomingNodes, incomingEdges, replace)

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

        const position = placed.get(raw.key) ?? raw.position ?? { x: 0, y: 0 }
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
