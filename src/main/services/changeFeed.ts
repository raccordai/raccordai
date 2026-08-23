/**
 * Change feed for external agents (get_changes) — the MCP counterpart of the
 * renderer's push events: every main→renderer broadcast also lands here as a
 * sequenced entry, so an agent can resync with "what changed since seq N"
 * instead of re-reading whole workflows. In-memory ring buffer, per app run
 * (like the undo stacks): a cursor older than the buffer reports `gapped` and
 * the agent does one full re-read.
 */

export type ChangeType =
  'workflow' | 'generations' | 'queue' | 'credits' | 'render-progress' | 'niches' | 'voice-personas'

export interface ChangeEvent {
  seq: number
  /** Epoch ms. */
  at: number
  type: ChangeType
  videoId?: string
  nodeId?: string
}

const MAX_EVENTS = 1000

const events: ChangeEvent[] = []
let nextSeq = 1

export function recordChange(
  type: ChangeType,
  payload: { videoId?: string; nodeId?: string } = {},
  now: () => number = Date.now
): void {
  const last = events.at(-1)
  // Coalesce bursts: the same type+ids landing repeatedly (poll ticks, queue
  // churn) refreshes the tail entry instead of flooding the buffer.
  if (
    last &&
    last.type === type &&
    last.videoId === payload.videoId &&
    last.nodeId === payload.nodeId
  ) {
    last.seq = nextSeq++
    last.at = now()
    return
  }
  events.push({
    seq: nextSeq++,
    at: now(),
    type,
    ...(payload.videoId !== undefined ? { videoId: payload.videoId } : {}),
    ...(payload.nodeId !== undefined ? { nodeId: payload.nodeId } : {})
  })
  if (events.length > MAX_EVENTS) events.shift()
}

export function getChanges(
  since?: number,
  limit = 200
): {
  /** Pass this back as `since` on the next call. */
  latestSeq: number
  /** True when `since` predates the buffer — do a full re-read instead. */
  gapped: boolean
  events: ChangeEvent[]
} {
  const cap = Math.min(500, Math.max(1, limit))
  const cursor = since ?? 0
  const oldest = events[0]?.seq ?? nextSeq
  // A fresh cursor (0/undefined) is a subscription point, never a gap.
  const gapped = cursor > 0 && cursor < oldest - 1
  const fresh = events.filter((e) => e.seq > cursor).slice(0, cap)
  return { latestSeq: nextSeq - 1, gapped, events: fresh }
}

/** Test hook — the buffer is per app run, like the undo stacks. */
export function clearChangeFeed(): void {
  events.length = 0
  nextSeq = 1
}
