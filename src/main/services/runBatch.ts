import { getModel } from '@shared/models'
import type { PlannedRow } from '@shared/ipc/contracts'
import { onGenerationSettled } from '../bus'
import { maxSettleMs } from './genQueue'
import * as generations from './generations'
import * as graph from './graph'
import { lintNodeById } from './lint'
import { logError } from './logger'
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

/** Safety-net cap, sized to the worst legitimate lifetime (video poll budget
 *  with smart retries) so a still-running generation is never declared failed.
 *  The bus event and the row recheck below are the real completion paths. */
const SETTLE_TIMEOUT_MS = maxSettleMs('video')

/** Run-confirm row — the shared contract shape, so IPC validation can't drift. */
export type { PlannedRow }

export interface BatchResult {
  succeeded: number
  failed: number
  /** nodeId → generationId for every node that claimed one during the batch
   *  (the first candidate when the node ran with variants). */
  generations: Record<string, string>
}

/** Node ids whose SELECTED generation is a success (run-confirm parity). */
function satisfiedNodeIds(nodes: { id: string; selectedGenerationId?: string | null }[]): string[] {
  return nodes
    .filter(
      (n) =>
        n.selectedGenerationId &&
        generations.getGeneration(n.selectedGenerationId)?.status === 'success'
    )
    .map((n) => n.id)
}

function buildPlan(
  videoId: string,
  targetNodeIds: string[],
  reuseTargets: boolean,
  variants?: number
) {
  const { nodes, edges } = graph.listGraph(videoId)
  return planRun({
    nodes,
    edges,
    targetNodeIds,
    reuseTargets,
    satisfiedNodeIds: satisfiedNodeIds(nodes),
    variants
  })
}

/** Run-confirm row for one planned node: the candidates it claims + its lint. */
function plannedRow(entry: PlanEntry): PlannedRow {
  return {
    nodeId: entry.id,
    label: entry.label,
    variants: entry.runs,
    // §6.5 — the run confirm is the last free moment to catch a bad prompt.
    lint: lintNodeById(entry.id).map((f) => ({
      rule: f.rule,
      severity: f.severity,
      message: f.message
    }))
  }
}

/** Every video-model node of the graph — the "generate all videos" target set. */
export function videoNodeTargets(videoId: string): string[] {
  return graph
    .listGraph(videoId)
    .nodes.filter((n) => getModel(n.modelId)?.kind === 'video')
    .map((n) => n.id)
}

/** The §4.4 run confirm's data: nodes that will claim a generation + their lint. */
export function planBatch(
  videoId: string,
  targetNodeIds: string[],
  reuseTargets: boolean,
  variants?: number
): { rows: PlannedRow[] } {
  const rows = buildPlan(videoId, targetNodeIds, reuseTargets, variants).planned.map(plannedRow)
  return { rows }
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
    // retry rewrote the generation while we subscribed). A vanished row is a
    // failure — the generation was deleted out from under the batch.
    const recheck = setInterval(() => {
      const gen = generations.getGeneration(generationId)
      if (!gen) finish('failed')
      else if (gen.status === 'success' || gen.status === 'failed') finish(gen.status)
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
  /** §6.6 — parallel candidates per explicit target (deps always run once). */
  variants?: number
  onGenerationStarted?: (nodeId: string, generationId: string) => void
}): { planned: PlannedRow[]; done: Promise<BatchResult> } {
  const plan = buildPlan(args.videoId, args.targetNodeIds, args.reuseTargets, args.variants)
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
      const { generationId, generationIds } = await runNode(id, entry.reuse, {
        forceFinal: args.forceFinal,
        variants: entry.runs
      })
      startedGenerations[id] = generationId
      for (const gid of generationIds) args.onGenerationStarted?.(id, gid)
      // With variants (§6.6) the node is satisfied as soon as ONE candidate
      // lands: the others are alternatives the user arbitrates, and dependents
      // consume the node's selection (the first success auto-selects).
      const statuses = await Promise.all(generationIds.map(waitForSettle))
      const winner = generationIds.find((_, i) => statuses[i] === 'success')
      if (!winner) {
        throw new Error(`Node "${entry.label}" did not complete successfully — stopping.`)
      }
      // Before dependents resolve their inputs (they read the selection).
      if (args.selectOnSettle) graph.setSelectedGeneration(id, winner)
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
          logError('runBatch', `run failed for node ${id}`, err)
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

  return { planned: plan.planned.map(plannedRow), done }
}

// ── §6.1 finalize — re-run draft keepers on the real models ──────────────────

export interface FinalizeRow {
  nodeId: string
  label: string
}

/** Nodes whose SELECTED generation is a successful draft — what finalize re-runs. */
export function planFinalize(videoId: string): { rows: FinalizeRow[] } {
  const { nodes } = graph.listGraph(videoId)
  const rows: FinalizeRow[] = []
  for (const node of nodes) {
    if (!node.selectedGenerationId) continue
    const gen = generations.getGeneration(node.selectedGenerationId)
    if (!gen || gen.status !== 'success' || !gen.draft) continue
    rows.push({ nodeId: node.id, label: node.label ?? node.key })
  }
  return { rows }
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
