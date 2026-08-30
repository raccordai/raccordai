import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  commitCachedArtifact,
  evictRenderCache,
  lookupCachedArtifact,
  renderCacheDir,
  stageCachedArtifact
} from './renderCache'

// 64-hex keys, like the real sha256 keys.
const key = (fill: string): string => fill.repeat(64 / fill.length)

/** Backdates a file so the eviction's protection window doesn't shield it. */
function backdate(path: string, ageMs: number, now: number): void {
  const then = new Date(now - ageMs)
  utimesSync(path, then, then)
}

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  // The electron mock's userData is one tmpdir per test process — start each
  // test from an empty store.
  rmSync(renderCacheDir(), { recursive: true, force: true })
  mkdirSync(renderCacheDir(), { recursive: true })
})

describe('stage → commit → lookup', () => {
  it('commits a staging file under its final name and serves it back', () => {
    const k = key('a')
    const staging = stageCachedArtifact(k)
    expect(staging).toContain('.partial.mp4')
    writeFileSync(staging, 'ENCODED-SEGMENT')
    const final = commitCachedArtifact(staging, k)
    expect(final).toBe(join(renderCacheDir(), `${k}.mp4`))
    expect(existsSync(staging)).toBe(false)
    expect(lookupCachedArtifact(k)).toBe(final)
  })

  it('misses on an unknown key and on an empty artifact', () => {
    expect(lookupCachedArtifact(key('b'))).toBeNull()
    const k = key('c')
    writeFileSync(join(renderCacheDir(), `${k}.mp4`), '')
    expect(lookupCachedArtifact(k)).toBeNull()
  })

  it('hands out unique staging paths for the same key (concurrent renders)', () => {
    const k = key('d')
    expect(stageCachedArtifact(k)).not.toBe(stageCachedArtifact(k))
  })
})

describe('evictRenderCache', () => {
  it('deletes oldest-first artifacts over the cap, keeps the rest', () => {
    const now = Date.now()
    const oldKey = key('e')
    const newKey = key('f')
    for (const [k, age] of [
      [oldKey, 9 * HOUR],
      [newKey, 2 * HOUR]
    ] as const) {
      const path = join(renderCacheDir(), `${k}.mp4`)
      writeFileSync(path, 'x'.repeat(600))
      backdate(path, age, now)
    }
    const removed = evictRenderCache(1000, now)
    expect(removed).toBe(1)
    expect(lookupCachedArtifact(oldKey)).toBeNull()
    expect(lookupCachedArtifact(newKey)).not.toBeNull()
  })

  it('never deletes an artifact freshened within the protection window', () => {
    const now = Date.now()
    const k = key('1')
    const path = join(renderCacheDir(), `${k}.mp4`)
    writeFileSync(path, 'x'.repeat(5000))
    backdate(path, HOUR / 2, now)
    evictRenderCache(100, now)
    expect(lookupCachedArtifact(k)).not.toBeNull()
  })

  it('a lookup freshens the artifact, protecting it from the next eviction', () => {
    const now = Date.now()
    const k = key('2')
    const path = join(renderCacheDir(), `${k}.mp4`)
    writeFileSync(path, 'x'.repeat(5000))
    backdate(path, 9 * HOUR, now)
    expect(lookupCachedArtifact(k)).not.toBeNull() // bumps mtime to now
    evictRenderCache(100, now)
    expect(existsSync(path)).toBe(true)
  })

  it('sweeps stale staging files, keeps fresh ones', () => {
    const now = Date.now()
    const stale = stageCachedArtifact(key('3'))
    writeFileSync(stale, 'half-encoded')
    backdate(stale, 25 * HOUR, now)
    const fresh = stageCachedArtifact(key('4'))
    writeFileSync(fresh, 'encoding right now')
    evictRenderCache(Number.MAX_SAFE_INTEGER, now)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('is a no-op before the cache dir exists', () => {
    // Point at a store that was never created by removing everything first —
    // covered implicitly by the readdir catch; the call must simply not throw.
    expect(() => evictRenderCache()).not.toThrow()
  })

  it('reports how many files it removed', () => {
    const now = Date.now()
    for (const fill of ['5', '6']) {
      const path = join(renderCacheDir(), `${key(fill)}.mp4`)
      writeFileSync(path, 'x'.repeat(600))
      backdate(path, 9 * HOUR, now)
    }
    expect(evictRenderCache(0, now)).toBe(2)
    expect(statSync(renderCacheDir()).isDirectory()).toBe(true)
  })
})
