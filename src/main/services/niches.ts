import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  Niche,
  NicheChannel,
  NicheOverview,
  NicheRefreshResult,
  NicheRoadmapItem,
  NicheVideo,
  NicheVideoFiltersInput,
  VoicePersona
} from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import {
  channelOutlierRatio,
  computeChannelAggregates,
  DEFAULT_LANGUAGE_CODE,
  DEFAULT_LOCATION_CODE,
  DEFAULT_NICHE_FILTERS,
  filterNicheVideos,
  formatTranscriptWithTimestamps,
  lifetimeViewsPerDay,
  mergeSearchResults,
  parseChannelRef,
  parseYoutubeVideoUrl,
  shouldSnapshot,
  spPresetRaw,
  viewVelocity,
  type ChannelAggregates,
  type ChannelStats,
  type NicheScoredVideo,
  type NicheVideoFilters,
  type RoadmapStatus,
  type RoadmapVideoType,
  type VideoMeta
} from '@shared/niches'
import { getStyle } from '@shared/styles/registry'
import { getDb } from '../db/client'
import {
  nicheChannels,
  nicheRoadmapItems,
  nicheVideoSnapshots,
  nicheVideos,
  niches,
  videos
} from '../db/schema'
import { broadcastNichesChanged } from '../events'
import { searchYoutubeSerp } from './dataforseo'
import { listGraph, updateNodeParams } from './graph'
import { withGraphHistoryGroup } from './graphHistory'
import { logInfo, logWarn } from './logger'
import { createRecipeNode } from './recipes'
import { nicheKeysStatus } from './settings'
import { createVideo, getVideo, setVideoDefaults, setVideoStyle } from './videos'
import { listVoicePersonas } from './voicePersonas'
import {
  fetchChannelByHandle,
  fetchChannelsByIds,
  fetchUploads,
  fetchVideosMeta,
  type QuotaCounter
} from './youtubeApi'
import { fetchTranscript } from './youtubeTranscript'

/**
 * YouTube niche research (§7) — the business logic behind the Niches section,
 * consumed by IPC AND by the MCP/chat tools. A niche is a watchlist of
 * channels (competitors + the user's own) and the videos tracked for both;
 * DataForSEO scrapes the real SERP, the YouTube Data API enriches cheaply
 * (50 ids per quota unit), and everything decision-shaped (scoring, filters,
 * merging, parsing) is pure in `@shared/niches`.
 */

const DEFAULT_VIDEOS_PER_CHANNEL = 30

type NicheRow = typeof niches.$inferSelect
type ChannelRow = typeof nicheChannels.$inferSelect
type VideoRow = typeof nicheVideos.$inferSelect

function toNiche(row: NicheRow): Niche {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    languageCode: row.languageCode,
    locationCode: row.locationCode,
    styleId: row.styleId ?? null,
    aspectRatio: (row.aspectRatio as Niche['aspectRatio']) ?? null,
    targetSeconds: row.targetSeconds ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toChannel(row: ChannelRow): NicheChannel {
  return {
    id: row.id,
    nicheId: row.nicheId,
    channelId: row.channelId,
    title: row.title,
    description: row.description ?? null,
    handle: row.handle ?? null,
    url: row.url,
    thumbnail: row.thumbnail ?? null,
    subscribers: row.subscribers,
    videoCount: row.videoCount,
    viewCount: row.viewCount,
    channelCreatedAt: row.channelCreatedAt ?? null,
    uploadsPlaylistId: row.uploadsPlaylistId ?? null,
    isMine: row.isMine,
    notes: row.notes ?? null,
    lastRefreshedAt: row.lastRefreshedAt ?? null,
    createdAt: row.createdAt
  }
}

/** Computed lenses attached at read time (they need the niche-wide context). */
interface VideoLenses {
  channelRatio: number | null
  viewsPerDay: number | null
}

function toVideo(row: VideoRow, lenses?: VideoLenses): NicheVideo {
  return {
    id: row.id,
    nicheId: row.nicheId,
    videoId: row.videoId,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    title: row.title,
    description: row.description ?? null,
    url: row.url,
    thumbnail: row.thumbnail ?? null,
    publishedAt: row.publishedAt ?? null,
    views: row.views,
    likeCount: row.likeCount ?? null,
    commentCount: row.commentCount ?? null,
    language: row.language ?? null,
    hasCaptions: row.hasCaptions ?? null,
    serpRank: row.serpRank ?? null,
    durationSeconds: row.durationSeconds,
    madeForKids: row.madeForKids,
    channelSubscribers: row.channelSubscribers,
    channelCreatedAt: row.channelCreatedAt ?? null,
    source: row.source,
    keyword: row.keyword ?? null,
    hasTranscript: row.transcript !== null && row.transcript !== '',
    channelRatio: lenses?.channelRatio ?? null,
    viewsPerDay: lenses?.viewsPerDay ?? null,
    statsRefreshedAt: row.statsRefreshedAt ?? null,
    createdAt: row.createdAt
  }
}

/**
 * Views vs the channel's own median over its tracked videos — the second
 * outlier lens. Needs ≥3 videos per channel to mean anything.
 */
function channelMediansOf(rows: readonly VideoRow[]): Map<string, number> {
  const byChannel = new Map<string, number[]>()
  for (const row of rows) {
    const list = byChannel.get(row.channelId) ?? []
    list.push(row.views)
    byChannel.set(row.channelId, list)
  }
  const medians = new Map<string, number>()
  for (const [channelId, views] of byChannel) {
    if (views.length < 3) continue
    const sorted = [...views].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    medians.set(
      channelId,
      sorted.length % 2 === 1
        ? (sorted[mid] ?? 0)
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    )
  }
  return medians
}

/** Snapshot series for a set of tracked-video rows, grouped by row id. */
function snapshotsByRow(
  rowIds: readonly string[]
): Map<string, { views: number; capturedAt: number }[]> {
  const out = new Map<string, { views: number; capturedAt: number }[]>()
  if (rowIds.length === 0) return out
  const rows = getDb()
    .select()
    .from(nicheVideoSnapshots)
    .where(inArray(nicheVideoSnapshots.nicheVideoId, [...rowIds]))
    .all()
  for (const snap of rows) {
    const list = out.get(snap.nicheVideoId) ?? []
    list.push({ views: snap.views, capturedAt: snap.capturedAt })
    out.set(snap.nicheVideoId, list)
  }
  return out
}

function lensesOf(
  row: VideoRow,
  medians: Map<string, number>,
  snapshots: Map<string, { views: number; capturedAt: number }[]>,
  now: Date
): VideoLenses {
  return {
    channelRatio: channelOutlierRatio(row.views, medians.get(row.channelId) ?? 0),
    viewsPerDay:
      viewVelocity(snapshots.get(row.id) ?? []) ??
      lifetimeViewsPerDay(row.views, row.publishedAt ?? null, now)
  }
}

/**
 * One time-series point per refresh where the numbers moved (plus a daily
 * heartbeat) — refreshes overwrite `views` on the row, the series lives here.
 */
function recordSnapshot(
  nicheVideoRowId: string,
  values: { views: number; likeCount: number | null; channelSubscribers: number },
  now: number
): void {
  const db = getDb()
  const previous = db
    .select()
    .from(nicheVideoSnapshots)
    .where(eq(nicheVideoSnapshots.nicheVideoId, nicheVideoRowId))
    .orderBy(desc(nicheVideoSnapshots.capturedAt))
    .limit(1)
    .get()
  const prev = previous ? { views: previous.views, capturedAt: previous.capturedAt } : null
  if (!shouldSnapshot(prev, values.views, now)) return
  db.insert(nicheVideoSnapshots)
    .values({
      id: randomUUID(),
      nicheVideoId: nicheVideoRowId,
      views: values.views,
      likeCount: values.likeCount,
      channelSubscribers: values.channelSubscribers,
      capturedAt: now
    })
    .run()
}

function getNicheRow(nicheId: string): NicheRow {
  const row = getDb().select().from(niches).where(eq(niches.id, nicheId)).get()
  if (!row) throw new Error(`Unknown nicheId "${nicheId}".`)
  return row
}

// ---------------------------------------------------------------------------
// Niche CRUD
// ---------------------------------------------------------------------------

export function listNiches(): NicheOverview[] {
  const db = getDb()
  const rows = db.select().from(niches).orderBy(desc(niches.updatedAt)).all()
  return rows.map((row) => {
    const channels = db
      .select({ isMine: nicheChannels.isMine })
      .from(nicheChannels)
      .where(eq(nicheChannels.nicheId, row.id))
      .all()
    const videoCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(nicheVideos)
        .where(eq(nicheVideos.nicheId, row.id))
        .get()?.count ?? 0
    return {
      ...toNiche(row),
      channelCount: channels.length,
      mineChannelCount: channels.filter((c) => c.isMine).length,
      videoCount
    }
  })
}

export function getNiche(nicheId: string): {
  niche: Niche
  channels: NicheChannel[]
  aggregates: Record<string, ChannelAggregates>
  videoCount: number
} {
  const db = getDb()
  const row = getNicheRow(nicheId)
  const channels = db
    .select()
    .from(nicheChannels)
    .where(eq(nicheChannels.nicheId, nicheId))
    .orderBy(desc(nicheChannels.isMine), desc(nicheChannels.subscribers))
    .all()
  const videoCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(nicheVideos)
      .where(eq(nicheVideos.nicheId, nicheId))
      .get()?.count ?? 0
  return {
    niche: toNiche(row),
    channels: channels.map(toChannel),
    aggregates: channelAggregates(nicheId),
    videoCount
  }
}

export function createNiche(input: {
  name: string
  description?: string | null
  languageCode?: string
  locationCode?: number
}): Niche {
  const now = Date.now()
  const row: NicheRow = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    languageCode: input.languageCode ?? DEFAULT_LANGUAGE_CODE,
    locationCode: input.locationCode ?? DEFAULT_LOCATION_CODE,
    styleId: null,
    aspectRatio: null,
    targetSeconds: null,
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(niches).values(row).run()
  broadcastNichesChanged()
  return toNiche(row)
}

export function updateNiche(
  nicheId: string,
  patch: {
    name?: string
    description?: string | null
    languageCode?: string
    locationCode?: number
    styleId?: string | null
    aspectRatio?: string | null
    targetSeconds?: number | null
  }
): Niche {
  const row = getNicheRow(nicheId)
  if (patch.styleId != null && !getStyle(patch.styleId)) {
    throw new Error(`Unknown styleId "${patch.styleId}".`)
  }
  const next = {
    name: patch.name ?? row.name,
    description: patch.description === undefined ? row.description : patch.description,
    languageCode: patch.languageCode ?? row.languageCode,
    locationCode: patch.locationCode ?? row.locationCode,
    styleId: patch.styleId === undefined ? row.styleId : patch.styleId,
    aspectRatio: patch.aspectRatio === undefined ? row.aspectRatio : patch.aspectRatio,
    targetSeconds: patch.targetSeconds === undefined ? row.targetSeconds : patch.targetSeconds,
    updatedAt: Date.now()
  }
  getDb().update(niches).set(next).where(eq(niches.id, nicheId)).run()
  broadcastNichesChanged()
  return toNiche({ ...row, ...next })
}

export function deleteNiche(nicheId: string): void {
  getDb().delete(niches).where(eq(niches.id, nicheId)).run()
  broadcastNichesChanged()
}

function touchNiche(nicheId: string): void {
  getDb().update(niches).set({ updatedAt: Date.now() }).where(eq(niches.id, nicheId)).run()
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

async function resolveChannel(ref: string, quota: QuotaCounter): Promise<ChannelStats> {
  const parsed = parseChannelRef(ref)
  if (!parsed) {
    throw new Error(`Cannot parse "${ref}" as a YouTube channel id, @handle or URL.`)
  }
  const channel =
    parsed.kind === 'id'
      ? (await fetchChannelsByIds([parsed.value], quota))[0]
      : await fetchChannelByHandle(parsed.value, quota)
  if (!channel) throw new Error(`YouTube channel "${ref}" was not found.`)
  return channel
}

function channelPatch(
  stats: ChannelStats
): Omit<ChannelRow, 'id' | 'nicheId' | 'isMine' | 'notes' | 'createdAt'> {
  return {
    channelId: stats.channelId,
    title: stats.title,
    description: stats.description || null,
    handle: stats.handle,
    url: stats.url,
    thumbnail: stats.thumbnail || null,
    subscribers: stats.subscribers,
    videoCount: stats.videoCount,
    viewCount: stats.viewCount,
    channelCreatedAt: stats.createdAt,
    uploadsPlaylistId: stats.uploadsPlaylistId,
    lastRefreshedAt: Date.now()
  }
}

export async function addChannel(input: {
  nicheId: string
  ref: string
  isMine?: boolean
  notes?: string | null
}): Promise<NicheChannel> {
  const db = getDb()
  getNicheRow(input.nicheId)
  const quota: QuotaCounter = { units: 0 }
  const stats = await resolveChannel(input.ref, quota)
  const existing = db
    .select()
    .from(nicheChannels)
    .where(
      and(eq(nicheChannels.nicheId, input.nicheId), eq(nicheChannels.channelId, stats.channelId))
    )
    .get()
  if (existing) {
    throw new Error(`Channel "${stats.title}" is already tracked in this niche.`)
  }
  const row: ChannelRow = {
    id: randomUUID(),
    nicheId: input.nicheId,
    isMine: input.isMine ?? false,
    notes: input.notes ?? null,
    createdAt: Date.now(),
    ...channelPatch(stats)
  }
  db.insert(nicheChannels).values(row).run()
  touchNiche(input.nicheId)
  broadcastNichesChanged()
  return toChannel(row)
}

export function updateChannel(
  nicheChannelId: string,
  patch: { isMine?: boolean; notes?: string | null }
): NicheChannel {
  const db = getDb()
  const row = db.select().from(nicheChannels).where(eq(nicheChannels.id, nicheChannelId)).get()
  if (!row) throw new Error(`Unknown nicheChannelId "${nicheChannelId}".`)
  const next = {
    isMine: patch.isMine ?? row.isMine,
    notes: patch.notes === undefined ? row.notes : patch.notes
  }
  db.update(nicheChannels).set(next).where(eq(nicheChannels.id, nicheChannelId)).run()
  broadcastNichesChanged()
  return toChannel({ ...row, ...next })
}

export function removeChannel(nicheChannelId: string): void {
  const db = getDb()
  const row = db.select().from(nicheChannels).where(eq(nicheChannels.id, nicheChannelId)).get()
  if (!row) return
  // The channel's tracked videos go with it — they were tracked BECAUSE of it.
  db.delete(nicheVideos)
    .where(
      and(
        eq(nicheVideos.nicheId, row.nicheId),
        eq(nicheVideos.channelId, row.channelId),
        eq(nicheVideos.source, 'channel')
      )
    )
    .run()
  db.delete(nicheChannels).where(eq(nicheChannels.id, nicheChannelId)).run()
  broadcastNichesChanged()
}

// ---------------------------------------------------------------------------
// Refresh (channel stats + latest uploads + video stats)
// ---------------------------------------------------------------------------

/** The stat columns a videos.list meta refreshes on an existing row. */
function metaStatsPatch(meta: VideoMeta, subscribers: number): Partial<VideoRow> {
  return {
    views: meta.views,
    likeCount: meta.likeCount,
    commentCount: meta.commentCount,
    tags: meta.tags.length > 0 ? meta.tags : null,
    categoryId: meta.categoryId,
    language: meta.language,
    hasCaptions: meta.hasCaptions,
    durationSeconds: meta.durationSeconds,
    madeForKids: meta.madeForKids,
    channelSubscribers: subscribers
  }
}

function upsertChannelVideo(
  nicheId: string,
  meta: VideoMeta,
  channel: ChannelRow,
  counters: { added: number; updated: number },
  /** Row ids already written this refresh — the tracked-rows loop skips them. */
  touched: Set<string>
): void {
  const db = getDb()
  const now = Date.now()
  const existing = db
    .select()
    .from(nicheVideos)
    .where(and(eq(nicheVideos.nicheId, nicheId), eq(nicheVideos.videoId, meta.videoId)))
    .get()
  if (existing) {
    db.update(nicheVideos)
      .set({
        title: meta.title || existing.title,
        description: meta.description || existing.description,
        ...metaStatsPatch(meta, channel.subscribers),
        statsRefreshedAt: now
      })
      .where(eq(nicheVideos.id, existing.id))
      .run()
    recordSnapshot(
      existing.id,
      { views: meta.views, likeCount: meta.likeCount, channelSubscribers: channel.subscribers },
      now
    )
    counters.updated += 1
    touched.add(existing.id)
    return
  }
  const id = randomUUID()
  db.insert(nicheVideos)
    .values({
      id,
      nicheId,
      videoId: meta.videoId,
      channelId: channel.channelId,
      channelTitle: channel.title,
      title: meta.title,
      description: meta.description || null,
      url: `https://www.youtube.com/watch?v=${meta.videoId}`,
      thumbnail: meta.thumbnail || null,
      publishedAt: meta.publishedAt,
      durationSeconds: meta.durationSeconds,
      madeForKids: meta.madeForKids,
      channelCreatedAt: channel.channelCreatedAt,
      source: 'channel',
      keyword: null,
      serpRank: null,
      transcript: null,
      transcriptFetchedAt: null,
      statsRefreshedAt: now,
      createdAt: now,
      views: meta.views,
      likeCount: meta.likeCount,
      commentCount: meta.commentCount,
      tags: meta.tags.length > 0 ? meta.tags : null,
      categoryId: meta.categoryId,
      language: meta.language,
      hasCaptions: meta.hasCaptions,
      channelSubscribers: channel.subscribers
    })
    .run()
  recordSnapshot(
    id,
    { views: meta.views, likeCount: meta.likeCount, channelSubscribers: channel.subscribers },
    now
  )
  counters.added += 1
  touched.add(id)
}

/**
 * The iteration loop's data pull: re-read every tracked channel's stats,
 * list its latest uploads, and refresh the stats of every tracked video
 * (the niche score moves as views come in).
 */
export async function refreshNiche(
  nicheId: string,
  videosPerChannel = DEFAULT_VIDEOS_PER_CHANNEL
): Promise<NicheRefreshResult> {
  const db = getDb()
  getNicheRow(nicheId)
  const channels = db.select().from(nicheChannels).where(eq(nicheChannels.nicheId, nicheId)).all()
  const quota: QuotaCounter = { units: 0 }
  const counters = { added: 0, updated: 0 }

  // 1. Channel stats, batched 50 per unit.
  const stats = await fetchChannelsByIds(
    channels.map((c) => c.channelId),
    quota
  )
  const statsById = new Map(stats.map((s) => [s.channelId, s]))
  const refreshed: ChannelRow[] = []
  for (const channel of channels) {
    const fresh = statsById.get(channel.channelId)
    if (!fresh) continue // deleted channel — keep the last known stats
    const patch = channelPatch(fresh)
    db.update(nicheChannels).set(patch).where(eq(nicheChannels.id, channel.id)).run()
    refreshed.push({ ...channel, ...patch })
  }

  // 2. Latest uploads per channel + stats of every already-tracked video.
  const trackedRows = db.select().from(nicheVideos).where(eq(nicheVideos.nicheId, nicheId)).all()
  const wantedByChannel = new Map<string, string[]>()
  for (const channel of refreshed) {
    if (!channel.uploadsPlaylistId) continue
    const uploads = await fetchUploads(channel.uploadsPlaylistId, videosPerChannel, quota)
    wantedByChannel.set(
      channel.channelId,
      uploads.map((u) => u.videoId)
    )
  }
  const allIds = [
    ...new Set([...trackedRows.map((v) => v.videoId), ...[...wantedByChannel.values()].flat()])
  ]
  const metas = await fetchVideosMeta(allIds, quota)
  const metaById = new Map(metas.map((m) => [m.videoId, m]))

  const channelByYtId = new Map(refreshed.map((c) => [c.channelId, c]))
  // New uploads first (insert), then refresh the stats of what we already track.
  // `touched` collects the row ids the upsert pass wrote, so the loop below
  // neither re-writes nor double-counts them in videosUpdated.
  const touched = new Set<string>()
  for (const [channelId, videoIds] of wantedByChannel) {
    const channel = channelByYtId.get(channelId)
    if (!channel) continue
    for (const videoId of videoIds) {
      const meta = metaById.get(videoId)
      if (meta) upsertChannelVideo(nicheId, meta, channel, counters, touched)
    }
  }
  const now = Date.now()
  for (const row of trackedRows) {
    const meta = metaById.get(row.videoId)
    if (!meta || touched.has(row.id)) continue
    const channel = channelByYtId.get(row.channelId)
    const subscribers = channel?.subscribers ?? row.channelSubscribers
    db.update(nicheVideos)
      .set({ ...metaStatsPatch(meta, subscribers), statsRefreshedAt: now })
      .where(eq(nicheVideos.id, row.id))
      .run()
    recordSnapshot(
      row.id,
      { views: meta.views, likeCount: meta.likeCount, channelSubscribers: subscribers },
      now
    )
    counters.updated += 1
  }

  touchNiche(nicheId)
  broadcastNichesChanged()
  logInfo(
    'niches',
    `refresh ${nicheId}: ${refreshed.length} channels, +${counters.added}/${counters.updated} videos, ${quota.units} quota units`
  )
  return {
    channelsRefreshed: refreshed.length,
    videosAdded: counters.added,
    videosUpdated: counters.updated,
    quotaUsed: quota.units
  }
}

// ---------------------------------------------------------------------------
// Tracked videos (filtered read)
// ---------------------------------------------------------------------------

function rowToScored(row: VideoRow): NicheScoredVideo {
  return {
    videoId: row.videoId,
    title: row.title,
    description: row.description ?? '',
    url: row.url,
    thumbnail: row.thumbnail ?? '',
    publishedAt: row.publishedAt ?? null,
    views: row.views,
    likeCount: row.likeCount ?? null,
    commentCount: row.commentCount ?? null,
    tags: row.tags ?? [],
    categoryId: row.categoryId ?? null,
    durationSeconds: row.durationSeconds,
    madeForKids: row.madeForKids,
    hasCaptions: row.hasCaptions ?? null,
    serpRank: row.serpRank ?? null,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    channelUrl: `https://www.youtube.com/channel/${row.channelId}`,
    channelThumbnail: '',
    channelSubscribers: row.channelSubscribers,
    channelVideoCount: 0,
    channelViewCount: 0,
    channelCreatedAt: row.channelCreatedAt ?? null,
    // Persisted at ingest since the language column exists; legacy rows fall
    // back to the title-script heuristic.
    language: row.language ?? null
  }
}

export function listNicheVideos(
  nicheId: string,
  filters?: NicheVideoFiltersInput,
  limit = 200
): NicheVideo[] {
  getNicheRow(nicheId)
  const rows = getDb().select().from(nicheVideos).where(eq(nicheVideos.nicheId, nicheId)).all()
  const effective: NicheVideoFilters = {
    ...DEFAULT_NICHE_FILTERS,
    // Tracked videos default to "no filter": the watchlist was curated already.
    maxSubscribers: null,
    maxChannelAgeMonths: null,
    ...(filters
      ? Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined))
      : {})
  }
  const byId = new Map(rows.map((r) => [r.videoId, r]))
  const kept = filterNicheVideos(rows.map(rowToScored), effective, new Date()).slice(0, limit)
  const keptRows = kept.map((scored) => byId.get(scored.videoId) as VideoRow)
  const medians = channelMediansOf(rows)
  const snapshots = snapshotsByRow(keptRows.map((r) => r.id))
  const now = new Date()
  return keptRows.map((row) => toVideo(row, lensesOf(row, medians, snapshots, now)))
}

// ---------------------------------------------------------------------------
// Keyword search (DataForSEO SERP + YouTube enrichment)
// ---------------------------------------------------------------------------

export async function keywordSearch(input: {
  keyword: string
  nicheId?: string
  locationCode?: number
  languageCode?: string
  depth?: number
  searchParam?: string
  save?: boolean
}): Promise<{
  videos: NicheScoredVideo[]
  quotaUsed: number
  saved: number
  costUsd: number | null
}> {
  const niche = input.nicheId ? getNicheRow(input.nicheId) : null
  if (input.save && !niche) {
    throw new Error('Saving search results requires a nicheId.')
  }
  const { videos: serp, costUsd } = await searchYoutubeSerp({
    keyword: input.keyword,
    locationCode: input.locationCode ?? niche?.locationCode ?? DEFAULT_LOCATION_CODE,
    languageCode: input.languageCode ?? niche?.languageCode ?? DEFAULT_LANGUAGE_CODE,
    depth: input.depth ?? 100,
    // A preset id resolves to its raw sp value; anything else normalizes as-is.
    searchParam: input.searchParam ? (spPresetRaw(input.searchParam) ?? input.searchParam) : null
  })
  const quota: QuotaCounter = { units: 0 }
  const [channels, metas] = await Promise.all([
    fetchChannelsByIds(
      serp.map((v) => v.channelId),
      quota
    ),
    fetchVideosMeta(
      serp.map((v) => v.videoId),
      quota
    )
  ])
  const videos = mergeSearchResults(serp, channels, metas)

  let saved = 0
  if (input.save && niche) {
    const db = getDb()
    const now = Date.now()
    for (const video of videos) {
      const existing = db
        .select({ id: nicheVideos.id })
        .from(nicheVideos)
        .where(and(eq(nicheVideos.nicheId, niche.id), eq(nicheVideos.videoId, video.videoId)))
        .get()
      if (existing) continue
      const rowId = randomUUID()
      db.insert(nicheVideos)
        .values({
          id: rowId,
          nicheId: niche.id,
          videoId: video.videoId,
          channelId: video.channelId,
          channelTitle: video.channelTitle,
          title: video.title,
          description: video.description || null,
          url: video.url,
          thumbnail: video.thumbnail || null,
          publishedAt: video.publishedAt,
          views: video.views,
          likeCount: video.likeCount,
          commentCount: video.commentCount,
          tags: video.tags.length > 0 ? video.tags : null,
          categoryId: video.categoryId,
          language: video.language,
          hasCaptions: video.hasCaptions,
          serpRank: video.serpRank,
          durationSeconds: video.durationSeconds,
          madeForKids: video.madeForKids,
          channelSubscribers: video.channelSubscribers,
          channelCreatedAt: video.channelCreatedAt,
          source: 'search',
          keyword: input.keyword,
          transcript: null,
          transcriptFetchedAt: null,
          statsRefreshedAt: now,
          createdAt: now
        })
        .run()
      recordSnapshot(
        rowId,
        {
          views: video.views,
          likeCount: video.likeCount,
          channelSubscribers: video.channelSubscribers
        },
        now
      )
      saved += 1
    }
    if (saved > 0) {
      touchNiche(niche.id)
      broadcastNichesChanged()
    }
  }
  return { videos, quotaUsed: quota.units, saved, costUsd }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export async function fetchTranscripts(input: {
  nicheId: string
  videoIds?: string[]
  limit?: number
}): Promise<{ fetched: number; failed: string[]; remaining: number }> {
  const db = getDb()
  const niche = getNicheRow(input.nicheId)
  const limit = input.limit ?? 10
  const withoutTranscript = db
    .select()
    .from(nicheVideos)
    .where(and(eq(nicheVideos.nicheId, input.nicheId), isNull(nicheVideos.transcript)))
    .orderBy(desc(nicheVideos.views))
    .all()
    .filter((row) => !input.videoIds || input.videoIds.includes(row.videoId))
    // The API says these have no captions — don't burn unofficial fetches on
    // them (an explicit videoIds request overrides, captions do appear late).
    .filter((row) => row.hasCaptions !== false || input.videoIds?.includes(row.videoId))
  // Never-attempted videos first; once none remain, a new call RETRIES the
  // previously-failed ones (captions appear late, and fetch bugs get fixed).
  const fresh = withoutTranscript.filter((row) => row.transcriptFetchedAt === null)
  const wanted = fresh.length > 0 ? fresh : withoutTranscript
  const batch = wanted.slice(0, limit)
  const failed: string[] = []
  let fetched = 0
  for (const row of batch) {
    const transcript = await fetchTranscript(row.videoId, [niche.languageCode, 'en'])
    // transcriptFetchedAt is stamped either way — it marks "attempted", which
    // demotes the video to the retry tier; `transcript` stays null on failure.
    db.update(nicheVideos)
      .set({
        transcript: transcript ? formatTranscriptWithTimestamps(transcript.segments) : null,
        transcriptLanguage: transcript?.languageCode ?? null,
        transcriptIsAsr: transcript ? transcript.autoGenerated : null,
        transcriptFetchedAt: Date.now()
      })
      .where(eq(nicheVideos.id, row.id))
      .run()
    if (transcript) fetched += 1
    else failed.push(row.videoId)
  }
  if (batch.length > 0) broadcastNichesChanged()
  return { fetched, failed, remaining: Math.max(0, wanted.length - batch.length) }
}

export function getTranscript(nicheVideoId: string): {
  videoId: string
  title: string
  transcript: string | null
} {
  const row = getDb().select().from(nicheVideos).where(eq(nicheVideos.id, nicheVideoId)).get()
  if (!row) throw new Error(`Unknown nicheVideoId "${nicheVideoId}".`)
  return { videoId: row.videoId, title: row.title, transcript: row.transcript ?? null }
}

/** Full detail of one tracked video — description + transcript included (agents). */
export function getNicheVideoDetail(nicheVideoId: string): NicheVideo & {
  transcript: string | null
  transcriptLanguage: string | null
  transcriptIsAsr: boolean | null
  tags: string[]
  categoryId: string | null
} {
  const db = getDb()
  const row = db.select().from(nicheVideos).where(eq(nicheVideos.id, nicheVideoId)).get()
  if (!row) throw new Error(`Unknown nicheVideoId "${nicheVideoId}".`)
  const siblings = db.select().from(nicheVideos).where(eq(nicheVideos.nicheId, row.nicheId)).all()
  const lenses = lensesOf(row, channelMediansOf(siblings), snapshotsByRow([row.id]), new Date())
  return {
    ...toVideo(row, lenses),
    transcript: row.transcript ?? null,
    transcriptLanguage: row.transcriptLanguage ?? null,
    transcriptIsAsr: row.transcriptIsAsr ?? null,
    tags: row.tags ?? [],
    categoryId: row.categoryId ?? null
  }
}

/** Per-channel aggregates over the tracked videos (cadence, avg/median views). */
export function channelAggregates(nicheId: string): Record<string, ChannelAggregates> {
  const rows = getDb().select().from(nicheVideos).where(eq(nicheVideos.nicheId, nicheId)).all()
  const byChannel = new Map<string, VideoRow[]>()
  for (const row of rows) {
    const list = byChannel.get(row.channelId) ?? []
    list.push(row)
    byChannel.set(row.channelId, list)
  }
  return Object.fromEntries(
    [...byChannel].map(([channelId, videos]) => [
      channelId,
      computeChannelAggregates(
        videos.map((v) => ({
          views: v.views,
          durationSeconds: v.durationSeconds,
          publishedAt: v.publishedAt ?? null,
          likeCount: v.likeCount ?? null,
          commentCount: v.commentCount ?? null
        }))
      )
    ])
  )
}

// ---------------------------------------------------------------------------
// Roadmap (§7b) — the videos to make, idea → workflow → published
// ---------------------------------------------------------------------------

type RoadmapRow = typeof nicheRoadmapItems.$inferSelect

function getRoadmapRow(itemId: string): RoadmapRow {
  const row = getDb().select().from(nicheRoadmapItems).where(eq(nicheRoadmapItems.id, itemId)).get()
  if (!row) throw new Error(`Unknown roadmap itemId "${itemId}".`)
  return row
}

/** Median views over every video tracked in the niche — the publication baseline. */
function nicheMedianViews(nicheId: string): number {
  const rows = getDb()
    .select({ views: nicheVideos.views })
    .from(nicheVideos)
    .where(eq(nicheVideos.nicheId, nicheId))
    .all()
  return computeChannelAggregates(
    rows.map((r) => ({ views: r.views, durationSeconds: 0, publishedAt: null }))
  ).medianViews
}

function toRoadmapItem(row: RoadmapRow): NicheRoadmapItem {
  const video = row.videoId ? getVideo(row.videoId) : null
  let published: NicheRoadmapItem['published'] = null
  if (row.publishedVideoId) {
    const tracked = getDb()
      .select({ views: nicheVideos.views })
      .from(nicheVideos)
      .where(
        and(eq(nicheVideos.nicheId, row.nicheId), eq(nicheVideos.videoId, row.publishedVideoId))
      )
      .get()
    if (tracked) {
      published = { views: tracked.views, nicheMedianViews: nicheMedianViews(row.nicheId) }
    }
  }
  return {
    id: row.id,
    nicheId: row.nicheId,
    title: row.title,
    titleVariants: row.titleVariants ?? null,
    angle: row.angle ?? null,
    description: row.description ?? null,
    thumbnailBrief: row.thumbnailBrief ?? null,
    evidence: row.evidence ?? null,
    videoType: row.videoType,
    status: row.status,
    videoId: row.videoId ?? null,
    projectId: video?.projectId ?? null,
    publishedVideoId: row.publishedVideoId ?? null,
    published,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function listRoadmap(nicheId: string): NicheRoadmapItem[] {
  getNicheRow(nicheId)
  return getDb()
    .select()
    .from(nicheRoadmapItems)
    .where(eq(nicheRoadmapItems.nicheId, nicheId))
    .orderBy(asc(nicheRoadmapItems.sortOrder), asc(nicheRoadmapItems.createdAt))
    .all()
    .map(toRoadmapItem)
}

export function addRoadmapItem(input: {
  nicheId: string
  title: string
  titleVariants?: string[] | null
  angle?: string | null
  description?: string | null
  thumbnailBrief?: string | null
  evidence?: string | null
  videoType?: RoadmapVideoType
}): NicheRoadmapItem {
  const db = getDb()
  getNicheRow(input.nicheId)
  const maxOrder =
    db
      .select({ max: sql<number | null>`max(sort_order)` })
      .from(nicheRoadmapItems)
      .where(eq(nicheRoadmapItems.nicheId, input.nicheId))
      .get()?.max ?? 0
  const now = Date.now()
  const row: RoadmapRow = {
    id: randomUUID(),
    nicheId: input.nicheId,
    title: input.title,
    titleVariants: input.titleVariants?.length ? input.titleVariants : null,
    angle: input.angle ?? null,
    description: input.description ?? null,
    thumbnailBrief: input.thumbnailBrief ?? null,
    evidence: input.evidence ?? null,
    videoType: input.videoType ?? 'long',
    status: 'idea',
    videoId: null,
    publishedVideoId: null,
    sortOrder: maxOrder + 1,
    createdAt: now,
    updatedAt: now
  }
  db.insert(nicheRoadmapItems).values(row).run()
  broadcastNichesChanged()
  return toRoadmapItem(row)
}

export function updateRoadmapItem(
  itemId: string,
  patch: {
    title?: string
    titleVariants?: string[] | null
    angle?: string | null
    description?: string | null
    thumbnailBrief?: string | null
    evidence?: string | null
    videoType?: RoadmapVideoType
    status?: RoadmapStatus
    sortOrder?: number
  }
): NicheRoadmapItem {
  const row = getRoadmapRow(itemId)
  const next = {
    title: patch.title ?? row.title,
    titleVariants:
      patch.titleVariants === undefined
        ? row.titleVariants
        : patch.titleVariants?.length
          ? patch.titleVariants
          : null,
    angle: patch.angle === undefined ? row.angle : patch.angle,
    description: patch.description === undefined ? row.description : patch.description,
    thumbnailBrief: patch.thumbnailBrief === undefined ? row.thumbnailBrief : patch.thumbnailBrief,
    evidence: patch.evidence === undefined ? row.evidence : patch.evidence,
    videoType: patch.videoType ?? row.videoType,
    status: patch.status ?? row.status,
    sortOrder: patch.sortOrder ?? row.sortOrder,
    updatedAt: Date.now()
  }
  getDb().update(nicheRoadmapItems).set(next).where(eq(nicheRoadmapItems.id, itemId)).run()
  broadcastNichesChanged()
  return toRoadmapItem({ ...row, ...next })
}

export function deleteRoadmapItem(itemId: string): void {
  const db = getDb()
  // roadmap_item_id has no FK (it would cycle) — clear the back-link by hand.
  db.update(videos).set({ roadmapItemId: null }).where(eq(videos.roadmapItemId, itemId)).run()
  db.delete(nicheRoadmapItems).where(eq(nicheRoadmapItems.id, itemId)).run()
  broadcastNichesChanged()
}

/**
 * The item's thumbnail node, created from the brief if the graph has none yet
 * (idempotent on re-assign). A `short` gets a vertical 9:16 thumbnail when the
 * model offers the ratio — creation + override land as ONE undo step.
 */
function ensureThumbnailNode(
  videoId: string,
  brief: string,
  videoType: RoadmapVideoType
): string | null {
  const existing = listGraph(videoId).nodes.find(
    (n) => (n.params as Record<string, unknown> | null)?.designId === 'thumbnail'
  )
  if (existing) return existing.id
  return withGraphHistoryGroup(videoId, () => {
    const { nodeId, modelId } = createRecipeNode({
      videoId,
      recipeId: 'thumbnail',
      values: { description: brief }
    })
    if (videoType === 'short') {
      const field = getModel(modelId)?.paramFields.find(
        (f) => f.key === 'aspect_ratio' && f.type === 'select'
      )
      if (field?.options?.some((o) => o.value === '9:16')) {
        const node = listGraph(videoId).nodes.find((n) => n.id === nodeId)
        if (node) {
          updateNodeParams(nodeId, {
            ...(node.params as Record<string, unknown>),
            aspect_ratio: '9:16'
          })
        }
      }
    }
    return nodeId
  })
}

/**
 * Idea → workflow. Creates the Raccord video (or links an existing one),
 * applies the niche's production profile — style, aspect ratio (a `short`
 * item forces 9:16), the thumbnail recipe node seeded with the item's brief —
 * and stamps the video's `roadmapItemId` back-link, which is what lets the
 * editor's assistant see the channel strategy behind the workflow. Both
 * branches apply the profile: linking an existing video is not a downgrade.
 */
export function assignRoadmapItem(
  itemId: string,
  input: { projectId?: string; videoId?: string }
): {
  item: NicheRoadmapItem
  videoId: string
  projectId: string
  thumbnailNodeId: string | null
} {
  const row = getRoadmapRow(itemId)
  const niche = getNicheRow(row.nicheId)
  let videoId: string
  let projectId: string

  if (input.videoId) {
    const video = getVideo(input.videoId)
    if (!video) throw new Error(`Unknown videoId "${input.videoId}".`)
    videoId = video.id
    projectId = video.projectId
  } else {
    if (!input.projectId) {
      throw new Error(
        'Provide a projectId (to create the workflow) or a videoId (to link an existing one).'
      )
    }
    videoId = createVideo(input.projectId, row.title).id
    projectId = input.projectId
  }

  // The niche's production profile shapes the workflow — created OR linked.
  if (niche.styleId) setVideoStyle(videoId, niche.styleId)
  const aspectRatio = row.videoType === 'short' ? '9:16' : niche.aspectRatio
  if (aspectRatio) setVideoDefaults(videoId, { defaultAspectRatio: aspectRatio })
  const thumbnailNodeId = row.thumbnailBrief
    ? ensureThumbnailNode(videoId, row.thumbnailBrief, row.videoType)
    : null
  getDb().update(videos).set({ roadmapItemId: itemId }).where(eq(videos.id, videoId)).run()

  const next = {
    videoId,
    status: (row.status === 'published' ? 'published' : 'in_production') as RoadmapStatus,
    updatedAt: Date.now()
  }
  getDb().update(nicheRoadmapItems).set(next).where(eq(nicheRoadmapItems.id, itemId)).run()
  broadcastNichesChanged()
  return { item: toRoadmapItem({ ...row, ...next }), videoId, projectId, thumbnailNodeId }
}

/**
 * Everything the assistant should know when it works on a video born from the
 * roadmap (§7b): the item (angle, evidence, packaging), the niche's brief and
 * production profile — target_seconds included, the field write_scenario needs
 * — and the niche's voice personas. Null when the video has no back-link.
 */
export function getRoadmapContextForVideo(videoId: string): {
  niche: Niche
  item: NicheRoadmapItem
  voicePersonas: VoicePersona[]
} | null {
  const db = getDb()
  const video = db.select().from(videos).where(eq(videos.id, videoId)).get()
  if (!video?.roadmapItemId) return null
  const item = db
    .select()
    .from(nicheRoadmapItems)
    .where(eq(nicheRoadmapItems.id, video.roadmapItemId))
    .get()
  if (!item) return null
  const niche = db.select().from(niches).where(eq(niches.id, item.nicheId)).get()
  if (!niche) return null
  return {
    niche: toNiche(niche),
    item: toRoadmapItem(item),
    voicePersonas: listVoicePersonas(niche.id)
  }
}

/** Paste the live URL once uploaded — ties the item to the niche's tracking. */
export function markRoadmapPublished(itemId: string, url: string): NicheRoadmapItem {
  const row = getRoadmapRow(itemId)
  const publishedVideoId = parseYoutubeVideoUrl(url)
  if (!publishedVideoId) {
    throw new Error(`Cannot parse "${url}" as a YouTube video URL or id.`)
  }
  const next = { publishedVideoId, status: 'published' as RoadmapStatus, updatedAt: Date.now() }
  getDb().update(nicheRoadmapItems).set(next).where(eq(nicheRoadmapItems.id, itemId)).run()
  broadcastNichesChanged()
  return toRoadmapItem({ ...row, ...next })
}

// ---------------------------------------------------------------------------
// Startup auto-refresh
// ---------------------------------------------------------------------------

const STALE_AFTER_MS = 24 * 3600 * 1000

/**
 * Called shortly after startup (main/index.ts): silently refresh every niche
 * whose data is older than 24 h. Sequential on purpose (shared YouTube
 * quota), and every failure is logged instead of thrown — a stale niche is
 * an inconvenience, a startup crash is not.
 */
export async function autoRefreshStaleNiches(): Promise<void> {
  if (!nicheKeysStatus().youtubeConfigured) return
  const db = getDb()
  for (const niche of db.select().from(niches).all()) {
    const channels = db
      .select({ lastRefreshedAt: nicheChannels.lastRefreshedAt })
      .from(nicheChannels)
      .where(eq(nicheChannels.nicheId, niche.id))
      .all()
    if (channels.length === 0) continue
    const latest = channels.reduce<number | null>(
      (max, c) =>
        c.lastRefreshedAt !== null && (max === null || c.lastRefreshedAt > max)
          ? c.lastRefreshedAt
          : max,
      null
    )
    if (latest !== null && Date.now() - latest < STALE_AFTER_MS) continue
    try {
      await refreshNiche(niche.id)
    } catch (error) {
      logWarn('niches', `auto-refresh failed for "${niche.name}": ${String(error)}`)
    }
  }
}
