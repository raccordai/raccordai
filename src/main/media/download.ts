import { createWriteStream, rmSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Streaming download into a local file — the historical paths buffered whole
 * results in RAM (`arrayBuffer()` + `writeFileSync`), which froze the main
 * process (pollers, IPC, media://) for the duration of a multi-hundred-MB
 * clip. Bytes now flow chunk-by-chunk to disk under a hard byte cap, and only
 * http(s) URLs are fetched — file:// and custom schemes must never reach a
 * generic downloader (they would read arbitrary local files).
 */

/** Hard per-file ceiling — far above any legitimate generation result. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

/** Rejects anything a generic downloader must not fetch (non-http(s), garbage). */
export function assertDownloadableUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Refusing to download malformed URL "${url}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to download non-http(s) URL "${url}"`)
  }
  return parsed
}

/**
 * Streams `url` into a file. `target` is a path, or a function of the
 * response Content-Type — callers that name files by MIME get the header
 * before any byte lands, without a second request; a throw from the callback
 * (unsupported media type) aborts before anything is written. On any failure
 * the partial file is removed.
 */
export async function downloadToFile(
  url: string,
  target: string | ((contentType: string | null) => string),
  opts: { maxBytes?: number; headers?: Record<string, string> } = {}
): Promise<{ path: string; contentType: string | null; bytes: number }> {
  assertDownloadableUrl(url)
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES
  // `headers` carries a provider's auth for hosts that gate their results
  // (a remote generation server); public CDNs get a bare request.
  const res = await fetch(url, opts.headers ? { headers: opts.headers } : undefined)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const contentType = res.headers.get('content-type')
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`download exceeds the ${maxBytes}-byte limit (${declared} bytes declared)`)
  }
  const body = res.body
  if (!body) throw new Error('download failed: empty response body')

  let path: string
  try {
    path = typeof target === 'function' ? target(contentType) : target
  } catch (err) {
    await body.cancel().catch(() => undefined)
    throw err
  }

  let bytes = 0
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) done(new Error(`download exceeds the ${maxBytes}-byte limit`))
      else done(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream), cap, createWriteStream(path))
  } catch (err) {
    rmSync(path, { force: true })
    throw err
  }
  return { path, contentType, bytes }
}
