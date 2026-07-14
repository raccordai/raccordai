import { createContext, useContext } from 'react'
import type { GraphEdge, GraphNode } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const WorkflowGraphContext = createContext<WorkflowGraph | null>(null)

export function useWorkflowGraph(): WorkflowGraph {
  const ctx = useContext(WorkflowGraphContext)
  if (!ctx) throw new Error('useWorkflowGraph must be used inside <WorkflowGraphContext.Provider>')
  return ctx
}

export interface IncomingConnection {
  edge: GraphEdge
  source: GraphNode | undefined
  /** 1-based index of this connection within its target handle (drives @ alias numbering). */
  index: number
  /** Resolved alias label, e.g. "@Image1" — undefined if the handle has no `referenceAlias`. */
  alias: string | undefined
}

/**
 * Builds the ordered list of incoming connections for a node, attaching a 1-based
 * index per target handle. The order matches what the generation runtime uses to build
 * @-aliases (edges are sorted by createdAt), so `@Image2` in the prompt always maps
 * to the same source as the badge shown in the UI.
 */
export function incomingConnectionsFor(nodeId: string, graph: WorkflowGraph): IncomingConnection[] {
  const sortedEdges = graph.edges
    .filter((e) => e.targetNodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt)

  const targetNode = graph.nodes.find((n) => n.id === nodeId)
  const model = targetNode ? getModel(targetNode.modelId) : undefined
  const handleByKey = new Map((model?.inputs ?? []).map((h) => [h.key, h]))

  const counters = new Map<string, number>()
  const out: IncomingConnection[] = []
  for (const edge of sortedEdges) {
    const next = (counters.get(edge.targetHandle) ?? 0) + 1
    counters.set(edge.targetHandle, next)
    const handle = handleByKey.get(edge.targetHandle)
    const alias = handle?.referenceAlias ? `${handle.referenceAlias}${next}` : undefined
    out.push({
      edge,
      source: graph.nodes.find((n) => n.id === edge.sourceNodeId),
      index: next,
      alias
    })
  }
  return out
}
