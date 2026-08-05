import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelStats, VideoMeta } from '@shared/niches'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject } from './projects'
import { createVideo, getVideo } from './videos'
import {
  addChannel,
  addRoadmapItem,
  assignRoadmapItem,
  autoRefreshStaleNiches,
  channelAggregates,
  createNiche,
  deleteNiche,
  deleteRoadmapItem,
  fetchTranscripts,
  getNiche,
  getNicheVideoDetail,
  getTranscript,
  keywordSearch,
  listNiches,
  listNicheVideos,
  listRoadmap,
  markRoadmapPublished,
  refreshNiche,
  removeChannel,
  updateChannel,
  updateNiche,
  updateRoadmapItem
} from './niches'

vi.mock('./youtubeApi', () => ({
  fetchChannelsByIds: vi.fn(),
  fetchChannelByHandle: vi.fn(),
  fetchVideosMeta: vi.fn(),
  fetchUploads: vi.fn()
}))
vi.mock('./dataforseo', () => ({ searchYoutubeSerp: vi.fn() }))
vi.mock('./youtubeTranscript', () => ({ fetchTranscript: vi.fn() }))

import { searchYoutubeSerp } from './dataforseo'
import {
  fetchChannelByHandle,
  fetchChannelsByIds,
  fetchUploads,
  fetchVideosMeta
} from './youtubeApi'
import { fetchTranscript } from './youtubeTranscript'

const CHANNEL: ChannelStats = {
  channelId: 'UCfinance0001',
  title: 'Finance Simplified',
  description: 'Money explained',
  handle: '@finance',
  url: 'https://www.youtube.com/@finance',
  thumbnail: 'https://thumb/c.jpg',
  subscribers: 4_000,
  videoCount: 12,
  viewCount: 900_000,
  createdAt: '2026-01-01T00:00:00Z',
  uploadsPlaylistId: 'UUfinance0001'
}

function meta(videoId: string, overrides: Partial<VideoMeta> = {}): VideoMeta {
  return {
    videoId,
    title: `Video ${videoId}`,
    description: 'About money',
    publishedAt: '2026-05-01T00:00:00Z',
    thumbnail: `https://thumb/${videoId}.jpg`,
    views: 50_000,
    likeCount: 100,
    durationSeconds: 600,
    madeForKids: false,
    language: null,
    ...overrides
  }
}

beforeEach(() => {
  useTestDatabase()
  vi.mocked(fetchChannelsByIds).mockReset()
  vi.mocked(fetchChannelByHandle).mockReset()
  vi.mocked(fetchVideosMeta).mockReset()
  vi.mocked(fetchUploads).mockReset()
  vi.mocked(searchYoutubeSerp).mockReset()
  vi.mocked(fetchTranscript).mockReset()
})

afterEach(() => resetTestDatabase())

async function seedNicheWithChannel(): Promise<{ nicheId: string; channelRowId: string }> {
  const niche = createNiche({ name: 'Finance EN' })
  vi.mocked(fetchChannelByHandle).mockResolvedValue(CHANNEL)
  const channel = await addChannel({ nicheId: niche.id, ref: '@finance', isMine: false })
  return { nicheId: niche.id, channelRowId: channel.id }
}

describe('niche CRUD', () => {
  it('creates with defaults, lists with counts, updates and deletes', async () => {
    const niche = createNiche({ name: 'Finance EN', description: 'US retail investors' })
    expect(niche).toMatchObject({ languageCode: 'en', locationCode: 2840 })

    vi.mocked(fetchChannelByHandle).mockResolvedValue(CHANNEL)
    await addChannel({ nicheId: niche.id, ref: '@finance', isMine: true })

    const [overview] = listNiches()
    expect(overview).toMatchObject({ channelCount: 1, mineChannelCount: 1, videoCount: 0 })

    const renamed = updateNiche(niche.id, { name: 'Finance US', description: null })
    expect(renamed.name).toBe('Finance US')
    expect(renamed.description).toBeNull()

    deleteNiche(niche.id)
    expect(listNiches()).toHaveLength(0)
  })

  it('rejects unknown niche ids', () => {
    expect(() => getNiche('nope')).toThrow(/Unknown nicheId/)
  })
})

describe('channels', () => {
  it('resolves a handle, rejects duplicates and unparseable refs', async () => {
    const { nicheId } = await seedNicheWithChannel()
    const { channels } = getNiche(nicheId)
    expect(channels[0]).toMatchObject({
      channelId: CHANNEL.channelId,
      title: CHANNEL.title,
      subscribers: 4_000,
      isMine: false
    })

    vi.mocked(fetchChannelByHandle).mockResolvedValue(CHANNEL)
    await expect(addChannel({ nicheId, ref: '@finance' })).rejects.toThrow(/already tracked/)
    await expect(addChannel({ nicheId, ref: 'a b c' })).rejects.toThrow(/Cannot parse/)
  })

  it('resolves a raw channel id through fetchChannelsByIds', async () => {
    const niche = createNiche({ name: 'N' })
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    const added = await addChannel({ nicheId: niche.id, ref: CHANNEL.channelId })
    expect(added.channelId).toBe(CHANNEL.channelId)
    expect(vi.mocked(fetchChannelsByIds)).toHaveBeenCalledWith([CHANNEL.channelId], {
      units: expect.any(Number)
    })
  })

  it('throws when the channel does not exist on YouTube', async () => {
    const niche = createNiche({ name: 'N' })
    vi.mocked(fetchChannelByHandle).mockResolvedValue(null)
    await expect(addChannel({ nicheId: niche.id, ref: '@ghost' })).rejects.toThrow(/not found/)
  })

  it('toggles isMine and edits notes', async () => {
    const { channelRowId } = await seedNicheWithChannel()
    const updated = updateChannel(channelRowId, { isMine: true, notes: 'main channel' })
    expect(updated).toMatchObject({ isMine: true, notes: 'main channel' })
    expect(() => updateChannel('nope', {})).toThrow(/Unknown nicheChannelId/)
  })
})

describe('refreshNiche', () => {
  it('pulls stats, tracks uploads and refreshes existing rows', async () => {
    const { nicheId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([{ ...CHANNEL, subscribers: 5_000 }])
    vi.mocked(fetchUploads).mockResolvedValue([
      { videoId: 'vid1', publishedAt: '2026-05-01T00:00:00Z' },
      { videoId: 'vid2', publishedAt: '2026-06-01T00:00:00Z' }
    ])
    vi.mocked(fetchVideosMeta).mockResolvedValue([meta('vid1'), meta('vid2', { views: 80_000 })])

    const first = await refreshNiche(nicheId)
    expect(first).toMatchObject({ channelsRefreshed: 1, videosAdded: 2 })

    const { channels } = getNiche(nicheId)
    expect(channels[0]?.subscribers).toBe(5_000)

    // Second pass: same uploads, fresher views — updates, never duplicates.
    vi.mocked(fetchVideosMeta).mockResolvedValue([
      meta('vid1', { views: 60_000 }),
      meta('vid2', { views: 90_000 })
    ])
    const second = await refreshNiche(nicheId)
    expect(second.videosAdded).toBe(0)
    expect(second.videosUpdated).toBeGreaterThan(0)

    const videos = listNicheVideos(nicheId)
    expect(videos).toHaveLength(2)
    expect(videos.find((v) => v.videoId === 'vid1')?.views).toBe(60_000)
  })

  it('keeps last known stats when a channel disappeared from the API', async () => {
    const { nicheId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([])
    vi.mocked(fetchVideosMeta).mockResolvedValue([])
    const result = await refreshNiche(nicheId)
    expect(result.channelsRefreshed).toBe(0)
    expect(getNiche(nicheId).channels[0]?.subscribers).toBe(4_000)
  })
})

describe('listNicheVideos', () => {
  async function seedVideos(): Promise<string> {
    const { nicheId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    vi.mocked(fetchUploads).mockResolvedValue([
      { videoId: 'long1', publishedAt: null },
      { videoId: 'short1', publishedAt: null }
    ])
    vi.mocked(fetchVideosMeta).mockResolvedValue([
      meta('long1', { views: 100_000, durationSeconds: 700 }),
      meta('short1', { views: 500, durationSeconds: 45 })
    ])
    await refreshNiche(nicheId)
    return nicheId
  }

  it('applies format filter and ratio sort, defaults to long-form', async () => {
    const nicheId = await seedVideos()
    expect(listNicheVideos(nicheId).map((v) => v.videoId)).toEqual(['long1'])
    expect(listNicheVideos(nicheId, { format: 'all' })).toHaveLength(2)
    expect(listNicheVideos(nicheId, { format: 'short' }).map((v) => v.videoId)).toEqual(['short1'])
    expect(listNicheVideos(nicheId, { format: 'all', sort: 'views' })[0]?.videoId).toBe('long1')
  })

  it('honours the limit', async () => {
    const nicheId = await seedVideos()
    expect(listNicheVideos(nicheId, { format: 'all' }, 1)).toHaveLength(1)
  })
})

describe('keywordSearch', () => {
  const SERP = [
    {
      videoId: 'hit1',
      channelId: CHANNEL.channelId,
      channelTitle: 'serp name',
      channelUrl: 'serp-url',
      title: 'Subprime crisis explained',
      description: 'serp desc',
      url: 'https://www.youtube.com/watch?v=hit1',
      thumbnail: 'https://thumb/hit1.jpg',
      publishedAt: '2026-04-01',
      views: 120_000
    }
  ]

  it('merges SERP with enrichment and saves into the niche once', async () => {
    const niche = createNiche({ name: 'N' })
    vi.mocked(searchYoutubeSerp).mockResolvedValue(SERP)
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    vi.mocked(fetchVideosMeta).mockResolvedValue([meta('hit1', { views: 130_000 })])

    const result = await keywordSearch({ keyword: 'subprime', nicheId: niche.id, save: true })
    expect(result.videos[0]).toMatchObject({
      videoId: 'hit1',
      views: 120_000,
      channelSubscribers: 4_000
    })
    expect(result.saved).toBe(1)

    // Saved rows carry the source and keyword; a re-save is a no-op.
    const [video] = listNicheVideos(niche.id)
    expect(video).toMatchObject({ source: 'search', keyword: 'subprime' })
    const again = await keywordSearch({ keyword: 'subprime', nicheId: niche.id, save: true })
    expect(again.saved).toBe(0)
  })

  it('uses the niche defaults for location and language', async () => {
    const niche = createNiche({ name: 'N', languageCode: 'fr', locationCode: 2250 })
    vi.mocked(searchYoutubeSerp).mockResolvedValue([])
    vi.mocked(fetchChannelsByIds).mockResolvedValue([])
    vi.mocked(fetchVideosMeta).mockResolvedValue([])
    await keywordSearch({ keyword: 'bourse', nicheId: niche.id })
    expect(vi.mocked(searchYoutubeSerp)).toHaveBeenCalledWith(
      expect.objectContaining({ locationCode: 2250, languageCode: 'fr' })
    )
  })

  it('refuses save without a niche', async () => {
    await expect(keywordSearch({ keyword: 'x', save: true })).rejects.toThrow(/requires a nicheId/)
  })
})

describe('transcripts', () => {
  it('fetches missing transcripts, marks captionless videos resolved', async () => {
    const { nicheId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    vi.mocked(fetchUploads).mockResolvedValue([
      { videoId: 'vid1', publishedAt: null },
      { videoId: 'vid2', publishedAt: null }
    ])
    vi.mocked(fetchVideosMeta).mockResolvedValue([meta('vid1'), meta('vid2')])
    await refreshNiche(nicheId)

    vi.mocked(fetchTranscript).mockImplementation((videoId: string) =>
      Promise.resolve(
        videoId === 'vid1'
          ? {
              segments: [{ startMs: 0, text: 'Hello world' }],
              languageCode: 'en',
              autoGenerated: false
            }
          : null
      )
    )
    const result = await fetchTranscripts({ nicheId })
    expect(result).toMatchObject({ fetched: 1, failed: ['vid2'], remaining: 0 })

    const videos = listNicheVideos(nicheId)
    const withTranscript = videos.find((v) => v.videoId === 'vid1')
    expect(withTranscript?.hasTranscript).toBe(true)
    expect(getTranscript(withTranscript?.id ?? '').transcript).toContain('Hello world')
    expect(getNicheVideoDetail(withTranscript?.id ?? '').transcript).toContain('[0:00]')

    // Once nothing is left to attempt, a new call RETRIES the failed ones
    // (still captionless here) — but never refetches a stored transcript.
    const second = await fetchTranscripts({ nicheId })
    expect(second).toMatchObject({ fetched: 0, failed: ['vid2'], remaining: 0 })
    expect(vi.mocked(fetchTranscript).mock.calls.filter(([id]) => id === 'vid1')).toHaveLength(1)

    // The retry picks up captions that appeared since.
    vi.mocked(fetchTranscript).mockResolvedValue({
      segments: [{ startMs: 0, text: 'Now captioned' }],
      languageCode: 'en',
      autoGenerated: true
    })
    const third = await fetchTranscripts({ nicheId })
    expect(third).toMatchObject({ fetched: 1, failed: [], remaining: 0 })
  })

  it('rejects unknown video ids', () => {
    expect(() => getTranscript('nope')).toThrow(/Unknown nicheVideoId/)
    expect(() => getNicheVideoDetail('nope')).toThrow(/Unknown nicheVideoId/)
  })
})

describe('channelAggregates + removeChannel', () => {
  it('aggregates per channel and drops channel-sourced videos on untrack', async () => {
    const { nicheId, channelRowId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    vi.mocked(fetchUploads).mockResolvedValue([
      { videoId: 'vid1', publishedAt: null },
      { videoId: 'vid2', publishedAt: null }
    ])
    vi.mocked(fetchVideosMeta).mockResolvedValue([
      meta('vid1', { views: 100 }),
      meta('vid2', { views: 300 })
    ])
    await refreshNiche(nicheId)

    const aggregates = channelAggregates(nicheId)
    expect(aggregates[CHANNEL.channelId]).toMatchObject({
      videosTracked: 2,
      totalViews: 400,
      avgViews: 200
    })

    removeChannel(channelRowId)
    expect(getNiche(nicheId).channels).toHaveLength(0)
    expect(listNicheVideos(nicheId, { format: 'all' })).toHaveLength(0)
    // Removing twice is a no-op.
    removeChannel(channelRowId)
  })
})

describe('roadmap', () => {
  it('adds, lists in order, updates and deletes items', () => {
    const niche = createNiche({ name: 'N' })
    const first = addRoadmapItem({ nicheId: niche.id, title: 'First' })
    const second = addRoadmapItem({
      nicheId: niche.id,
      title: 'Second',
      angle: 'angle',
      videoType: 'short'
    })
    expect(listRoadmap(niche.id).map((i) => i.title)).toEqual(['First', 'Second'])
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder)

    const updated = updateRoadmapItem(second.id, { status: 'in_production', description: 'desc' })
    expect(updated).toMatchObject({
      status: 'in_production',
      description: 'desc',
      videoType: 'short'
    })

    deleteRoadmapItem(first.id)
    expect(listRoadmap(niche.id)).toHaveLength(1)
    expect(() => updateRoadmapItem('nope', {})).toThrow(/Unknown roadmap/)
  })

  it('assign creates the workflow with the production profile and thumbnail node', () => {
    const niche = createNiche({ name: 'N' })
    updateNiche(niche.id, { styleId: 'anime', aspectRatio: '16:9', targetSeconds: 480 })
    const project = createProject('P')
    const item = addRoadmapItem({
      nicheId: niche.id,
      title: 'My video',
      thumbnailBrief: 'A shocked trader in front of a crashing red chart'
    })
    const result = assignRoadmapItem(item.id, { projectId: project.id })
    expect(result.projectId).toBe(project.id)
    expect(result.thumbnailNodeId).toBeTruthy()
    expect(result.item.status).toBe('in_production')
    expect(result.item.projectId).toBe(project.id)
    expect(getVideo(result.videoId)).toMatchObject({
      name: 'My video',
      styleId: 'anime',
      defaultAspectRatio: '16:9'
    })
  })

  it('a short item forces 9:16; assigning without a target throws', () => {
    const niche = createNiche({ name: 'N' })
    const project = createProject('P')
    const item = addRoadmapItem({ nicheId: niche.id, title: 'Short one', videoType: 'short' })
    const result = assignRoadmapItem(item.id, { projectId: project.id })
    expect(getVideo(result.videoId)?.defaultAspectRatio).toBe('9:16')
    // No thumbnail brief → no thumbnail node.
    expect(result.thumbnailNodeId).toBeNull()

    const orphan = addRoadmapItem({ nicheId: niche.id, title: 'X' })
    expect(() => assignRoadmapItem(orphan.id, {})).toThrow(/projectId/)
  })

  it('links an existing workflow without restyling it', () => {
    const niche = createNiche({ name: 'N' })
    updateNiche(niche.id, { styleId: 'anime' })
    const project = createProject('P')
    const video = createVideo(project.id, 'Existing')
    const item = addRoadmapItem({ nicheId: niche.id, title: 'T', thumbnailBrief: 'brief' })
    const result = assignRoadmapItem(item.id, { videoId: video.id })
    expect(result.videoId).toBe(video.id)
    expect(result.thumbnailNodeId).toBeNull()
    expect(getVideo(video.id)?.styleId).toBeNull()
  })

  it('marks published and reports live views against the niche median', async () => {
    const { nicheId } = await seedNicheWithChannel()
    vi.mocked(fetchChannelsByIds).mockResolvedValue([CHANNEL])
    vi.mocked(fetchUploads).mockResolvedValue([
      { videoId: 'dQw4w9WgXcQ', publishedAt: null },
      { videoId: 'other000001', publishedAt: null }
    ])
    vi.mocked(fetchVideosMeta).mockResolvedValue([
      meta('dQw4w9WgXcQ', { views: 5000 }),
      meta('other000001', { views: 1000 })
    ])
    await refreshNiche(nicheId)

    const item = addRoadmapItem({ nicheId, title: 'T' })
    expect(() => markRoadmapPublished(item.id, 'garbage!!!')).toThrow(/Cannot parse/)
    const published = markRoadmapPublished(item.id, 'https://youtu.be/dQw4w9WgXcQ')
    expect(published.status).toBe('published')
    expect(published.published).toMatchObject({ views: 5000, nicheMedianViews: 3000 })

    // An untracked publication stays without stats instead of failing.
    const other = addRoadmapItem({ nicheId, title: 'U' })
    expect(markRoadmapPublished(other.id, 'aaaaaaaaaaa').published).toBeNull()
  })

  it('updateNiche validates the production profile style', () => {
    const niche = createNiche({ name: 'N' })
    expect(() => updateNiche(niche.id, { styleId: 'nope' })).toThrow(/Unknown styleId/)
    expect(updateNiche(niche.id, { targetSeconds: 480 }).targetSeconds).toBe(480)
  })

  it('autoRefreshStaleNiches is a no-op without a YouTube key', async () => {
    createNiche({ name: 'N' })
    await autoRefreshStaleNiches()
    expect(vi.mocked(fetchChannelsByIds)).not.toHaveBeenCalled()
  })
})
