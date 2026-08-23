import { describe, expect, it } from 'vitest'
import {
  clampWaitTimeoutSec,
  isSettled,
  resolveWaitTargets,
  waitForGenerations,
  WAIT_TIMEOUT_DEFAULT_SEC,
  WAIT_TIMEOUT_MAX_SEC,
  type WaitDeps,
  type WaitRow
} from './generationWait'

const row = (overrides: Partial<WaitRow> & Pick<WaitRow, 'id'>): WaitRow => ({
  nodeId: 'n1',
  status: 'running',
  errorMessage: null,
  qcVerdict: null,
  qcNotes: null,
  ...overrides
})

/** In-memory deps: a mutable row map plus a hand-fired settle bus. */
function fakeDeps(rows: WaitRow[]): WaitDeps & {
  rowsById: Map<string, WaitRow>
  settle(id: string, status: string): void
  fireTimeout(): void
} {
  const rowsById = new Map(rows.map((r) => [r.id, r]))
  const listeners: Array<(event: { generationId: string }) => void> = []
  let timeoutHandler: (() => void) | null = null
  return {
    rowsById,
    getGeneration: (id) => rowsById.get(id) ?? null,
    listGenerationsForNode: (nodeId) => [...rowsById.values()].filter((r) => r.nodeId === nodeId),
    onSettled: (listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    setTimer: (handler) => {
      timeoutHandler = handler
      // A real (never-firing in test time) handle so clearTimeout works.
      return setTimeout(() => {}, 1_000_000)
    },
    settle: (id, status) => {
      const existing = rowsById.get(id)
      if (existing) rowsById.set(id, { ...existing, status })
      for (const listener of [...listeners]) listener({ generationId: id })
    },
    fireTimeout: () => timeoutHandler?.()
  }
}

describe('isSettled / clampWaitTimeoutSec', () => {
  it('settles on success and failed only', () => {
    expect(isSettled('success')).toBe(true)
    expect(isSettled('failed')).toBe(true)
    expect(isSettled('pending')).toBe(false)
    expect(isSettled('running')).toBe(false)
  })

  it('clamps the timeout into [1, max] and defaults it', () => {
    expect(clampWaitTimeoutSec(undefined)).toBe(WAIT_TIMEOUT_DEFAULT_SEC)
    expect(clampWaitTimeoutSec(Number.NaN)).toBe(WAIT_TIMEOUT_DEFAULT_SEC)
    expect(clampWaitTimeoutSec(0)).toBe(1)
    expect(clampWaitTimeoutSec(30)).toBe(30)
    expect(clampWaitTimeoutSec(10_000)).toBe(WAIT_TIMEOUT_MAX_SEC)
  })
})

describe('resolveWaitTargets', () => {
  it('throws on an unknown generation id', () => {
    const deps = fakeDeps([])
    expect(() => resolveWaitTargets({ generationIds: ['nope'] }, deps)).toThrow(
      'Unknown generation: nope'
    )
  })

  it('dedupes explicit ids against node-derived in-flight rows', () => {
    const deps = fakeDeps([
      row({ id: 'g1', nodeId: 'n1', status: 'running' }),
      row({ id: 'g2', nodeId: 'n1', status: 'success' }),
      row({ id: 'g3', nodeId: 'n2', status: 'pending' })
    ])
    const targets = resolveWaitTargets({ generationIds: ['g1'], nodeIds: ['n1', 'n2'] }, deps)
    // g2 is settled: the node contributes in-flight generations only.
    expect(targets.map((t) => t.id).sort()).toEqual(['g1', 'g3'])
  })
})

describe('waitForGenerations', () => {
  it('reports immediately when every target is already settled', async () => {
    const deps = fakeDeps([row({ id: 'g1', status: 'success' })])
    const result = await waitForGenerations({ generationIds: ['g1'] }, deps)
    expect(result).toEqual({
      timedOut: false,
      generations: [
        { id: 'g1', nodeId: 'n1', status: 'success', error: null, qcVerdict: null, qcNotes: null }
      ],
      stillPending: []
    })
  })

  it('returns an empty report when nothing matched (node with nothing in flight)', async () => {
    const deps = fakeDeps([row({ id: 'g1', nodeId: 'n1', status: 'success' })])
    const result = await waitForGenerations({ nodeIds: ['n1'] }, deps)
    expect(result).toEqual({ timedOut: false, generations: [], stillPending: [] })
  })

  it('resolves when the settle event lands, with fresh statuses', async () => {
    const deps = fakeDeps([
      row({ id: 'g1', status: 'running' }),
      row({ id: 'g2', status: 'running' })
    ])
    const promise = waitForGenerations({ generationIds: ['g1', 'g2'] }, deps)
    deps.settle('g1', 'success')
    deps.settle('g2', 'failed')
    const result = await promise
    expect(result.timedOut).toBe(false)
    expect(result.stillPending).toEqual([])
    expect(result.generations.map((g) => [g.id, g.status])).toEqual([
      ['g1', 'success'],
      ['g2', 'failed']
    ])
  })

  it('catches a generation that settled between resolve and subscribe', async () => {
    const deps = fakeDeps([row({ id: 'g1', status: 'running' })])
    // Mutate the row directly — no event will ever fire for it.
    deps.rowsById.set('g1', row({ id: 'g1', status: 'success' }))
    const result = await waitForGenerations({ generationIds: ['g1'] }, deps)
    expect(result.timedOut).toBe(false)
    expect(result.generations[0]).toMatchObject({ id: 'g1', status: 'success' })
  })

  it('times out into a partial report instead of throwing', async () => {
    const deps = fakeDeps([
      row({ id: 'g1', status: 'running' }),
      row({ id: 'g2', status: 'running' })
    ])
    const promise = waitForGenerations({ generationIds: ['g1', 'g2'], timeoutSec: 5 }, deps)
    deps.settle('g1', 'success')
    deps.fireTimeout()
    const result = await promise
    expect(result.timedOut).toBe(true)
    expect(result.stillPending).toEqual(['g2'])
    expect(result.generations.map((g) => [g.id, g.status])).toEqual([
      ['g1', 'success'],
      ['g2', 'running']
    ])
  })
})
