/**
 * Smart-run planning (§4.10 phase 4) — ALL the decisions of a dependency-aware
 * run, extracted pure from the historical renderer orchestration so the cost
 * modal, the batch engine and the agents share one source of truth. Unit-
 * tested and in coverage.include; the I/O half (claiming generations, waiting
 * on settles) lives in runBatch.ts.
 *
 * Rules (identical to the §4.4 cost-modal maths):
 *  - the planned set is the upstream closure of the targets, minus asset nodes;
 *  - dependencies always reuse a satisfied output; explicit targets reuse only
 *    in batch mode (`reuseTargets`) — a direct click always regenerates;
 *  - a node that reuses and is already satisfied is skipped (claims no new
 *    generation) but its ancestors remain in the walk: any of them lacking an
 *    output still runs (historical parity with the renderer orchestration);
 *  - variants ×N (§6.6) multiply the EXPLICIT TARGETS only: dependencies are
 *    shared context, generating them twice would just cost credits.
 */

import { MAX_VARIANTS } from '@shared/config'

/** Variant count coerced into [1, MAX_VARIANTS] (non-numbers → 1). */
export function clampVariants(variants: unknown): number {
  const n = Math.floor(Number(variants))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, MAX_VARIANTS)
}

export interface PlannerNode {
  id: string
  modelId: string
  label: string | null
  key: string
}

export interface PlannerEdge {
  sourceNodeId: string
  targetNodeId: string
}

export interface PlanEntry {
  id: string
  /** Display label (node label, falling back to its key). */
  label: string
  /** True when this node will claim a NEW generation. */
  run: boolean
  /** How many generations it claims: 0 when it doesn't run, N on a variants target. */
  runs: number
  /** `reuseSatisfied` flag to pass to the engine when running. */
  reuse: boolean
  /** Direct parents inside the walked set — the nodes to await before running. */
  parents: string[]
}

export interface RunPlan {
  /** Every walked node in topological (dependency-first) order. */
  order: PlanEntry[]
  /** The subset that claims a new generation, same order. */
  planned: PlanEntry[]
}

export function planRun(args: {
  nodes: PlannerNode[]
  edges: PlannerEdge[]
  targetNodeIds: string[]
  /** Batch mode: targets with a satisfied output are skipped, not re-run. */
  reuseTargets: boolean
  /** Ids whose selected generation is already a success. */
  satisfiedNodeIds: Iterable<string>
  /** §6.6 — parallel candidates claimed per explicit target (default 1). */
  variants?: number
}): RunPlan {
  const variants = clampVariants(args.variants ?? 1)
  const nodesById = new Map(args.nodes.map((n) => [n.id, n]))
  const satisfied = new Set(args.satisfiedNodeIds)
  const targets = new Set(args.targetNodeIds)
  const incoming = new Map<string, string[]>()
  for (const edge of args.edges) {
    const arr = incoming.get(edge.targetNodeId) ?? []
    arr.push(edge.sourceNodeId)
    incoming.set(edge.targetNodeId, arr)
  }

  // Upstream closure of the targets, in dependency-first (topological) order:
  // a node is emitted after every parent it drags in. The recursion also
  // tolerates cycles (a malformed graph must not hang the planner).
  const order: PlanEntry[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    if (state.get(id) === 'done' || state.get(id) === 'visiting') return
    const node = nodesById.get(id)
    if (!node) return
    state.set(id, 'visiting')
    const parents = [...new Set(incoming.get(id) ?? [])].filter((p) => nodesById.has(p))
    for (const parent of parents) visit(parent)
    state.set(id, 'done')

    const isAsset = node.modelId === 'studio/asset'
    const reuse = !targets.has(id) || args.reuseTargets
    const run = !isAsset && !(reuse && satisfied.has(id))
    order.push({
      id,
      label: node.label ?? node.key,
      run,
      runs: run ? (targets.has(id) ? variants : 1) : 0,
      reuse,
      parents
    })
  }
  for (const id of args.targetNodeIds) visit(id)

  return { order, planned: order.filter((entry) => entry.run) }
}
