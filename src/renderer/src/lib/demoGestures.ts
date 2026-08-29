/**
 * Gesture engine (§9) — the decision-shaped part of UI target resolution,
 * kept pure so it is unit-testable: given the harvested candidates (visible
 * interactive elements) and a query, pick the one the gesture aims at. The
 * DOM harvest and the event dispatch live in features/demo/demoGestureEngine.
 *
 * Scoring: exact title > title contains > exact text > text contains >
 * placeholder contains (case- and accent-insensitive) — `title` first because
 * it is the codebase's stable handle (icon buttons, and the node picker's
 * model entries carry their MODEL ID as title, locale-proof). Ties break on
 * the smallest rect (the deepest, most specific element), then DOM order.
 */

export interface GestureCandidate {
  /** Trimmed visible text content (empty for icon-only buttons). */
  text: string
  title: string
  placeholder: string
  /** Bounding-rect area in px² — tie-breaker (smallest wins). */
  area: number
  /** DOM order index — final tie-breaker (first wins). */
  index: number
}

/** Lowercase, accents folded, whitespace collapsed — both sides of a match. */
export function normalizeQuery(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}

const SCORES = {
  titleExact: 500,
  titleContains: 400,
  textExact: 300,
  textContains: 200,
  placeholderContains: 100
} as const

function scoreOf(candidate: GestureCandidate, query: string): number {
  const title = normalizeQuery(candidate.title)
  const text = normalizeQuery(candidate.text)
  const placeholder = normalizeQuery(candidate.placeholder)
  if (title === query) return SCORES.titleExact
  if (title.includes(query) && query.length > 0) return SCORES.titleContains
  if (text === query) return SCORES.textExact
  if (text.includes(query) && query.length > 0) return SCORES.textContains
  if (placeholder.includes(query) && query.length > 0) return SCORES.placeholderContains
  return 0
}

/** The candidate the gesture aims at, or null when nothing matches. */
export function pickGestureTarget<T extends GestureCandidate>(
  candidates: T[],
  rawQuery: string
): T | null {
  const query = normalizeQuery(rawQuery)
  if (!query) return null
  let best: T | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = scoreOf(candidate, query)
    if (score === 0) continue
    if (best === null || score > bestScore) {
      best = candidate
      bestScore = score
      continue
    }
    // Same score: the smallest rect (deepest element) wins, then DOM order.
    if (
      score === bestScore &&
      (candidate.area < best.area || (candidate.area === best.area && candidate.index < best.index))
    ) {
      best = candidate
    }
  }
  return best
}
