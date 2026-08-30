import { mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logWarn } from './logger'
import { pickCacheEvictions, type CacheFileStat } from './renderPlan'

/**
 * Incremental render cache — the content-addressed store of per-clip encode
 * artifacts (normalized segments, demo-camera bakes). Re-rendering a film
 * after changing one clip used to re-encode every clip from scratch; with the
 * cache, an artifact whose key (source identity + full ffmpeg argv — see
 * renderCacheKey in renderPlan.ts) is unchanged is reused as-is.
 *
 * Layout: userData/render-cache/<sha256>.mp4, plus <sha256>.<pid>-<n>.partial.mp4
 * staging files (encode target, atomically renamed on success — a crash never
 * leaves a truncated artifact under a final name). Eviction is size-capped,
 * oldest-first, and skips anything touched within the last hour: a lookup
 * freshens the artifact's mtime, so a concurrent render can't lose a file it
 * is reading. Decisions are pure in renderPlan.ts; this module owns the files.
 */

/** Size cap — enough for several multi-minute films' worth of segments. */
export const RENDER_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** Stale staging files (a crashed/cancelled encode) are swept after this. */
const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000

const ARTIFACT_RE = /^[0-9a-f]{64}\.mp4$/
const PARTIAL_RE = /\.partial\.mp4$/

export function renderCacheDir(): string {
  return join(app.getPath('userData'), 'render-cache')
}

function artifactPath(key: string): string {
  return join(renderCacheDir(), `${key}.mp4`)
}

/**
 * Existing artifact for `key`, freshened (mtime bump = LRU signal + eviction
 * protection); null on a miss or an unreadable/empty file.
 */
export function lookupCachedArtifact(key: string): string | null {
  const path = artifactPath(key)
  try {
    if (statSync(path).size <= 0) return null
    const now = new Date()
    utimesSync(path, now, now)
    return path
  } catch {
    return null
  }
}

let stagingCounter = 0

/**
 * Unique encode target for `key` — inside the cache dir so the commit rename
 * is atomic (same filesystem), unique so two renders producing the same key
 * concurrently never write the same file. Ends in .mp4: ffmpeg infers the
 * container from the extension.
 */
export function stageCachedArtifact(key: string): string {
  mkdirSync(renderCacheDir(), { recursive: true })
  stagingCounter += 1
  return join(renderCacheDir(), `${key}.${process.pid}-${stagingCounter}.partial.mp4`)
}

/** Promotes a finished staging file to the final artifact name. */
export function commitCachedArtifact(stagingPath: string, key: string): string {
  const final = artifactPath(key)
  renameSync(stagingPath, final)
  return final
}

/**
 * Bounds the cache (called at render start, fenced by the caller): sweeps
 * stale staging files, then deletes oldest-first artifacts over the cap.
 * Returns how many files were removed.
 */
export function evictRenderCache(maxBytes = RENDER_CACHE_MAX_BYTES, nowMs = Date.now()): number {
  const dir = renderCacheDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0 // no cache yet
  }
  let removed = 0
  const artifacts: CacheFileStat[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (PARTIAL_RE.test(name)) {
        if (nowMs - stat.mtimeMs > STALE_PARTIAL_MS) {
          rmSync(path, { force: true })
          removed += 1
        }
      } else if (ARTIFACT_RE.test(name)) {
        artifacts.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    } catch (err) {
      logWarn('render-cache', `could not stat ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  for (const path of pickCacheEvictions(artifacts, maxBytes, nowMs)) {
    rmSync(path, { force: true })
    removed += 1
  }
  return removed
}
