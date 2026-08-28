import { describe, expect, it } from 'vitest'
import { createMoveThrottle, normalizeEvent, toBase64Chunks } from './demoJournal'

describe('normalizeEvent', () => {
  it('normalizes pointer coords to the window and clamps out-of-frame samples', () => {
    expect(normalizeEvent('click', 2, 320, 180, 1280, 720)).toEqual({
      t: 2,
      type: 'click',
      x: 0.25,
      y: 0.25
    })
    expect(normalizeEvent('move', 1, -50, 9000, 1280, 720)).toEqual({
      t: 1,
      type: 'move',
      x: 0,
      y: 1
    })
    // A negative timestamp (sample raced the recorder start) clamps to 0.
    expect(normalizeEvent('scroll', -0.2, 640, 360, 1280, 720).t).toBe(0)
  })

  it('key events carry neither coordinates nor a key value (the redaction rule)', () => {
    expect(normalizeEvent('key', 3.5, 640, 360, 1280, 720)).toEqual({ t: 3.5, type: 'key' })
  })

  it('degrades to a positionless event when the window size is unusable', () => {
    expect(normalizeEvent('click', 1, 10, 10, 0, 0)).toEqual({ t: 1, type: 'click' })
  })
})

describe('createMoveThrottle', () => {
  it('keeps at most one move per window, always the newest', () => {
    const throttle = createMoveThrottle(0.1)
    const at = (t: number) => ({ t, type: 'move' as const, x: 0.5, y: 0.5 })
    expect(throttle(at(0))).not.toBeNull()
    expect(throttle(at(0.05))).toBeNull()
    expect(throttle(at(0.09))).toBeNull()
    expect(throttle(at(0.11))?.t).toBe(0.11)
    expect(throttle(at(0.15))).toBeNull()
  })
})

describe('toBase64Chunks', () => {
  const decode = (chunks: string[]): Uint8Array => {
    // Main decodes each chunk independently and concatenates — mirror that.
    const parts = chunks.map((c) => Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)))
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  it('round-trips bytes through independently-decodable chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256)
    const chunks = toBase64Chunks(bytes, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    // Every cut lands on a 4-char base64 boundary so per-chunk decode works.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length % 4).toBe(0)
    expect(decode(chunks)).toEqual(bytes)
  })

  it('floors an unaligned max to the previous 4-char boundary', () => {
    const bytes = new Uint8Array(3000).fill(7)
    expect(decode(toBase64Chunks(bytes, 1001))).toEqual(bytes)
  })

  it('handles empty and sub-chunk inputs', () => {
    expect(toBase64Chunks(new Uint8Array(0))).toEqual([])
    const tiny = new Uint8Array([1, 2, 3])
    expect(decode(toBase64Chunks(tiny))).toEqual(tiny)
  })
})
