import { fetchMediaBlob } from './mediaProxy'

/**
 * Downloads a media URL to the user's machine with a meaningful filename:
 * `<slugified-name>-<yyyymmdd-hhmmss>.<ext>` — so successive downloads never
 * collide on the same generic CDN name.
 *
 * Cross-origin URLs ignore the `<a download>` attribute, so we fetch the bytes
 * and save the blob via an object URL.
 */
export async function downloadMedia(
  url: string,
  opts: {
    /** Human name the file is derived from (node label, asset name…). */
    name: string
    /** Timestamp used in the filename — e.g. the generation's createdAt. Defaults to now. */
    createdAt?: number
    /** Extension used when neither the URL nor the MIME type reveals one. */
    fallbackExt?: string
  }
): Promise<string> {
  const blob = await fetchMediaBlob(url)

  const ext = extensionFor(url, blob.type, opts.fallbackExt ?? 'bin')
  const filename = `${slugify(opts.name)}-${timestamp(opts.createdAt ?? Date.now())}.${ext}`

  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
  return filename
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg'
}

/** Prefer the URL's own extension, then the response MIME type, then the caller's fallback. */
function extensionFor(url: string, mime: string, fallback: string): string {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i)
    if (match?.[1]) return match[1].toLowerCase()
  } catch {
    // not a parseable URL — fall through to MIME
  }
  return EXT_BY_MIME[mime.split(';')[0]?.trim() ?? ''] ?? fallback
}

/** "Wide shot — Café" → "wide-shot-cafe" */
function slugify(s: string): string {
  const slug = s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return slug || 'media'
}

function timestamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
