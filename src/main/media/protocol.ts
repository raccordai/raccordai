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

function resolveMediaPath(url: URL): string | null {
  // For media://asset/<id>, URL parses host="asset" and pathname="/<id>".
  const kind = url.host
  const segments = url.pathname.split('/').filter(Boolean)
  const id = segments[0]
  if (!id) return null

  if (kind === 'asset') {
    const row = getDb().select().from(assets).where(eq(assets.id, id)).get()
    return row?.filePath ?? null
  }
  if (kind === 'generation') {
    const row = getDb().select().from(generations).where(eq(generations.id, id)).get()
    if (!row) return null
    return (segments[1] === 'lastFrame' ? row.lastFramePath : row.resultPath) ?? null
  }
  return null
}

function fileResponse(filePath: string, request: Request): Response {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': mimeTypeFor(filePath) ?? 'application/octet-stream',
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
    const filePath = resolveMediaPath(new URL(request.url))
    if (!filePath) return new Response('not found', { status: 404 })
    return fileResponse(filePath, request)
  })
}
