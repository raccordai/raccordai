import type { Edge, Node } from '@xyflow/react'
import {
  autoLayoutPositions as layout,
  resolveOverlaps as pushApart,
  type LayoutDirection,
  type LayoutNode,
  type LayoutResult
} from '@shared/graphLayout'

/**
 * React Flow adapter over the shared layout (`src/shared/graphLayout.ts`).
 * The algorithm lives in shared so the main process can lay out graphs that
 * arrive without positions (assistant / MCP import_workflow); this file only
 * translates React Flow's node shape into the structural one.
 */

export type { LayoutDirection }

/** React Flow node → structural layout node (label/key/createdAt live in `data.node`). */
function toLayoutNode(n: Node): LayoutNode {
  const doc = (
    n.data as { node?: { label?: unknown; key?: unknown; createdAt?: unknown } } | undefined
  )?.node
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    measured: n.measured,
    label: typeof doc?.label === 'string' ? doc.label : undefined,
    key: typeof doc?.key === 'string' ? doc.key : undefined,
    createdAt: typeof doc?.createdAt === 'number' ? doc.createdAt : undefined
  }
}

export function autoLayoutPositions(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'LR'
): LayoutResult[] {
  return layout(
    nodes.map(toLayoutNode),
    edges.map((e) => ({ source: e.source, target: e.target })),
    direction
  )
}

export function resolveOverlaps(
  nodes: Node[],
  seedIds: string[],
  frozenIds: ReadonlySet<string> = new Set()
): LayoutResult[] {
  return pushApart(nodes.map(toLayoutNode), seedIds, frozenIds)
}
