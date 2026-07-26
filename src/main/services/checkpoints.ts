import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { diffCheckpoint, type CheckpointDiff } from '@shared/checkpointDiff'
import type { WorkflowExport } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { generations, nodes, videoCheckpoints } from '../db/schema'
import * as graph from './graph'
import {
  applyGraphSnapshot,
  snapshotGraph,
  withGraphHistoryGroup,
  type GraphSnapshot
} from './graphHistory'

/**
 * Named checkpoints (§6.4) — the safety net that authorizes boldness: capture
 * the graph, try something drastic, compare, and come back if it was worse.
 *
 * A checkpoint stores the raw graph rows (the restore payload), the portable
 * workflow-JSON v1 export (diff + export) and the selected generation per node
 * KEY. Restoring replays the rows through the SAME diff-restore as undo, as
 * ONE journaled step: nodes present on both sides keep their identity and
 * their generations, nodes created since the capture go away with theirs, and
 * a single undo walks back out of the restore. Selections are re-pointed by
 * key; those whose generation no longer exists are skipped and counted —
 * deleted outputs are never resurrected, consistent with undo.
 */

export interface CheckpointSummary {
  id: string
  videoId: string
  name: string
  nodeCount: number
  createdAt: number
}

type CheckpointRow = typeof videoCheckpoints.$inferSelect

function toSummary(row: CheckpointRow): CheckpointSummary {
  const workflow = row.workflow as WorkflowExport
  return {
    id: row.id,
    videoId: row.videoId,
    name: row.name,
    nodeCount: workflow.nodes.length,
    createdAt: row.createdAt
  }
}

/** node key → selected generation id, for the video's CURRENT graph. */
function currentSelections(videoId: string): Record<string, string> {
  const rows = getDb().select().from(nodes).where(eq(nodes.videoId, videoId)).all()
  const out: Record<string, string> = {}
  for (const node of rows) {
    if (node.selectedGenerationId) out[node.key] = node.selectedGenerationId
  }
  return out
}

export function listCheckpoints(videoId: string): CheckpointSummary[] {
  return getDb()
    .select()
    .from(videoCheckpoints)
    .where(eq(videoCheckpoints.videoId, videoId))
    .orderBy(desc(videoCheckpoints.createdAt))
    .all()
    .map(toSummary)
}

export function createCheckpoint(videoId: string, name: string): CheckpointSummary {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A checkpoint needs a name')
  const workflow = graph.exportWorkflow(videoId)
  const row: CheckpointRow = {
    id: randomUUID(),
    videoId,
    name: trimmed,
    workflow,
    snapshot: snapshotGraph(videoId),
    selections: currentSelections(videoId),
    createdAt: Date.now()
  }
  getDb().insert(videoCheckpoints).values(row).run()
  return toSummary(row)
}

export function deleteCheckpoint(checkpointId: string): void {
  getDb().delete(videoCheckpoints).where(eq(videoCheckpoints.id, checkpointId)).run()
}

function getCheckpoint(checkpointId: string): CheckpointRow {
  const row = getDb()
    .select()
    .from(videoCheckpoints)
    .where(eq(videoCheckpoints.id, checkpointId))
    .get()
  if (!row) throw new Error('Checkpoint not found')
  return row
}

/** What restoring this checkpoint would change in the current graph. */
export function diffAgainstCurrent(checkpointId: string): CheckpointDiff & { name: string } {
  const row = getCheckpoint(checkpointId)
  return {
    name: row.name,
    ...diffCheckpoint({
      checkpoint: row.workflow as WorkflowExport,
      current: graph.exportWorkflow(row.videoId),
      checkpointSelections: row.selections,
      currentSelections: currentSelections(row.videoId)
    })
  }
}

/**
 * Restores the graph to the checkpoint as ONE journaled step (rows + the
 * selections they imply), so a single undo brings the user back to where they
 * were. Returns what was restored, including how many selections could not be
 * (their generation was deleted since the capture).
 */
export function restoreCheckpoint(checkpointId: string): {
  nodeCount: number
  edgeCount: number
  selectionsRestored: number
  selectionsMissing: number
} {
  const row = getCheckpoint(checkpointId)
  const snapshot = row.snapshot as GraphSnapshot
  const db = getDb()
  let restored = 0
  let missing = 0

  withGraphHistoryGroup(row.videoId, () => {
    applyGraphSnapshot(row.videoId, snapshot)
    const byKey = new Map(
      db
        .select()
        .from(nodes)
        .where(eq(nodes.videoId, row.videoId))
        .all()
        .map((node) => [node.key, node])
    )
    for (const [key, generationId] of Object.entries(row.selections)) {
      const node = byKey.get(key)
      if (!node) continue
      const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
      if (!gen || gen.status !== 'success') {
        // The output was deleted since the capture: leave the node unselected
        // rather than pointing it at a row that no longer resolves.
        if (node.selectedGenerationId === generationId) {
          graph.setSelectedGeneration(node.id, null)
        }
        missing++
        continue
      }
      graph.setSelectedGeneration(node.id, generationId)
      restored++
    }
  })

  return {
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    selectionsRestored: restored,
    selectionsMissing: missing
  }
}
