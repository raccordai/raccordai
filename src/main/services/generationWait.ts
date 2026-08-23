import { onGenerationSettled } from '../bus'
import { getGeneration, listGenerationsForNode } from './generations'

/**
 * wait_for_generations (§4.10) — the long-poll completion path for EXTERNAL
 * agents. The embedded assistant is woken by the bus automatically; an MCP
 * client has no such channel and would otherwise poll get_generations in a
 * loop. This service blocks on the same `generationSettled` bus event until
 * every target settles or the timeout elapses (returned, never thrown).
 *
 * Dependencies are injected so the waiting logic stays unit-testable without
 * a database or timers wired to the real engine.
 */

/** The slice of a generation row the wait logic needs. */
export interface WaitRow {
  id: string
  nodeId: string
  status: string
  errorMessage: string | null
  qcVerdict: string | null
  qcNotes: string | null
}

export interface WaitDeps {
  getGeneration(id: string): WaitRow | null
  listGenerationsForNode(nodeId: string): WaitRow[]
  /** Subscribe to settle events; returns the unsubscribe. */
  onSettled(listener: (event: { generationId: string }) => void): () => void
  /** Injectable timer for tests (defaults to the real setTimeout). */
  setTimer?(handler: () => void, ms: number): NodeJS.Timeout
}

export function isSettled(status: string): boolean {
  return status === 'success' || status === 'failed'
}

/** Bounds of timeout_sec — long enough for a queued clip, short of forever. */
export const WAIT_TIMEOUT_DEFAULT_SEC = 120
export const WAIT_TIMEOUT_MAX_SEC = 600

export function clampWaitTimeoutSec(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return WAIT_TIMEOUT_DEFAULT_SEC
  return Math.min(WAIT_TIMEOUT_MAX_SEC, Math.max(1, raw))
}

/**
 * Resolves the wait set: explicit generation ids (unknown ids throw — a typo
 * must not wait 2 minutes for nothing) plus, per node, its generations that
 * are still in flight. Deduped by id; a node with nothing in flight simply
 * contributes nothing.
 */
export function resolveWaitTargets(
  input: { generationIds?: string[]; nodeIds?: string[] },
  deps: Pick<WaitDeps, 'getGeneration' | 'listGenerationsForNode'>
): WaitRow[] {
  const byId = new Map<string, WaitRow>()
  for (const id of input.generationIds ?? []) {
    const row = deps.getGeneration(id)
    if (!row) throw new Error(`Unknown generation: ${id}`)
    byId.set(row.id, row)
  }
  for (const nodeId of input.nodeIds ?? []) {
    for (const row of deps.listGenerationsForNode(nodeId)) {
      if (!isSettled(row.status)) byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

export interface WaitResult {
  timedOut: boolean
  generations: Array<{
    id: string
    nodeId: string
    status: string
    error: string | null
    qcVerdict: string | null
    qcNotes: string | null
  }>
  /** Ids still in flight when the timeout hit (empty when timedOut is false). */
  stillPending: string[]
}

const toReport = (row: WaitRow): WaitResult['generations'][number] => ({
  id: row.id,
  nodeId: row.nodeId,
  status: row.status,
  error: row.errorMessage,
  qcVerdict: row.qcVerdict,
  qcNotes: row.qcNotes
})

export async function waitForGenerations(
  input: { generationIds?: string[]; nodeIds?: string[]; timeoutSec?: number },
  deps: WaitDeps = {
    getGeneration: (id) => getGeneration(id),
    listGenerationsForNode: (nodeId) => listGenerationsForNode(nodeId),
    onSettled: onGenerationSettled
  }
): Promise<WaitResult> {
  const targets = resolveWaitTargets(input, deps)
  if (targets.length === 0) {
    return { timedOut: false, generations: [], stillPending: [] }
  }
  const pending = new Set(targets.filter((row) => !isSettled(row.status)).map((row) => row.id))

  if (pending.size > 0) {
    const setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        resolve()
      }
      const unsubscribe = deps.onSettled((event) => {
        pending.delete(event.generationId)
        if (pending.size === 0) finish()
      })
      const timer = setTimer(finish, clampWaitTimeoutSec(input.timeoutSec) * 1000)
      // Re-check AFTER subscribing: a generation that settled between the
      // resolve above and the subscription would otherwise wait out the timer.
      for (const id of [...pending]) {
        const row = deps.getGeneration(id)
        if (row && isSettled(row.status)) pending.delete(id)
      }
      if (pending.size === 0) finish()
    })
  }

  // Fresh rows for the report — statuses moved while we waited.
  const finalRows = targets.map((row) => deps.getGeneration(row.id) ?? row)
  return {
    timedOut: pending.size > 0,
    generations: finalRows.map(toReport),
    stillPending: [...pending]
  }
}
