/**
 * YouTube niche research — the pure logic (§7): sp-parameter normalization,
 * DataForSEO SERP extraction, YouTube Data API response parsing, the
 * views/subscribers niche score, the in-memory filter pipeline and the
 * transcript (timedtext) parsing. No network, no Electron — the main
 * services (`dataforseo.ts`, `youtubeApi.ts`, `niches.ts`) orchestrate
 * these over fetch, and every decision that can be wrong lives here,
 * unit-tested.
 */

// ---------------------------------------------------------------------------
// sp parameter (YouTube's native search filters, protobuf-in-base64)
// ---------------------------------------------------------------------------

/**
 * DataForSEO expects the DOUBLY url-encoded form prefixed with `sp=`.
 * Users paste anything: the raw base64, a 1×/2× encoded value, a full
 * youtube.com URL, or a value already prefixed with `sp=`.
 */
export function normalizeSearchParam(input: string | null | undefined): string | undefined {
  if (!input) return undefined
  let value = input.trim()
  if (!value) return undefined
  const fromUrl = value.match(/[?&]sp=([^&\s]+)/)
  if (fromUrl?.[1]) value = fromUrl[1]
  if (value.startsWith('sp=')) value = value.slice(3)
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return `sp=${encodeURIComponent(encodeURIComponent(value))}`
}

export interface SpPreset {
  id: string
  /** Raw (un-encoded) sp value, as copied from a filtered youtube.com URL. */
  raw: string
}

/** Labels live in i18n under `niches.spPresets.<id>`. */
export const SP_PRESETS: readonly SpPreset[] = [
  { id: 'relevance', raw: 'CAASAhAB' },
  { id: 'views', raw: 'CAMSAhAB' },
  { id: 'date', raw: 'CAISAhAB' },
  { id: 'viewsThisYear', raw: 'CAMSBAgFEAE' },
  { id: 'viewsMonthLong', raw: 'CAMSBggCEAEYAg' },
  { id: 'nicheHunt', raw: 'CAMSBggEEAEYBQ' }
] as const

export function spPresetRaw(id: string): string | undefined {
  return SP_PRESETS.find((p) => p.id === id)?.raw
}

export interface DataForSeoLocation {
  code: number
  /** ISO country code, for Intl.DisplayNames labels in the UI. */
  country: string
  defaultLanguage: string
}

/** The DataForSEO location codes the UI offers (their doc has the full list). */
export const DATAFORSEO_LOCATIONS: readonly DataForSeoLocation[] = [
  { code: 2840, country: 'US', defaultLanguage: 'en' },
  { code: 2250, country: 'FR', defaultLanguage: 'fr' },
  { code: 2826, country: 'GB', defaultLanguage: 'en' },
  { code: 2124, country: 'CA', defaultLanguage: 'en' },
  { code: 2724, country: 'ES', defaultLanguage: 'es' },
  { code: 2276, country: 'DE', defaultLanguage: 'de' },
  { code: 2380, country: 'IT', defaultLanguage: 'it' },
  { code: 2076, country: 'BR', defaultLanguage: 'pt' },
  { code: 2484, country: 'MX', defaultLanguage: 'es' },
  { code: 2392, country: 'JP', defaultLanguage: 'ja' }
] as const

export const DEFAULT_LOCATION_CODE = 2840
export const DEFAULT_LANGUAGE_CODE = 'en'

/** DataForSEO bills per block of 20 results — round to the block, bound 20..700. */
export function clampBlockDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 100
  return Math.min(700, Math.max(20, Math.round(depth / 20) * 20))
}

// ---------------------------------------------------------------------------
// DataForSEO SERP extraction
// ---------------------------------------------------------------------------

export interface SerpVideoItem {
  videoId: string
  channelId: string
  channelTitle: string
  channelUrl: string
  title: string
  description: string
  url: string
  thumbnail: string
  publishedAt: string | null
  views: number
  /** SERP position (rank_absolute) — the one thing only a paid scrape knows. */
  rank: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[\s,]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Keep only real video items carrying both ids (the SERP also contains
 * shelves, channels and playlists), with thumbnail/url fallbacks.
 */
export function extractSerpVideos(items: unknown): SerpVideoItem[] {
  if (!Array.isArray(items)) return []
  const out: SerpVideoItem[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    if (!item) continue
    const type = str(item.type)
    if (type !== 'youtube_video' && type !== 'video') continue
    const videoId = str(item.video_id)
    const channelId = str(item.channel_id)
    if (!videoId || !channelId) continue
    out.push({
      videoId,
      channelId,
      channelTitle: str(item.channel_name),
      channelUrl: str(item.channel_url) || `https://www.youtube.com/channel/${channelId}`,
      title: str(item.title),
      description: str(item.description),
      url: str(item.url) || `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: str(item.thumbnail_url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      publishedAt: str(item.publication_date) || str(item.publish_date) || null,
      views: num(item.views_count),
      rank: num(item.rank_absolute) || num(item.rank_group) || null
    })
  }
  return out
}

/**
 * Parse the YouTube autocomplete (suggestqueries) JSONP payload — the real
 * "what people type" demand signal, free. Shape:
 * `window.google.ac.h(["query", [["suggestion", 0, […]], …], …])`.
 */
export function parseYoutubeSuggestResponse(raw: string): string[] {
  const start = raw.indexOf('(')
  const end = raw.lastIndexOf(')')
  if (start === -1 || end <= start) return []
  let body: unknown
  try {
    body = JSON.parse(raw.slice(start + 1, end))
  } catch {
    return []
  }
  if (!Array.isArray(body) || !Array.isArray(body[1])) return []
  const out: string[] = []
  for (const entry of body[1]) {
    const text = Array.isArray(entry) ? entry[0] : entry
    if (typeof text === 'string' && text.trim()) out.push(text.trim())
  }
  return out
}

/** A DataForSEO HTTP 200 can still carry a task-level error. */
export function serpTaskError(body: unknown): string | null {
  const root = asRecord(body)
  const task = asRecord(Array.isArray(root?.tasks) ? root.tasks[0] : null)
  if (!task) return 'DataForSEO: empty response'
  const status = num(task.status_code)
  if (status >= 40000) return str(task.status_message) || `DataForSEO error ${status}`
  return null
}

export function serpTaskItems(body: unknown): unknown {
  const root = asRecord(body)
  const task = asRecord(Array.isArray(root?.tasks) ? root.tasks[0] : null)
  const result = asRecord(Array.isArray(task?.result) ? task.result[0] : null)
  return result?.items
}

/** What the task actually billed (USD) — real money, worth logging every time. */
export function serpTaskCost(body: unknown): number | null {
  const root = asRecord(body)
  const task = asRecord(Array.isArray(root?.tasks) ? root.tasks[0] : null)
  const cost = task?.cost
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null
}

// ---------------------------------------------------------------------------
// YouTube Data API v3 parsing
// ---------------------------------------------------------------------------

/** Hidden subscriber counts use -1 as a sentinel (rendered as "—"). */
export const HIDDEN_SUBSCRIBERS = -1

export interface ChannelStats {
  channelId: string
  title: string
  description: string
  handle: string | null
  url: string
  thumbnail: string
  subscribers: number
  videoCount: number
  viewCount: number
  createdAt: string | null
  /** The channel's auto-generated "uploads" playlist, for cheap listing. */
  uploadsPlaylistId: string | null
}

export function parseChannelListResponse(body: unknown): ChannelStats[] {
  const root = asRecord(body)
  if (!Array.isArray(root?.items)) return []
  const out: ChannelStats[] = []
  for (const raw of root.items) {
    const item = asRecord(raw)
    const channelId = str(item?.id)
    if (!item || !channelId) continue
    const snippet = asRecord(item.snippet)
    const stats = asRecord(item.statistics)
    const thumbnails = asRecord(snippet?.thumbnails)
    const related = asRecord(asRecord(item.contentDetails)?.relatedPlaylists)
    const handle = str(snippet?.customUrl) || null
    out.push({
      channelId,
      title: str(snippet?.title),
      description: str(snippet?.description),
      handle,
      url: handle
        ? `https://www.youtube.com/${handle.startsWith('@') ? handle : `@${handle}`}`
        : `https://www.youtube.com/channel/${channelId}`,
      thumbnail: str(asRecord(thumbnails?.medium)?.url) || str(asRecord(thumbnails?.default)?.url),
      subscribers:
        stats?.hiddenSubscriberCount === true ? HIDDEN_SUBSCRIBERS : num(stats?.subscriberCount),
      videoCount: num(stats?.videoCount),
      viewCount: num(stats?.viewCount),
      createdAt: str(snippet?.publishedAt) || null,
      uploadsPlaylistId: str(related?.uploads) || null
    })
  }
  return out
}

export interface VideoMeta {
  videoId: string
  title: string
  description: string
  publishedAt: string | null
  thumbnail: string
  views: number
  likeCount: number
  commentCount: number
  /** The competitor's explicit SEO (snippet.tags) — empty when undeclared. */
  tags: string[]
  categoryId: string | null
  durationSeconds: number
  madeForKids: boolean
  /** contentDetails.caption — false means a transcript fetch is pointless. */
  hasCaptions: boolean | null
  /** BCP-47 from defaultAudioLanguage/defaultLanguage — often absent. */
  language: string | null
}

const ISO_DURATION = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/

/** ISO 8601 duration (PT1H23M45S) → seconds; 0 when unknown/unparseable. */
export function parseIsoDuration(iso: string | null | undefined): number {
  if (!iso) return 0
  const m = iso.match(ISO_DURATION)
  if (!m) return 0
  const [, d, h, min, s] = m
  return (
    (d ? Number(d) * 86400 : 0) +
    (h ? Number(h) * 3600 : 0) +
    (min ? Number(min) * 60 : 0) +
    (s ? Number(s) : 0)
  )
}

export function parseVideoListResponse(body: unknown): VideoMeta[] {
  const root = asRecord(body)
  if (!Array.isArray(root?.items)) return []
  const out: VideoMeta[] = []
  for (const raw of root.items) {
    const item = asRecord(raw)
    const videoId = str(item?.id)
    if (!item || !videoId) continue
    const snippet = asRecord(item.snippet)
    const content = asRecord(item.contentDetails)
    const status = asRecord(item.status)
    const stats = asRecord(item.statistics)
    const thumbnails = asRecord(snippet?.thumbnails)
    out.push({
      videoId,
      title: str(snippet?.title),
      description: str(snippet?.description),
      publishedAt: str(snippet?.publishedAt) || null,
      thumbnail:
        str(asRecord(thumbnails?.medium)?.url) ||
        str(asRecord(thumbnails?.default)?.url) ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: num(stats?.viewCount),
      likeCount: num(stats?.likeCount),
      commentCount: num(stats?.commentCount),
      tags: Array.isArray(snippet?.tags) ? snippet.tags.filter((t) => typeof t === 'string') : [],
      categoryId: str(snippet?.categoryId) || null,
      durationSeconds: parseIsoDuration(str(content?.duration) || null),
      madeForKids: status?.madeForKids === true || status?.selfDeclaredMadeForKids === true,
      hasCaptions: content?.caption === 'true' ? true : content?.caption === 'false' ? false : null,
      language: str(snippet?.defaultAudioLanguage) || str(snippet?.defaultLanguage) || null
    })
  }
  return out
}

export interface PlaylistVideoRef {
  videoId: string
  publishedAt: string | null
}

/** playlistItems.list response → the referenced video ids, upload order. */
export function parsePlaylistItemsResponse(body: unknown): {
  videos: PlaylistVideoRef[]
  nextPageToken: string | null
} {
  const root = asRecord(body)
  const videos: PlaylistVideoRef[] = []
  if (Array.isArray(root?.items)) {
    for (const raw of root.items) {
      const item = asRecord(raw)
      const content = asRecord(item?.contentDetails)
      const videoId = str(content?.videoId)
      if (!videoId) continue
      videos.push({ videoId, publishedAt: str(content?.videoPublishedAt) || null })
    }
  }
  return { videos, nextPageToken: str(root?.nextPageToken) || null }
}

/** The YouTube API accepts 50 ids per call (1 quota unit per batch). */
export function batchIds(ids: readonly string[], size = 50): string[][] {
  const unique = [...new Set(ids.filter(Boolean))]
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += size) batches.push(unique.slice(i, i + size))
  return batches
}

// ---------------------------------------------------------------------------
// Channel references (what the user pastes to add a channel)
// ---------------------------------------------------------------------------

export type ChannelRef = { kind: 'id'; value: string } | { kind: 'handle'; value: string }

/**
 * Accepts a channel id (UC…), a @handle, or any youtube.com channel URL form
 * (/channel/UC…, /@handle, /c/name, /user/name — the last two resolve as
 * handles, which the API's forHandle lookup usually finds).
 */
export function parseChannelRef(input: string): ChannelRef | null {
  const value = input.trim()
  if (!value) return null
  const url = value.match(
    /youtube\.com\/(?:(channel)\/(UC[\w-]{10,})|(@[\w.-]+)|(?:c|user)\/([\w.-]+))/i
  )
  if (url) {
    if (url[2]) return { kind: 'id', value: url[2] }
    if (url[3]) return { kind: 'handle', value: url[3] }
    if (url[4]) return { kind: 'handle', value: `@${url[4]}` }
    return null
  }
  if (/^UC[\w-]{10,}$/.test(value)) return { kind: 'id', value }
  if (/^@?[\w.-]{3,}$/.test(value)) {
    return { kind: 'handle', value: value.startsWith('@') ? value : `@${value}` }
  }
  return null
}

/**
 * Extract a YouTube video id from whatever the user pastes when marking a
 * roadmap item published: a watch/shorts/youtu.be URL or the bare 11-char id.
 */
export function parseYoutubeVideoUrl(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  const url = value.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i
  )
  if (url?.[1]) return url[1]
  if (/^[\w-]{11}$/.test(value)) return value
  return null
}

/** Roadmap item lifecycle: suggested → assigned to a workflow → live on YouTube. */
export const ROADMAP_STATUSES = ['idea', 'in_production', 'published'] as const
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

export const ROADMAP_VIDEO_TYPES = ['long', 'short'] as const
export type RoadmapVideoType = (typeof ROADMAP_VIDEO_TYPES)[number]

// ---------------------------------------------------------------------------
// Niche score & filter pipeline (in memory, no network)
// ---------------------------------------------------------------------------

export interface NicheScoredVideo {
  videoId: string
  title: string
  description: string
  url: string
  thumbnail: string
  publishedAt: string | null
  views: number
  likeCount: number | null
  commentCount: number | null
  tags: string[]
  categoryId: string | null
  durationSeconds: number
  madeForKids: boolean
  hasCaptions: boolean | null
  /** SERP position when the video came from a keyword search. */
  serpRank: number | null
  channelId: string
  channelTitle: string
  channelUrl: string
  channelThumbnail: string
  channelSubscribers: number
  channelVideoCount: number
  channelViewCount: number
  channelCreatedAt: string | null
  /** BCP-47 audio language when YouTube declares it; null otherwise. */
  language: string | null
}

/**
 * The niche score: views / subscribers. Hidden or zero subscribers with
 * views → Infinity (rendered "∞"); no views → 0.
 */
export function nicheRatio(views: number, subscribers: number): number {
  if (views <= 0) return 0
  if (subscribers <= 0) return Infinity
  return views / subscribers
}

export type RatioSignal = 'strong' | 'interesting' | 'neutral'

export function ratioSignal(ratio: number): RatioSignal {
  if (ratio >= 10) return 'strong'
  if (ratio >= 2) return 'interesting'
  return 'neutral'
}

/**
 * Second outlier lens: views vs the channel's own median (the "7×" badge).
 * Complementary to views/subscribers — the subscriber ratio finds small
 * channels breaking out, this one finds the videos a channel of ANY size
 * overperformed on (insensitive to giant channels). Null when the median is
 * unknown or zero.
 */
export function channelOutlierRatio(views: number, channelMedianViews: number): number | null {
  if (channelMedianViews <= 0) return null
  return views / channelMedianViews
}

/** ≥5× the channel's median = strong outlier; ≥2× = interesting. */
export function channelRatioSignal(ratio: number | null): RatioSignal {
  if (ratio === null) return 'neutral'
  if (ratio >= 5) return 'strong'
  if (ratio >= 2) return 'interesting'
  return 'neutral'
}

const SIGNAL_RANK: Record<RatioSignal, number> = { neutral: 0, interesting: 1, strong: 2 }

/** The strongest of several lenses wins — one ratio alone over/under-flags. */
export function combineSignals(...signals: RatioSignal[]): RatioSignal {
  return signals.reduce((best, s) => (SIGNAL_RANK[s] > SIGNAL_RANK[best] ? s : best), 'neutral')
}

const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000

export function channelAgeMonths(createdAt: string | null, now: Date): number | null {
  if (!createdAt) return null
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return null
  return Math.max(0, (now.getTime() - created) / MS_PER_MONTH)
}

export const SHORT_FORM_MAX_SECONDS = 180

export type NicheFormat = 'all' | 'long' | 'short'
export type NicheSort = 'ratio' | 'views' | 'date'

export interface NicheVideoFilters {
  format: NicheFormat
  maxSubscribers: number | null
  maxChannelAgeMonths: number | null
  minViews: number | null
  madeForKidsOnly: boolean
  sort: NicheSort
  /** BCP-47 primary subtag ('en', 'fr'…); null = any language. */
  language: string | null
}

/** Small young channel + long-form + ratio sort = the niche detector. */
export const DEFAULT_NICHE_FILTERS: NicheVideoFilters = {
  format: 'long',
  maxSubscribers: 100_000,
  maxChannelAgeMonths: 12,
  minViews: null,
  madeForKidsOnly: false,
  sort: 'ratio',
  language: null
}

/** Languages the language filter offers (Latin-script + the SERP locations'). */
export const NICHE_FILTER_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'ja'] as const

/** Latin-script languages, where a non-Latin title is a reliable exclusion signal. */
const LATIN_SCRIPT_LANGUAGES = new Set(['en', 'fr', 'es', 'de', 'it', 'pt'])

function primaryLanguage(code: string): string {
  return (code.split('-')[0] ?? code).toLowerCase()
}

/**
 * Best-effort language match. YouTube's declared audio language wins when
 * present; without it, a Latin-script filter falls back to the title's
 * script (a mostly-Devanagari title is not an English video — the classic
 * "US search full of Hindi content" case). Unknown stays included: the
 * SERP already biased relevance toward the requested language.
 */
export function matchesLanguageFilter(
  language: string,
  video: Pick<NicheScoredVideo, 'language' | 'title'>
): boolean {
  const wanted = primaryLanguage(language)
  if (video.language) return primaryLanguage(video.language) === wanted
  if (!LATIN_SCRIPT_LANGUAGES.has(wanted)) return true
  const letters = (video.title.match(/\p{L}/gu) ?? []).length
  if (letters === 0) return true
  const latin = (video.title.match(/\p{Script=Latin}/gu) ?? []).length
  return (letters - latin) / letters < 0.3
}

function compareDesc(a: number, b: number): number {
  if (a === b) return 0
  return a < b ? 1 : -1
}

export function filterNicheVideos(
  videos: readonly NicheScoredVideo[],
  filters: NicheVideoFilters,
  now: Date
): NicheScoredVideo[] {
  const seen = new Set<string>()
  const kept = videos.filter((v) => {
    if (seen.has(v.videoId)) return false
    seen.add(v.videoId)
    if (
      filters.format === 'long' &&
      v.durationSeconds > 0 &&
      v.durationSeconds < SHORT_FORM_MAX_SECONDS
    )
      return false
    if (
      filters.format === 'short' &&
      (v.durationSeconds <= 0 || v.durationSeconds >= SHORT_FORM_MAX_SECONDS)
    )
      return false
    if (
      filters.maxSubscribers !== null &&
      v.channelSubscribers > filters.maxSubscribers &&
      v.channelSubscribers !== HIDDEN_SUBSCRIBERS
    )
      return false
    if (filters.maxChannelAgeMonths !== null) {
      const age = channelAgeMonths(v.channelCreatedAt, now)
      if (age !== null && age > filters.maxChannelAgeMonths) return false
    }
    if (filters.minViews !== null && v.views < filters.minViews) return false
    if (filters.madeForKidsOnly && !v.madeForKids) return false
    if (filters.language !== null && !matchesLanguageFilter(filters.language, v)) return false
    return true
  })
  const sorted = [...kept]
  if (filters.sort === 'ratio') {
    sorted.sort((a, b) =>
      compareDesc(
        nicheRatio(a.views, a.channelSubscribers),
        nicheRatio(b.views, b.channelSubscribers)
      )
    )
  } else if (filters.sort === 'views') {
    sorted.sort((a, b) => compareDesc(a.views, b.views))
  } else {
    sorted.sort((a, b) =>
      compareDesc(Date.parse(a.publishedAt ?? '') || 0, Date.parse(b.publishedAt ?? '') || 0)
    )
  }
  return sorted
}

/**
 * Join SERP items with the YouTube enrichment. A channel missing from the
 * API response (deleted channel) yields zeros rather than dropping the video.
 */
export function mergeSearchResults(
  serp: readonly SerpVideoItem[],
  channels: readonly ChannelStats[],
  metas: readonly VideoMeta[]
): NicheScoredVideo[] {
  const byChannel = new Map(channels.map((c) => [c.channelId, c]))
  const byVideo = new Map(metas.map((m) => [m.videoId, m]))
  return serp.map((item) => {
    const channel = byChannel.get(item.channelId)
    const meta = byVideo.get(item.videoId)
    return {
      videoId: item.videoId,
      title: meta?.title || item.title,
      description: meta?.description || item.description,
      url: item.url,
      thumbnail: item.thumbnail,
      publishedAt: meta?.publishedAt ?? item.publishedAt,
      views: item.views || meta?.views || 0,
      likeCount: meta ? meta.likeCount : null,
      commentCount: meta ? meta.commentCount : null,
      tags: meta?.tags ?? [],
      categoryId: meta?.categoryId ?? null,
      durationSeconds: meta?.durationSeconds ?? 0,
      madeForKids: meta?.madeForKids ?? false,
      hasCaptions: meta?.hasCaptions ?? null,
      serpRank: item.rank,
      channelId: item.channelId,
      channelTitle: channel?.title || item.channelTitle,
      channelUrl: channel?.url || item.channelUrl,
      channelThumbnail: channel?.thumbnail ?? '',
      channelSubscribers: channel?.subscribers ?? 0,
      channelVideoCount: channel?.videoCount ?? 0,
      channelViewCount: channel?.viewCount ?? 0,
      channelCreatedAt: channel?.createdAt ?? null,
      language: meta?.language ?? null
    }
  })
}

// ---------------------------------------------------------------------------
// Per-channel aggregates (the niche overview)
// ---------------------------------------------------------------------------

export interface ChannelVideoLite {
  views: number
  durationSeconds: number
  publishedAt: string | null
}

export interface ChannelAggregates {
  videosTracked: number
  totalViews: number
  avgViews: number
  medianViews: number
  avgDurationSeconds: number
  /** Upload cadence estimated from the tracked videos' date span. */
  uploadsPerMonth: number | null
}

export function computeChannelAggregates(videos: readonly ChannelVideoLite[]): ChannelAggregates {
  if (videos.length === 0) {
    return {
      videosTracked: 0,
      totalViews: 0,
      avgViews: 0,
      medianViews: 0,
      avgDurationSeconds: 0,
      uploadsPerMonth: null
    }
  }
  const views = videos.map((v) => v.views).sort((a, b) => a - b)
  const totalViews = views.reduce((sum, v) => sum + v, 0)
  const mid = Math.floor(views.length / 2)
  const medianViews =
    views.length % 2 === 1 ? (views[mid] ?? 0) : ((views[mid - 1] ?? 0) + (views[mid] ?? 0)) / 2
  const durations = videos.filter((v) => v.durationSeconds > 0)
  const avgDurationSeconds =
    durations.length === 0
      ? 0
      : durations.reduce((sum, v) => sum + v.durationSeconds, 0) / durations.length
  const dates = videos
    .map((v) => (v.publishedAt ? Date.parse(v.publishedAt) : NaN))
    .filter((t) => !Number.isNaN(t))
  let uploadsPerMonth: number | null = null
  if (dates.length >= 2) {
    const spanMonths = (Math.max(...dates) - Math.min(...dates)) / MS_PER_MONTH
    uploadsPerMonth = spanMonths > 0 ? dates.length / spanMonths : dates.length
  }
  return {
    videosTracked: videos.length,
    totalViews,
    avgViews: totalViews / videos.length,
    medianViews,
    avgDurationSeconds,
    uploadsPerMonth
  }
}

// ---------------------------------------------------------------------------
// Snapshots — the time series under the score (velocity, growth, "taking off")
// ---------------------------------------------------------------------------

export interface VideoSnapshotLite {
  views: number
  capturedAt: number
}

const MS_PER_DAY = 24 * 3600 * 1000
const SNAPSHOT_HEARTBEAT_MS = 24 * 3600 * 1000

/**
 * Whether a refresh deserves a new snapshot row: always on first sight, then
 * whenever the views moved, plus a daily heartbeat so a flat line stays
 * datable (velocity needs the time axis even when nothing happens).
 */
export function shouldSnapshot(
  previous: VideoSnapshotLite | null,
  nextViews: number,
  now: number
): boolean {
  if (!previous) return true
  if (previous.views !== nextViews) return true
  return now - previous.capturedAt >= SNAPSHOT_HEARTBEAT_MS
}

/**
 * Measured velocity in views/day over the snapshot series (first → last).
 * Null below two snapshots or under an hour of span — too short to mean
 * anything. Clamped at 0: YouTube occasionally corrects counts downward.
 */
export function viewVelocity(snapshots: readonly VideoSnapshotLite[]): number | null {
  if (snapshots.length < 2) return null
  const sorted = [...snapshots].sort((a, b) => a.capturedAt - b.capturedAt)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return null
  const spanMs = last.capturedAt - first.capturedAt
  if (spanMs < 3600 * 1000) return null
  return Math.max(0, ((last.views - first.views) / spanMs) * MS_PER_DAY)
}

/**
 * Lifetime average views/day since publication — the fallback velocity when
 * the series is too young to measure (a single snapshot knows no slope).
 */
export function lifetimeViewsPerDay(
  views: number,
  publishedAt: string | null,
  now: Date
): number | null {
  if (!publishedAt) return null
  const published = Date.parse(publishedAt)
  if (Number.isNaN(published)) return null
  const days = Math.max((now.getTime() - published) / MS_PER_DAY, 1)
  return views / days
}

// ---------------------------------------------------------------------------
// Transcripts (YouTube timedtext)
// ---------------------------------------------------------------------------

export interface CaptionTrack {
  baseUrl: string
  languageCode: string
  /** 'asr' = auto-generated. */
  kind: string | null
  name: string
}

/** Pull `ytInitialPlayerResponse` out of a watch-page HTML document. */
export function extractPlayerResponse(html: string): unknown {
  const marker = 'ytInitialPlayerResponse'
  const start = html.indexOf(marker)
  if (start === -1) return null
  const braceStart = html.indexOf('{', start)
  if (braceStart === -1) return null
  // Balance braces — the JSON is followed by `;var …` or `;</script>`.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = braceStart; i < html.length; i++) {
    const ch = html.charAt(i)
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(braceStart, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function extractCaptionTracks(playerResponse: unknown): CaptionTrack[] {
  const root = asRecord(playerResponse)
  const captions = asRecord(root?.captions)
  const renderer = asRecord(captions?.playerCaptionsTracklistRenderer)
  if (!Array.isArray(renderer?.captionTracks)) return []
  const out: CaptionTrack[] = []
  for (const raw of renderer.captionTracks) {
    const track = asRecord(raw)
    const baseUrl = str(track?.baseUrl)
    if (!baseUrl) continue
    const name = asRecord(track?.name)
    out.push({
      baseUrl,
      languageCode: str(track?.languageCode),
      kind: str(track?.kind) || null,
      name:
        str(name?.simpleText) ||
        str(asRecord(Array.isArray(name?.runs) ? name.runs[0] : null)?.text)
    })
  }
  return out
}

/** Prefer a human track in a preferred language, then ASR, then anything. */
export function pickCaptionTrack(
  tracks: readonly CaptionTrack[],
  preferredLanguages: readonly string[]
): CaptionTrack | null {
  if (tracks.length === 0) return null
  const langOf = (code: string): string => (code.split('-')[0] ?? code).toLowerCase()
  for (const lang of preferredLanguages.map(langOf)) {
    const human = tracks.find((t) => langOf(t.languageCode) === lang && t.kind !== 'asr')
    if (human) return human
    const asr = tracks.find((t) => langOf(t.languageCode) === lang)
    if (asr) return asr
  }
  return tracks.find((t) => t.kind !== 'asr') ?? tracks[0] ?? null
}

export interface TranscriptSegment {
  startMs: number
  text: string
}

/** Parse the timedtext `fmt=json3` payload into ordered segments. */
export function parseTimedTextJson3(raw: string): TranscriptSegment[] {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return []
  }
  const root = asRecord(body)
  if (!Array.isArray(root?.events)) return []
  const out: TranscriptSegment[] = []
  for (const raw of root.events) {
    const event = asRecord(raw)
    if (!event || !Array.isArray(event.segs)) continue
    const text = event.segs
      .map((seg) => str(asRecord(seg)?.utf8))
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    out.push({ startMs: num(event.tStartMs), text })
  }
  return out
}

export function transcriptToText(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(' ')
}

export function formatTranscriptWithTimestamps(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const total = Math.floor(s.startMs / 1000)
      const min = Math.floor(total / 60)
      const sec = String(total % 60).padStart(2, '0')
      return `[${min}:${sec}] ${s.text}`
    })
    .join('\n')
}
