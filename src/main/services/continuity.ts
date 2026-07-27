import { eq } from 'drizzle-orm'
import { getModel, type InputHandle } from '@shared/models'
import { planContinuityChain, type ShotForChain } from '@shared/shotContinuity'
import { getDb } from '../db/client'
import { edges, nodes } from '../db/schema'
import * as graph from './graph'
import { withGraphHistoryGroup } from './graphHistory'

/**
 * Shot continuity — the I/O half of `@shared/shotContinuity`.
 *
 * Wires each shot's clip into the NEXT shot's reference-video handle and
 * appends the reference's role to that shot's prompt, as ONE undo step: the
 * user chained a sequence, they undo a sequence.
 *
 * This is deliberately not the default wiring of a sequence — it serializes the
 * batch (shot N cannot run before N-1 has settled) and a re-roll in the middle
 * invalidates everything downstream. The assistant proposes it; this carries it
 * out.
 */

/** The model's reference handle for videos: multiple, aliased, not an anchor. */
function referenceVideoHandle(modelId: string): InputHandle | undefined {
  return getModel(modelId)?.inputs.find(
    (h) => !h.frameAnchor && h.accepts.includes('video') && (h.multiple ?? false)
  )
}

export interface LinkShotsResult {
  linked: Array<{ sourceNodeId: string; targetNodeId: string; alias: string }>
  skipped: Array<{ sourceNodeId: string; targetNodeId: string; reason: string }>
}

/**
 * Chains `nodeIds` in the given order (timeline order — the caller's job).
 * Every node must belong to `videoId` and be a video shot. A target whose model
 * has no reference-video input (Seedance 1.5, Grok) or whose handle is already
 * full is reported in `skipped`, so one impossible cut never costs the rest of
 * the chain.
 */
export function linkShots(videoId: string, nodeIds: string[]): LinkShotsResult {
  if (nodeIds.length < 2) {
    throw new Error('Chaining continuity needs at least two shots, in timeline order.')
  }
  const db = getDb()
  const rows = nodeIds.map((id) => {
    const row = db.select().from(nodes).where(eq(nodes.id, id)).get()
    if (!row) throw new Error(`Unknown nodeId "${id}".`)
    if (row.videoId !== videoId) throw new Error(`Node "${id}" does not belong to this video.`)
    if (getModel(row.modelId)?.kind !== 'video') {
      throw new Error(`Node "${row.label ?? row.key}" is not a video shot.`)
    }
    return row
  })

  const allNodes = db.select().from(nodes).where(eq(nodes.videoId, videoId)).all()
  const byId = new Map(allNodes.map((n) => [n.id, n]))
  const allEdges = db.select().from(edges).where(eq(edges.videoId, videoId)).all()
  const durationOf = (nodeId: string): number | undefined => {
    const value = (byId.get(nodeId)?.params as { duration?: unknown } | undefined)?.duration
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /** The handle's connections, in the order that numbers their aliases. */
  const wiredTo = (nodeId: string, handleKey: string) =>
    allEdges
      .filter((e) => e.targetNodeId === nodeId && e.targetHandle === handleKey)
      .sort((a, b) => a.createdAt - b.createdAt)

  /** What the target handle already carries: alias numbering and budget. */
  const existingRefs = (nodeId: string, handleKey: string): { count: number; seconds: number } => {
    const wired = wiredTo(nodeId, handleKey)
    return {
      count: wired.length,
      seconds: wired.reduce((sum, e) => sum + (durationOf(e.sourceNodeId) ?? 0), 0)
    }
  }

  const result: LinkShotsResult = { linked: [], skipped: [] }
  const planned: Array<{
    handle: InputHandle
    targetRow: (typeof rows)[number]
    alias: string
    role: string
    sourceId: string
  }> = []

  // Planned pair by pair: the budget belongs to the TARGET's handle, and a
  // sequence may legitimately mix models.
  for (let i = 1; i < rows.length; i++) {
    const source = rows[i - 1]!
    const target = rows[i]!
    const handle = referenceVideoHandle(target.modelId)
    if (!handle) {
      result.skipped.push({
        sourceNodeId: source.id,
        targetNodeId: target.id,
        reason: `"${target.label ?? target.key}" runs on ${target.modelId}, which has no reference-video input — leave that cut unchained and carry consistency with the shared sheets.`
      })
      continue
    }
    // Already chained: report it with the alias it ALREADY answers to and
    // touch nothing. Re-running the tool (an agent retry, a second pass over a
    // longer selection) must not append a second role sentence for an edge
    // `connectNodes` will dedupe anyway.
    const wired = wiredTo(target.id, handle.key)
    const existingIndex = wired.findIndex((e) => e.sourceNodeId === source.id)
    if (existingIndex >= 0) {
      result.linked.push({
        sourceNodeId: source.id,
        targetNodeId: target.id,
        alias: `${handle.referenceAlias ?? '@Video'}${existingIndex + 1}`
      })
      continue
    }

    const shots: ShotForChain[] = [
      {
        id: source.id,
        label: source.label ?? source.key,
        ...(durationOf(source.id) !== undefined ? { durationSeconds: durationOf(source.id) } : {})
      },
      {
        id: target.id,
        label: target.label ?? target.key,
        existingRefs: existingRefs(target.id, handle.key)
      }
    ]
    const plan = planContinuityChain(shots, {
      maxCount: handle.maxCount,
      maxTotalSeconds: handle.maxTotalSeconds,
      alias: handle.referenceAlias ?? '@Video'
    })
    for (const skip of plan.skipped) {
      result.skipped.push({
        sourceNodeId: skip.sourceId,
        targetNodeId: skip.targetId,
        reason: skip.reason
      })
    }
    for (const link of plan.links) {
      planned.push({
        handle,
        targetRow: target,
        alias: link.alias,
        role: link.role,
        sourceId: link.sourceId
      })
    }
  }

  if (planned.length === 0) return result

  withGraphHistoryGroup(videoId, () => {
    for (const link of planned) {
      graph.connectNodes({
        videoId,
        sourceNodeId: link.sourceId,
        sourceHandle: 'output',
        targetNodeId: link.targetRow.id,
        targetHandle: link.handle.key
      })
      // A reference nobody addresses in the prompt only guides by accident —
      // the rule the lint enforces, applied at wiring time.
      const params = { ...((link.targetRow.params as Record<string, unknown> | null) ?? {}) }
      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      if (!prompt.includes(link.alias)) {
        params.prompt = prompt.trim() ? `${prompt.trim()} ${link.role}` : link.role
        graph.updateNodeParams(link.targetRow.id, params)
      }
      result.linked.push({
        sourceNodeId: link.sourceId,
        targetNodeId: link.targetRow.id,
        alias: link.alias
      })
    }
  })

  return result
}
