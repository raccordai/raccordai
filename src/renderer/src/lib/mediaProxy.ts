/**
 * Media byte access, Electron edition.
 *
 * video-studio needed a same-origin Convex `/media` proxy because kie.ai's CDN
 * serves no CORS headers and browsers block cross-origin `fetch()` reads. In
 * Electron the renderer is not subject to those CORS restrictions and there is
 * no Convex proxy, so both helpers collapse to trivial implementations. The
 * signatures are kept identical so callers don't change.
 */

/** No proxying needed in Electron — the URL is returned unchanged. */
export function proxiedMediaUrl(url: string): string {
  return url
}

/** Fetch a media URL's full bytes as a Blob. Throws on a non-OK response. */
export async function fetchMediaBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
  return res.blob()
}
