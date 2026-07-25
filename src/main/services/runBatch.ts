import { getModel } from '@shared/models'
import { onGenerationSettled } from '../bus'
import * as generations from './generations'
import * as graph from './graph'
import { notifyBatchSummary } from './notifications'
import { planRun, type PlanEntry } from './runPlanner'
import { runNode } from './runEngine'

/**
 * Dependency-aware batch runs (§4.10 phase 4) — the main-process home of what
 * used to be renderer orchestration. Decisions are runPlanner.ts (pure,
 * unit-tested); this module is the I/O half (E2E scope, like runEngine): it
 * claims generations through the engine and sequences on the in-main
 * `generationSettled` bus event — the poller's completion path — instead of
 * the renderer's historical 2 s polling loop.
 */

/** Renderer-side cap kept as a safety net: no generation takes longer. */
const SETTLE_TIMEOUT_MS = 10 * 60 * 1000

export interface PlannedRow {
  nodeId: string
  label: string
  credits: number | null
}

export interface BatchResult {
  succeeded: number
  failed: number
  /** nodeId → generationId for every node that claimed one during the batch. */
  generations: Record<string, string>
}

/** Node ids whose SELECTED generation is a success (cost-modal parity). */
function satisfiedNodeIds(nodes: { id: string; selectedGenerationId?: string | null }[]): string[] {
  return nodes
    .filter(
      (n) =>
        n.selectedGenerationId &&
        generations.getGeneration(n.selectedGenerationId)?.status === 'success'
    )
    .map((n) => n.id)
}

function buildPlan(videoId: string, targetNodeIds: string[], reuseTargets: boolean) {
  const { nodes, edges } = graph.listGraph(videoId)
  return planRun({
    nodes,
    edges,
    targetNodeIds,
    reuseTargets,
    satisfiedNodeIds: satisfiedNodeIds(nodes)
  })
}

/** Every video-model node of the graph — the "generate all videos" target set. */
export function videoNodeTargets(videoId: string): string[] {
  return graph
    .listGraph(videoId)
    .nodes.filter((n) => getModel(n.modelId)?.kind === 'video')
    .map((n) => n.id)
}

/** The §4.4 cost modal's data: nodes that will claim a generation + estimates. */
export function planBatch(
  videoId: string,
  targetNodeIds: string[],
  reuseTargets: boolean
): { rows: PlannedRow[]; total: number } {
  const rows = buildPlan(videoId, targetNodeIds, reuseTargets).planned.map((entry) => ({
    nodeId: entry.id,
    label: entry.label,
    credits: generations.estimateNodeRunCredits(entry.id)
  }))
  return { rows, total: rows.reduce((sum, row) => sum + (row.credits ?? 0), 0) }
}

/** Resolves on terminal status: row check first (settle may predate the wait). */
function waitForSettle(generationId: string): Promise<'success' | 'failed'> {
  const current = generations.getGeneration(generationId)?.status
  if (current === 'success' || current === 'failed') return Promise.resolve(current)
  return new Promise((resolve) => {
    const finish = (status: 'success' | 'failed'): void => {
      unsubscribe()
      clearInterval(recheck)
      clearTimeout(cap)
      resolve(status)
    }
    const unsubscribe = onGenerationSettled((event) => {
      if (event.generationId === generationId) finish(event.status)
    })
    // Safety net: re-read the row in case a settle slipped by (e.g. smart
    // retry rewrote the generation while we subscribed).
    const recheck = setInterval(() => {
      const status = generations.getGeneration(generationId)?.status
      if (status === 'success' || status === 'failed') finish(status)
    }, 15_000)
    const cap = setTimeout(() => finish('failed'), SETTLE_TIMEOUT_MS)
  })
}

/**
 * Start a dependency-aware batch. Returns the planned rows immediately plus a
 * `done` promise for callers that want to await completion (the IPC handler
 * does; the chat tool instead watches generations as `onGenerationStarted`
 * reports them and lets the settle wake-up drain the batch).
 */
export function startBatch(args: {
  videoId: string
  targetNodeIds: string[]
  reuseTargets: boolean
  /** §6.1 finalize: bypass the draft substitution for every run of this batch. */
  forceFinal?: boolean
  /** §6.1 finalize: promote each successful generation to the node's selection
   *  as it settles, so dependents (and the timeline) consume the final output. */
  selectOnSettle?: boolean
  onGenerationStarted?: (nodeId: string, generationId: string) => void
}): { planned: PlannedRow[]; done: Promise<BatchResult> } {
  const plan = buildPlan(args.videoId, args.targetNodeIds, args.reuseTargets)
  const entries = new Map<string, PlanEntry>(plan.order.map((entry) => [entry.id, entry]))
  const startedGenerations: Record<string, string> = {}

  // Memoised per-node run: awaits the node's direct parents (in parallel),
  // then claims its generation once and waits for it to settle. Memoising is
  // what makes a shared upstream generate a single time across consumers;
  // running parents via Promise.all is what parallelises independent branches.
  const promises = new Map<string, Promise<void>>()
  const runWithDeps = (id: string): Promise<void> => {
    const existing = promises.get(id)
    if (existing) return existing
    const entry = entries.get(id)
    const p = (async () => {
      if (!entry) return
      await Promise.all(entry.parents.map(runWithDeps))
      if (!entry.run) return
      const { generationId } = await runNode(id, entry.reuse, { forceFinal: args.forceFinal })
      startedGenerations[id] = generationId
      args.onGenerationStarted?.(id, generationId)
      const status = await waitForSettle(generationId)
      if (status !== 'success') {
        throw new Error(`Node "${entry.label}" did not complete successfully — stopping.`)
      }
      // Before dependents resolve their inputs (they read the selection).
      if (args.selectOnSettle) graph.setSelectedGeneration(id, generationId)
    })()
    promises.set(id, p)
    return p
  }

  // One failing branch is surfaced but doesn't abort the others.
  const done = (async () => {
    let failed = 0
    await Promise.all(
      args.targetNodeIds.map((id) =>
        runWithDeps(id).catch((err) => {
          failed++
          console.error('[runBatch]', err instanceof Error ? err.message : String(err))
        })
      )
    )
    if (args.targetNodeIds.length >= 2) {
      notifyBatchSummary(args.targetNodeIds.length - failed, failed)
    }
    return {
      succeeded: args.targetNodeIds.length - failed,
      failed,
      generations: startedGenerations
    }
  })()

  return {
    planned: plan.planned.map((entry) => ({
      nodeId: entry.id,
      label: entry.label,
      credits: generations.estimateNodeRunCredits(entry.id)
    })),
    done
  }
}

// ── §6.1 finalize — re-run draft keepers on the real models ──────────────────

export interface FinalizeRow {
  nodeId: string
  label: string
  /** Estimate stamped on the draft generation when it was claimed. */
  draftCredits: number | null
  /** Estimate of the same run on the real model (substitution bypassed). */
  finalCredits: number | null
}

/** Nodes whose SELECTED generation is a successful draft, draft-vs-final cost. */
export function planFinalize(videoId: string): {
  rows: FinalizeRow[]
  totalDraft: number
  totalFinal: number
} {
  const { nodes } = graph.listGraph(videoId)
  const rows: FinalizeRow[] = []
  for (const node of nodes) {
    if (!node.selectedGenerationId) continue
    const gen = generations.getGeneration(node.selectedGenerationId)
    if (!gen || gen.status !== 'success' || !gen.draft) continue
    rows.push({
      nodeId: node.id,
      label: node.label ?? node.key,
      draftCredits: gen.creditsEstimated,
      finalCredits: generations.estimateNodeRunCredits(node.id, { forceFinal: true })
    })
  }
  return {
    rows,
    totalDraft: rows.reduce((sum, r) => sum + (r.draftCredits ?? 0), 0),
    totalFinal: rows.reduce((sum, r) => sum + (r.finalCredits ?? 0), 0)
  }
}

/**
 * Re-runs every draft-selected node on the real models (draft substitution
 * bypassed) and promotes each successful result to the node's selection.
 * Draft mode itself stays on — exploration can continue after finalizing.
 */
export function finalizeVideo(
  videoId: string,
  onGenerationStarted?: (nodeId: string, generationId: string) => void
): { planned: PlannedRow[]; done: Promise<BatchResult> } {
  const targetNodeIds = planFinalize(videoId).rows.map((row) => row.nodeId)
  if (targetNodeIds.length === 0) {
    return { planned: [], done: Promise.resolve({ succeeded: 0, failed: 0, generations: {} }) }
  }
  return startBatch({
    videoId,
    targetNodeIds,
    reuseTargets: false,
    forceFinal: true,
    selectOnSettle: true,
    onGenerationStarted
  })
}
