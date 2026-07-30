import { describe, expect, it } from 'vitest'
import { createDeduper, normalizeErrorMessage } from './errorReporter'

describe('normalizeErrorMessage', () => {
  it('extracts the message of an Error', () => {
    expect(normalizeErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('passes strings through and serializes objects', () => {
    expect(normalizeErrorMessage('raw')).toBe('raw')
    expect(normalizeErrorMessage({ code: 42 })).toBe('{"code":42}')
  })

  it('falls back to String() on unserializable values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(normalizeErrorMessage(cyclic)).toBe('[object Object]')
  })
})

describe('createDeduper', () => {
  it('suppresses a repeated key inside the window and readmits it after', () => {
    const fresh = createDeduper(1000)
    expect(fresh('a', 0)).toBe(true)
    expect(fresh('a', 500)).toBe(false)
    expect(fresh('b', 500)).toBe(true)
    expect(fresh('a', 1500)).toBe(true)
  })

  it('prunes stale entries so the map stays bounded', () => {
    const fresh = createDeduper(10)
    for (let i = 0; i < 150; i++) fresh(`key-${i}`, i)
    // Old keys were pruned along the way — re-reporting one is allowed again.
    expect(fresh('key-0', 1000)).toBe(true)
  })
})
