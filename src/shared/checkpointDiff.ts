import type { WorkflowExport } from './ipc/contracts'

/**
 * Checkpoint diff (§6.4) — what changed between a named snapshot and the
 * current graph, computed purely so the restore confirm, the `diff_checkpoint`
 * tool and the checkpoint panel all read the same answer.
 *
 * Nodes are matched by their workflow key (stable across export/import, unlike
 * database ids, which a restore regenerates). Only differences a user would
 * call a change are reported — a node dragged to another position is not one.
 */

export type WorkflowNode = WorkflowExport['nodes'][number]

export interface NodeChange {
  key: string
  label: string
  /** Params whose value differs, `prompt` first (it is what people look for). */
  changedParams: string[]
}

export interface CheckpointDiff {
  /** Node keys present now but not in the checkpoint. */
  added: Array<{ key: string; label: string }>
  /** Node keys present in the checkpoint but not now. */
  removed: Array<{ key: string; label: string }>
  /** Nodes present on both sides whose params (prompt included) differ. */
  changed: NodeChange[]
  /** Edges added / removed, rendered as "from → to.input". */
  edgesAdded: string[]
  edgesRemoved: string[]
  /** Node keys whose selected generation differs. */
  selectionChanged: string[]
  /** True when nothing at all differs — restoring would be a no-op. */
  identical: boolean
}

const labelOf = (node: WorkflowNode): string => node.label ?? node.key

/** `from → to.input`, the only human-readable identity an edge has. */
function edgeKey(edge: WorkflowExport['edges'][number]): string {
  return `${edge.from ?? '?'} → ${edge.to ?? '?'}.${edge.input}`
}

/** Params compared as JSON — markers included: they change what a run does. */
function changedParamKeys(before: WorkflowNode, after: WorkflowNode): string[] {
  const keys = new Set([...Object.keys(before.params ?? {}), ...Object.keys(after.params ?? {})])
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(before.params?.[key]) !== JSON.stringify(after.params?.[key])) {
      changed.push(key)
    }
  }
  // The prompt is what the user came to compare — never bury it mid-list.
  return changed.sort((a, b) => (a === 'prompt' ? -1 : b === 'prompt' ? 1 : a.localeCompare(b)))
}

export function diffCheckpoint(args: {
  checkpoint: WorkflowExport
  current: WorkflowExport
  /** node key → selected generation id, on each side. */
  checkpointSelections: Record<string, string>
  currentSelections: Record<string, string>
}): CheckpointDiff {
  const before = new Map(args.checkpoint.nodes.map((n) => [n.key, n]))
  const after = new Map(args.current.nodes.map((n) => [n.key, n]))

  const added = args.current.nodes
    .filter((n) => !before.has(n.key))
    .map((n) => ({ key: n.key, label: labelOf(n) }))
  const removed = args.checkpoint.nodes
    .filter((n) => !after.has(n.key))
    .map((n) => ({ key: n.key, label: labelOf(n) }))

  const changed: NodeChange[] = []
  for (const [key, currentNode] of after) {
    const checkpointNode = before.get(key)
    if (!checkpointNode) continue
    const changedParams = changedParamKeys(checkpointNode, currentNode)
    // A label rename is a change too — surface it under the same entry.
    const renamed = labelOf(checkpointNode) !== labelOf(currentNode)
    if (changedParams.length > 0 || renamed) {
      changed.push({
        key,
        label: labelOf(currentNode),
        changedParams: renamed ? ['label', ...changedParams] : changedParams
      })
    }
  }

  const beforeEdges = new Set(args.checkpoint.edges.map(edgeKey))
  const afterEdges = new Set(args.current.edges.map(edgeKey))
  const edgesAdded = [...afterEdges].filter((e) => !beforeEdges.has(e))
  const edgesRemoved = [...beforeEdges].filter((e) => !afterEdges.has(e))

  const selectionChanged = [
    ...new Set([...Object.keys(args.checkpointSelections), ...Object.keys(args.currentSelections)])
  ]
    .filter((key) => args.checkpointSelections[key] !== args.currentSelections[key])
    // A node that no longer exists on either side is already reported above.
    .filter((key) => before.has(key) && after.has(key))
    .sort()

  return {
    added,
    removed,
    changed,
    edgesAdded,
    edgesRemoved,
    selectionChanged,
    identical:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      edgesAdded.length === 0 &&
      edgesRemoved.length === 0 &&
      selectionChanged.length === 0
  }
}

/** One-line-per-change rendering for the agents and the restore confirm. */
export function formatDiff(diff: CheckpointDiff): string {
  if (diff.identical) return 'No difference with the current graph.'
  const lines: string[] = []
  for (const node of diff.added) lines.push(`+ node "${node.label}"`)
  for (const node of diff.removed) lines.push(`- node "${node.label}"`)
  for (const node of diff.changed) {
    lines.push(`~ node "${node.label}" (${node.changedParams.join(', ')})`)
  }
  for (const edge of diff.edgesAdded) lines.push(`+ edge ${edge}`)
  for (const edge of diff.edgesRemoved) lines.push(`- edge ${edge}`)
  if (diff.selectionChanged.length > 0) {
    lines.push(`~ selected output on ${diff.selectionChanged.join(', ')}`)
  }
  return lines.join('\n')
}
