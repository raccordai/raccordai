import {
  clampBlockDepth,
  extractSerpVideos,
  normalizeSearchParam,
  serpTaskError,
  serpTaskItems,
  type SerpVideoItem
} from '@shared/niches'
import { logInfo } from './logger'
import { getDataForSeoLogin, getDataForSeoPassword } from './settings'

/**
 * DataForSEO client — scrapes the real YouTube SERP (identical to what a user
 * would see, native sp filters included), which the official API cannot do.
 * All response interpretation is pure in `@shared/niches`; this file only
 * holds the HTTP call. Billed per block of 20 results on DataForSEO's side.
 */

const BASE = process.env['RACCORD_DATAFORSEO_BASE'] ?? 'https://api.dataforseo.com'

function authHeader(): string {
  const login = getDataForSeoLogin()
  const password = getDataForSeoPassword()
  if (!login || !password) {
    throw new Error(
      'DataForSEO credentials are not configured. Add them in Settings → Integrations.'
    )
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`
}

export interface SerpSearchInput {
  keyword: string
  locationCode: number
  languageCode: string
  depth: number
  /** Raw / encoded sp value or a full YouTube URL — normalized here. */
  searchParam?: string | null
}

export async function searchYoutubeSerp(input: SerpSearchInput): Promise<SerpVideoItem[]> {
  const blockDepth = clampBlockDepth(input.depth)
  const task: Record<string, unknown> = {
    keyword: input.keyword,
    location_code: input.locationCode,
    language_code: input.languageCode,
    block_depth: blockDepth
  }
  const sp = normalizeSearchParam(input.searchParam)
  if (sp) task.search_param = sp

  logInfo('dataforseo', `SERP "${input.keyword}" depth=${blockDepth} sp=${sp ?? 'none'}`)
  const response = await fetch(`${BASE}/v3/serp/youtube/organic/live/advanced`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify([task])
  })
  if (!response.ok) {
    throw new Error(`DataForSEO request failed (HTTP ${response.status}).`)
  }
  const body: unknown = await response.json()
  const taskError = serpTaskError(body)
  if (taskError) throw new Error(taskError)
  return extractSerpVideos(serpTaskItems(body))
}
