/**
 * Asset search semantics, shared by the renderer (instant filtering of the
 * already-loaded library) and the main process (MCP `search_assets` tool) so
 * both sides match the same things.
 */

export interface SearchableAsset {
  name: string
  key: string
  description: string | null
  tags: string[]
  /** Subject of a published design sheet — searchable so "Léa" finds her sheet. */
  designSubject?: string | null
}

/** Lowercase + strip accents, so "foret" matches "Forêt". */
function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Deduplicated, trimmed, lowercase tags — the canonical stored form. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => normalize(t.trim())).filter((t) => t !== ''))]
}

/**
 * Every whitespace-separated term must match somewhere in the text (AND
 * semantics), accent- and case-insensitive. An empty query matches everything.
 * Used for the project/video library search bars.
 */
export function nameMatchesQuery(text: string, query: string): boolean {
  const haystack = normalize(text)
  return normalize(query)
    .split(/\s+/)
    .filter((term) => term !== '')
    .every((term) => haystack.includes(term))
}

/** Same semantics over an asset's name, key, description, tags and design subject. */
export function assetMatchesQuery(asset: SearchableAsset, query: string): boolean {
  return nameMatchesQuery(
    [
      asset.name,
      asset.key,
      asset.description ?? '',
      asset.tags.join(' '),
      asset.designSubject ?? ''
    ].join(' '),
    query
  )
}
