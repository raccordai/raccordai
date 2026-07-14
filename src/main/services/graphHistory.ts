import { eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/client'
import { edges, nodes } from '../db/schema'
import { broadcastWorkflowChanged } from '../events'

/**
 * Per-video undo/redo journal for graph mutations.
 *
 * Every public mutation in the graph service wraps itself in withGraphHistory:
 * the video's nodes+edges are snapshotted before and after, and undo/redo
 * restore a snapshot with a diff (only rows that changed are touched, so the
 * generations of untouched nodes survive an undo).
 *
 * Known limitation, by design: undoing a node deletion restores the node and
 * its edges but NOT its generations — their media files are deleted eagerly
 * and cannot be resurrected.
 *
 * Stacks are in-memory (per app run) and capped; a restart starts fresh.
 */

type NodeRow = typeof nodes.$inferSelect
type EdgeRow = typeof edges.$inferSelect

export interface GraphSnapshot {
  nodes: NodeRow[]
  edges: EdgeRow[]
}

interface HistoryEntry {
  before: GraphSnapshot
  after: GraphSnapshot
}

interface Stacks {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

const MAX_ENTRIES = 100

const stacksByVideo = new Map<string, Stacks>()
let replaying = false

function stacksFor(videoId: string): Stacks {
  let stacks = stacksByVideo.get(videoId)
  if (!stacks) {
    stacks = { undo: [], redo: [] }
    stacksByVideo.set(videoId, stacks)
  }
  return stacks
}

export function snapshotGraph(videoId: string): GraphSnapshot {
  const db = getDb()
  return {
    nodes: db.select().from(nodes).where(eq(nodes.videoId, videoId)).all(),
    edges: db.select().from(edges).where(eq(edges.videoId, videoId)).all()
  }
}

/** Structural equality, ignoring updatedAt churn (every mutation bumps it). */
function snapshotsEqual(a: GraphSnapshot, b: GraphSnapshot): boolean {
  const strip = (s: GraphSnapshot): string =>
    JSON.stringify({
      nodes: s.nodes
        .map(({ updatedAt, ...rest }) => {
          void updatedAt
          return rest
        })
        .sort((x, y) => x.id.localeCompare(y.id)),
      edges: [...s.edges].sort((x, y) => x.id.localeCompare(y.id))
    })
  return strip(a) === strip(b)
}

/** Diff-restore: only touch rows that differ, so unrelated generations survive. */
function restoreSnapshot(videoId: string, snapshot: GraphSnapshot): void {
  const db = getDb()
  db.transaction((tx) => {
    const currentNodes = tx.select().from(nodes).where(eq(nodes.videoId, videoId)).all()
    const currentEdges = tx.select().from(edges).where(eq(edges.videoId, videoId)).all()
    const wantNodes = new Map(snapshot.nodes.map((n) => [n.id, n]))
    const wantEdges = new Map(snapshot.edges.map((e) => [e.id, e]))

    // Nodes the snapshot doesn't have → delete (cascades their edges + generations).
    const extraNodeIds = currentNodes.filter((n) => !wantNodes.has(n.id)).map((n) => n.id)
    if (extraNodeIds.length > 0) tx.delete(nodes).where(inArray(nodes.id, extraNodeIds)).run()

    // Upsert snapshot nodes.
    const currentById = new Map(currentNodes.map((n) => [n.id, n]))
    for (const row of snapshot.nodes) {
      const existing = currentById.get(row.id)
      if (!existing) {
        tx.insert(nodes).values(row).run()
      } else if (JSON.stringify(existing) !== JSON.stringify(row)) {
        tx.update(nodes).set(row).where(eq(nodes.id, row.id)).run()
      }
    }

    // Edges: delete extras, insert missing (edges are immutable rows).
    const extraEdgeIds = currentEdges.filter((e) => !wantEdges.has(e.id)).map((e) => e.id)
    if (extraEdgeIds.length > 0) tx.delete(edges).where(inArray(edges.id, extraEdgeIds)).run()
    const currentEdgeIds = new Set(currentEdges.map((e) => e.id))
    for (const row of snapshot.edges) {
      if (!currentEdgeIds.has(row.id)) tx.insert(edges).values(row).run()
    }
  })
}

/**
 * Wraps a graph mutation: records an undo entry when the operation actually
 * changed the graph. No-op (plain passthrough) during undo/redo replay.
 */
export function withGraphHistory<T>(videoId: string, mutation: () => T): T {
  if (replaying) return mutation()
  const before = snapshotGraph(videoId)
  const result = mutation()
  const after = snapshotGraph(videoId)
  if (!snapshotsEqual(before, after)) {
    const stacks = stacksFor(videoId)
    stacks.undo.push({ before, after })
    if (stacks.undo.length > MAX_ENTRIES) stacks.undo.shift()
    stacks.redo = []
    // Single push point for "the graph changed" — keeps the renderer's
    // undo/redo state (and any other window) in sync regardless of which
    // side (IPC, MCP, assistant) performed the mutation.
    broadcastWorkflowChanged(videoId)
  }
  return result
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
}

export function historyState(videoId: string): HistoryState {
  const stacks = stacksFor(videoId)
  return { canUndo: stacks.undo.length > 0, canRedo: stacks.redo.length > 0 }
}

export function undoGraph(videoId: string): HistoryState {
  const stacks = stacksFor(videoId)
  const entry = stacks.undo.pop()
  if (entry) {
    replaying = true
    try {
      restoreSnapshot(videoId, entry.before)
    } finally {
      replaying = false
    }
    stacks.redo.push(entry)
  }
  return historyState(videoId)
}

export function redoGraph(videoId: string): HistoryState {
  const stacks = stacksFor(videoId)
  const entry = stacks.redo.pop()
  if (entry) {
    replaying = true
    try {
      restoreSnapshot(videoId, entry.after)
    } finally {
      replaying = false
    }
    stacks.undo.push(entry)
  }
  return historyState(videoId)
}

/** Test-only: reset all stacks. */
export function clearGraphHistory(): void {
  stacksByVideo.clear()
}
