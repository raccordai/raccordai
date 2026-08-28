import { describe, expect, it } from 'vitest'
import { toBase64Chunks } from './demoJournal'

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
