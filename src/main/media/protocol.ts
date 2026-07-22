import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { protocol } from 'electron'
import { getDb } from '../db/client'
import { assets, generations } from '../db/schema'
import { mimeTypeFor } from './files'

/**
 * media:// protocol — the renderer never sees filesystem paths; it addresses
 * media by owner id and the main process resolves against the database:
 *   media://asset/<assetId>
 *   media://generation/<generationId>/result
 *   media://generation/<generationId>/lastFrame
 *
 * Serves files with Range support: Chromium's <video> element requires byte
 * ranges (metadata probing, seeking) — a plain 200 response plays images but
 * not videos.
 */

export function registerMediaProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        // `standard` is what lets Chromium treat media:// like a real origin —
        // without it, cross-origin media/fetch requests from file:// are
        // rejected outright ("only supported for protocol schemes").
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

interface ResolvedMedia {
  path: string
  /** Explicit Content-Type when the DB knows better than the file extension. */
  mime: string | null
}

/**
 * Resolves a media:// URL to its file on disk — for main-process consumers
 * (MP4 render) that need the path itself, not a served response. Returns null
 * for non-media:// URLs (remote http(s) media stays a URL).
 */
export function resolveMediaUrlToFile(url: string): ResolvedMedia | null {
  if (!url.startsWith('media://')) return null
  try {
    return resolveMedia(new URL(url))
  } catch {
    return null
  }
}

function resolveMedia(url: URL): ResolvedMedia | null {
  // For media://asset/<id>, URL parses host="asset" and pathname="/<id>".
  const kind = url.host
  const segments = url.pathname.split('/').filter(Boolean)
  const id = segments[0]
  if (!id) return null

  if (kind === 'asset') {
    const row = getDb().select().from(assets).where(eq(assets.id, id)).get()
    return row?.filePath ? { path: row.filePath, mime: null } : null
  }
  if (kind === 'generation') {
    const row = getDb().select().from(generations).where(eq(generations.id, id)).get()
    if (!row) return null
    if (segments[1] === 'lastFrame') {
      return row.lastFramePath ? { path: row.lastFramePath, mime: null } : null
    }
    if (!row.resultPath) return null
    // Prefer the mime recorded at download time: the extension can be .bin
    // when kie's Content-Type header was missing/unknown, and Chromium will
    // not decode a <video> served as application/octet-stream.
    const mime = /^(video|audio|image)\//.test(row.resultMimeType ?? '') ? row.resultMimeType : null
    return { path: row.resultPath, mime }
  }
  return null
}

function fileResponse(media: ResolvedMedia, request: Request): Response {
  const filePath = media.path
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': media.mime ?? mimeTypeFor(filePath) ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // CORS headers so <canvas> reads (last-frame extraction) aren't tainted
    // and fetch() callers (FCPXML export) can read range metadata.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
  }

  const rangeHeader = request.headers.get('range')
  const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null
  if (match && (match[1] || match[2])) {
    // "bytes=A-B" | "bytes=A-" (from A to EOF) | "bytes=-N" (LAST N bytes).
    const start = match[1]
      ? Number.parseInt(match[1], 10)
      : Math.max(0, size - Number.parseInt(match[2] as string, 10))
    const end = Math.min(match[1] && match[2] ? Number.parseInt(match[2], 10) : size - 1, size - 1)
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` }
      })
    }
    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end })
    ) as unknown as ReadableStream
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1)
      }
    })
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream
  return new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) }
  })
}

export function registerMediaProtocolHandler(): void {
  protocol.handle('media', (request) => {
    // CORS preflight (fetch() with a Range header triggers one).
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Range'
        }
      })
    }
    const media = resolveMedia(new URL(request.url))
    if (!media) return new Response('not found', { status: 404 })
    return fileResponse(media, request)
  })
}
