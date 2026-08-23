import { or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import {
  assets,
  castings,
  feedbackItems,
  nicheRoadmapItems,
  nicheVideos,
  nodes,
  projects,
  videos,
  voicePersonas
} from '../db/schema'

/**
 * Cross-app search (§4.10) — "where did I use Léa?" without O(n) get_workflow
 * calls. Plain SQLite LIKE (case-insensitive for ASCII), grouped by type,
 * capped per group: right-sized for a local single-user library, no FTS
 * migration involved. Accents are not folded — search the accented form.
 */

export type SearchHitType =
  | 'project'
  | 'video'
  | 'node'
  | 'asset'
  | 'casting'
  | 'feedback'
  | 'roadmap_item'
  | 'niche_video'
  | 'voice_persona'

export const SEARCH_HIT_TYPES: SearchHitType[] = [
  'project',
  'video',
  'node',
  'asset',
  'casting',
  'feedback',
  'roadmap_item',
  'niche_video',
  'voice_persona'
]

export interface SearchHit {
  type: SearchHitType
  id: string
  /** What to show for the row (name, label, title…). */
  title: string
  /** ±60 chars around the first match in the matched text field, when any. */
  snippet: string | null
  projectId?: string
  videoId?: string
  nicheId?: string
}

/** Compact context window around the first case-insensitive match. */
export function buildSnippet(text: string, query: string, radius = 60): string | null {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return null
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

/** Escapes LIKE wildcards in the user's query (paired with ESCAPE '\\'). */
const likePattern = (query: string): string => `%${query.replace(/([%_\\])/g, '\\$1')}%`

export function searchAll(
  query: string,
  opts: { types?: SearchHitType[]; limitPerType?: number } = {}
): { query: string; hits: SearchHit[] } {
  const q = query.trim()
  if (q.length < 2) throw new Error('Search needs at least 2 characters.')
  const db = getDb()
  const pattern = likePattern(q)
  const limit = Math.min(50, Math.max(1, opts.limitPerType ?? 10))
  const wanted = new Set(opts.types?.length ? opts.types : SEARCH_HIT_TYPES)
  const hits: SearchHit[] = []
  // Explicit ESCAPE so a query containing % or _ matches literally.
  const matches = (column: unknown): SQL => sql`${column} LIKE ${pattern} ESCAPE '\\'`
  const first = (...texts: Array<string | null | undefined>): string | null => {
    for (const text of texts) {
      if (!text) continue
      const snippet = buildSnippet(text, q)
      if (snippet) return snippet
    }
    return null
  }

  if (wanted.has('project')) {
    for (const row of db.select().from(projects).where(matches(projects.name)).limit(limit).all()) {
      hits.push({ type: 'project', id: row.id, title: row.name, snippet: null })
    }
  }
  if (wanted.has('video')) {
    for (const row of db.select().from(videos).where(matches(videos.name)).limit(limit).all()) {
      hits.push({
        type: 'video',
        id: row.id,
        title: row.name,
        snippet: null,
        projectId: row.projectId
      })
    }
  }
  if (wanted.has('node')) {
    // params is a JSON column: LIKE over its serialized text reaches the
    // prompt (and any fragment) without a per-key schema.
    const rows = db
      .select()
      .from(nodes)
      .where(or(matches(nodes.label), matches(nodes.params)))
      .limit(limit)
      .all()
    for (const row of rows) {
      const prompt = (row.params as { prompt?: unknown } | null)?.prompt
      hits.push({
        type: 'node',
        id: row.id,
        title: row.label ?? row.key,
        snippet: first(
          typeof prompt === 'string' ? prompt : null,
          JSON.stringify(row.params ?? {})
        ),
        videoId: row.videoId
      })
    }
  }
  if (wanted.has('asset')) {
    const rows = db
      .select()
      .from(assets)
      .where(or(matches(assets.name), matches(assets.description), matches(assets.designSubject)))
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'asset',
        id: row.id,
        title: row.name,
        snippet: first(row.description, row.designSubject),
        projectId: row.projectId
      })
    }
  }
  if (wanted.has('casting')) {
    const rows = db
      .select()
      .from(castings)
      .where(or(matches(castings.name), matches(castings.notes)))
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'casting',
        id: row.id,
        title: row.name,
        snippet: first(row.notes),
        projectId: row.projectId
      })
    }
  }
  if (wanted.has('feedback')) {
    const rows = db
      .select()
      .from(feedbackItems)
      .where(matches(feedbackItems.comment))
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'feedback',
        id: row.id,
        title: row.nodeLabel ?? 'Feedback',
        snippet: first(row.comment),
        videoId: row.videoId
      })
    }
  }
  if (wanted.has('roadmap_item')) {
    const rows = db
      .select()
      .from(nicheRoadmapItems)
      .where(
        or(
          matches(nicheRoadmapItems.title),
          matches(nicheRoadmapItems.angle),
          matches(nicheRoadmapItems.description)
        )
      )
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'roadmap_item',
        id: row.id,
        title: row.title,
        snippet: first(row.angle, row.description),
        nicheId: row.nicheId
      })
    }
  }
  if (wanted.has('niche_video')) {
    const rows = db
      .select()
      .from(nicheVideos)
      .where(or(matches(nicheVideos.title), matches(nicheVideos.transcript)))
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'niche_video',
        id: row.id,
        title: row.title,
        snippet: first(row.transcript),
        nicheId: row.nicheId
      })
    }
  }
  if (wanted.has('voice_persona')) {
    const rows = db
      .select()
      .from(voicePersonas)
      .where(or(matches(voicePersonas.name), matches(voicePersonas.description)))
      .limit(limit)
      .all()
    for (const row of rows) {
      hits.push({
        type: 'voice_persona',
        id: row.id,
        title: row.name,
        snippet: first(row.description)
      })
    }
  }
  return { query: q, hits }
}
