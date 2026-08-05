import {
  batchIds,
  parseChannelListResponse,
  parsePlaylistItemsResponse,
  parseVideoListResponse,
  parseYoutubeSuggestResponse,
  type ChannelStats,
  type PlaylistVideoRef,
  type VideoMeta
} from '@shared/niches'
import { getYoutubeApiKey } from './settings'

/**
 * YouTube Data API v3 client — the cheap enrichment side of the niche
 * pipeline: channels.list / videos.list / playlistItems.list all cost 1 quota
 * unit per call and accept 50 ids, versus 100 units for a single search.list.
 * Response parsing is pure in `@shared/niches`; a QuotaCounter accumulates
 * the units each request spent so callers can report usage.
 */

const BASE = process.env['RACCORD_YOUTUBE_API_BASE'] ?? 'https://www.googleapis.com/youtube/v3'

export interface QuotaCounter {
  units: number
}

function apiKey(): string {
  const key = getYoutubeApiKey()
  if (!key) {
    throw new Error('YouTube API key is not configured. Add it in Settings → Integrations.')
  }
  return key
}

async function ytGet(
  path: string,
  params: Record<string, string>,
  quota: QuotaCounter
): Promise<unknown> {
  const search = new URLSearchParams({ ...params, key: apiKey() })
  const response = await fetch(`${BASE}/${path}?${search.toString()}`)
  quota.units += 1
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('YouTube API refused the request (invalid key or quota exhausted).')
    }
    throw new Error(`YouTube API request failed (HTTP ${response.status}).`)
  }
  return response.json()
}

export async function fetchChannelsByIds(
  ids: readonly string[],
  quota: QuotaCounter
): Promise<ChannelStats[]> {
  const out: ChannelStats[] = []
  for (const batch of batchIds(ids)) {
    const body = await ytGet(
      'channels',
      { part: 'snippet,statistics,contentDetails', id: batch.join(','), maxResults: '50' },
      quota
    )
    out.push(...parseChannelListResponse(body))
  }
  return out
}

export async function fetchChannelByHandle(
  handle: string,
  quota: QuotaCounter
): Promise<ChannelStats | null> {
  const body = await ytGet(
    'channels',
    { part: 'snippet,statistics,contentDetails', forHandle: handle },
    quota
  )
  return parseChannelListResponse(body)[0] ?? null
}

export async function fetchVideosMeta(
  ids: readonly string[],
  quota: QuotaCounter
): Promise<VideoMeta[]> {
  const out: VideoMeta[] = []
  for (const batch of batchIds(ids)) {
    const body = await ytGet(
      'videos',
      {
        part: 'snippet,contentDetails,status,statistics',
        id: batch.join(','),
        maxResults: '50'
      },
      quota
    )
    out.push(...parseVideoListResponse(body))
  }
  return out
}

/** Latest uploads of a channel via its auto-generated uploads playlist. */
export async function fetchUploads(
  playlistId: string,
  maxVideos: number,
  quota: QuotaCounter
): Promise<PlaylistVideoRef[]> {
  const out: PlaylistVideoRef[] = []
  let pageToken: string | null = null
  while (out.length < maxVideos) {
    const params: Record<string, string> = {
      part: 'contentDetails',
      playlistId,
      maxResults: String(Math.min(50, maxVideos - out.length))
    }
    if (pageToken) params.pageToken = pageToken
    const body = await ytGet('playlistItems', params, quota)
    const page = parsePlaylistItemsResponse(body)
    out.push(...page.videos)
    if (!page.nextPageToken || page.videos.length === 0) break
    pageToken = page.nextPageToken
  }
  return out.slice(0, maxVideos)
}

/**
 * YouTube search autocomplete — the real "what people type" demand signal.
 * Free and keyless (suggestqueries endpoint, no quota); the keyword-discovery
 * step that decides which paid DataForSEO searches are worth launching.
 */
export async function fetchSearchSuggestions(
  query: string,
  languageCode: string
): Promise<string[]> {
  const url = new URL('https://suggestqueries-clients6.youtube.com/complete/search')
  url.searchParams.set('client', 'youtube')
  url.searchParams.set('ds', 'yt')
  url.searchParams.set('hl', languageCode)
  url.searchParams.set('q', query)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`YouTube suggest request failed (HTTP ${response.status}).`)
  }
  return parseYoutubeSuggestResponse(await response.text())
}
