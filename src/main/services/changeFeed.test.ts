import { beforeEach, describe, expect, it } from 'vitest'
import { clearChangeFeed, getChanges, recordChange } from './changeFeed'

let t = 0
const now = (): number => ++t

beforeEach(() => {
  clearChangeFeed()
  t = 0
})

describe('change feed', () => {
  it('subscribes from now and returns only newer events', () => {
    recordChange('workflow', { videoId: 'v1' }, now)
    const sub = getChanges()
    expect(sub.gapped).toBe(false)
    expect(sub.events.map((e) => e.type)).toEqual(['workflow'])

    const cursor = sub.latestSeq
    recordChange('generations', { videoId: 'v1', nodeId: 'n1' }, now)
    recordChange('credits', {}, now)
    const next = getChanges(cursor)
    expect(next.gapped).toBe(false)
    expect(next.events.map((e) => e.type)).toEqual(['generations', 'credits'])
    expect(next.events[0]).toMatchObject({ videoId: 'v1', nodeId: 'n1' })
    // Fully caught up.
    expect(getChanges(next.latestSeq).events).toEqual([])
  })

  it('coalesces repeated identical events into the tail entry', () => {
    recordChange('queue', {}, now)
    recordChange('queue', {}, now)
    recordChange('queue', {}, now)
    const { events, latestSeq } = getChanges()
    expect(events).toHaveLength(1)
    // The tail keeps the LATEST seq, so a cursor taken before the last burst
    // still re-sees the entry.
    expect(events[0]!.seq).toBe(latestSeq)
    recordChange('workflow', { videoId: 'v1' }, now)
    recordChange('queue', {}, now)
    expect(getChanges().events.map((e) => e.type)).toEqual(['queue', 'workflow', 'queue'])
  })

  it('reports a gap when the cursor predates the buffer', () => {
    for (let i = 0; i < 1005; i++) recordChange('workflow', { videoId: `v${i}` }, now)
    const result = getChanges(1)
    expect(result.gapped).toBe(true)
    // A fresh subscription is never a gap.
    expect(getChanges().gapped).toBe(false)
  })

  it('caps the number of returned events', () => {
    for (let i = 0; i < 10; i++) recordChange('workflow', { videoId: `v${i}` }, now)
    expect(getChanges(0, 3).events).toHaveLength(3)
  })
})
