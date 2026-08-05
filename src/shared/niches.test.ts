import { describe, expect, it } from 'vitest'
import {
  batchIds,
  channelAgeMonths,
  clampBlockDepth,
  computeChannelAggregates,
  DEFAULT_NICHE_FILTERS,
  extractCaptionTracks,
  extractPlayerResponse,
  extractSerpVideos,
  filterNicheVideos,
  formatTranscriptWithTimestamps,
  HIDDEN_SUBSCRIBERS,
  matchesLanguageFilter,
  mergeSearchResults,
  nicheRatio,
  normalizeSearchParam,
  parseChannelListResponse,
  parseChannelRef,
  parseIsoDuration,
  parsePlaylistItemsResponse,
  parseTimedTextJson3,
  parseVideoListResponse,
  parseYoutubeSuggestResponse,
  parseYoutubeVideoUrl,
  pickCaptionTrack,
  ratioSignal,
  serpTaskError,
  serpTaskItems,
  SP_PRESETS,
  spPresetRaw,
  transcriptToText,
  type ChannelStats,
  type NicheScoredVideo,
  type VideoMeta
} from './niches'

const NOW = new Date('2026-08-01T00:00:00Z')

function video(overrides: Partial<NicheScoredVideo>): NicheScoredVideo {
  return {
    videoId: 'v1',
    title: 'A video',
    description: '',
    url: 'https://www.youtube.com/watch?v=v1',
    thumbnail: '',
    publishedAt: '2026-06-01T00:00:00Z',
    views: 50_000,
    durationSeconds: 600,
    madeForKids: false,
    channelId: 'UCaaaaaaaaaa',
    channelTitle: 'Chan',
    channelUrl: '',
    channelThumbnail: '',
    channelSubscribers: 1_000,
    channelVideoCount: 10,
    channelViewCount: 100_000,
    channelCreatedAt: '2026-01-01T00:00:00Z',
    language: null,
    ...overrides
  }
}

describe('normalizeSearchParam', () => {
  it('double-encodes a raw base64 value with the sp= prefix', () => {
    expect(normalizeSearchParam('CAMSBggEEAEYBQ==')).toBe('sp=CAMSBggEEAEYBQ%253D%253D')
  })

  it('accepts an already singly-encoded value', () => {
    expect(normalizeSearchParam('CAMSBggEEAEYBQ%3D%3D')).toBe('sp=CAMSBggEEAEYBQ%253D%253D')
  })

  it('accepts an already doubly-encoded value', () => {
    expect(normalizeSearchParam('CAMSBggEEAEYBQ%253D%253D')).toBe('sp=CAMSBggEEAEYBQ%253D%253D')
  })

  it('extracts sp from a full YouTube URL', () => {
    expect(
      normalizeSearchParam('https://www.youtube.com/results?search_query=test&sp=CAMSAhAB')
    ).toBe('sp=CAMSAhAB')
  })

  it('strips an existing sp= prefix', () => {
    expect(normalizeSearchParam('sp=CAASAhAB')).toBe('sp=CAASAhAB')
  })

  it('returns undefined for empty input', () => {
    expect(normalizeSearchParam('')).toBeUndefined()
    expect(normalizeSearchParam('   ')).toBeUndefined()
    expect(normalizeSearchParam(null)).toBeUndefined()
    expect(normalizeSearchParam(undefined)).toBeUndefined()
  })

  it('survives a value that throws on decode', () => {
    expect(normalizeSearchParam('%E0%A4%A')).toBe(
      `sp=${encodeURIComponent(encodeURIComponent('%E0%A4%A'))}`
    )
  })
})

describe('spPresetRaw', () => {
  it('resolves every declared preset', () => {
    for (const preset of SP_PRESETS) expect(spPresetRaw(preset.id)).toBe(preset.raw)
  })

  it('returns undefined for unknown ids', () => {
    expect(spPresetRaw('nope')).toBeUndefined()
  })
})

describe('clampBlockDepth', () => {
  it('rounds to the billing block of 20 and clamps to 20..700', () => {
    expect(clampBlockDepth(100)).toBe(100)
    expect(clampBlockDepth(29)).toBe(20)
    expect(clampBlockDepth(31)).toBe(40)
    expect(clampBlockDepth(1)).toBe(20)
    expect(clampBlockDepth(9999)).toBe(700)
    expect(clampBlockDepth(NaN)).toBe(100)
  })
})

describe('extractSerpVideos', () => {
  it('keeps only video items with both ids and fills fallbacks', () => {
    const items = [
      { type: 'youtube_channel', channel_id: 'UCx' },
      {
        type: 'youtube_video',
        video_id: 'abc12345678',
        channel_id: 'UCabc',
        title: 'T',
        views_count: '1,234'
      },
      {
        type: 'video',
        video_id: 'def12345678',
        channel_id: 'UCdef',
        views_count: 42,
        url: 'u',
        thumbnail_url: 't',
        publish_date: '2026-01-02'
      },
      { type: 'youtube_video', video_id: '', channel_id: 'UCzz' },
      'garbage'
    ]
    const out = extractSerpVideos(items)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      videoId: 'abc12345678',
      views: 1234,
      url: 'https://www.youtube.com/watch?v=abc12345678',
      thumbnail: 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg',
      publishedAt: null
    })
    expect(out[1]).toMatchObject({ views: 42, url: 'u', thumbnail: 't', publishedAt: '2026-01-02' })
  })

  it('returns [] on non-array input', () => {
    expect(extractSerpVideos(undefined)).toEqual([])
    expect(extractSerpVideos({})).toEqual([])
  })
})

describe('parseYoutubeSuggestResponse', () => {
  it('parses the JSONP payload into suggestion strings', () => {
    const raw =
      'window.google.ac.h(["learn english",[["learn english",0,[512]],["learn english with tv series",0,[512]],["  ",0],[42,0]],{"k":1}])'
    expect(parseYoutubeSuggestResponse(raw)).toEqual([
      'learn english',
      'learn english with tv series'
    ])
  })

  it('returns [] on malformed payloads', () => {
    expect(parseYoutubeSuggestResponse('')).toEqual([])
    expect(parseYoutubeSuggestResponse('nope')).toEqual([])
    expect(parseYoutubeSuggestResponse('f(broken')).toEqual([])
    expect(parseYoutubeSuggestResponse('f({"a":1})')).toEqual([])
  })
})

describe('serpTaskError / serpTaskItems', () => {
  it('detects a task-level error inside an HTTP 200', () => {
    expect(
      serpTaskError({ tasks: [{ status_code: 40501, status_message: 'Invalid field' }] })
    ).toBe('Invalid field')
    expect(serpTaskError({ tasks: [{ status_code: 40000 }] })).toBe('DataForSEO error 40000')
  })

  it('accepts a healthy task', () => {
    expect(serpTaskError({ tasks: [{ status_code: 20000 }] })).toBeNull()
  })

  it('rejects an empty body', () => {
    expect(serpTaskError({})).toMatch(/empty/)
  })

  it('digs the items out of the nested result', () => {
    const items = [{ type: 'youtube_video' }]
    expect(serpTaskItems({ tasks: [{ result: [{ items }] }] })).toBe(items)
    expect(serpTaskItems({})).toBeUndefined()
  })
})

describe('parseChannelListResponse', () => {
  it('parses stats, handle url and hidden subscribers', () => {
    const out = parseChannelListResponse({
      items: [
        {
          id: 'UCabc',
          snippet: {
            title: 'Chan',
            description: 'About',
            customUrl: '@chan',
            publishedAt: '2025-01-01T00:00:00Z',
            thumbnails: { medium: { url: 'm.jpg' }, default: { url: 'd.jpg' } }
          },
          statistics: { subscriberCount: '1200', videoCount: '34', viewCount: '99000' },
          contentDetails: { relatedPlaylists: { uploads: 'UUabc' } }
        },
        {
          id: 'UChidden',
          snippet: {},
          statistics: { hiddenSubscriberCount: true, subscriberCount: '5' }
        }
      ]
    })
    expect(out[0]).toMatchObject({
      channelId: 'UCabc',
      subscribers: 1200,
      videoCount: 34,
      viewCount: 99000,
      url: 'https://www.youtube.com/@chan',
      thumbnail: 'm.jpg',
      createdAt: '2025-01-01T00:00:00Z',
      uploadsPlaylistId: 'UUabc'
    })
    expect(out[1]!.subscribers).toBe(HIDDEN_SUBSCRIBERS)
    expect(out[1]!.url).toBe('https://www.youtube.com/channel/UChidden')
    expect(out[1]!.uploadsPlaylistId).toBeNull()
  })

  it('returns [] on malformed bodies', () => {
    expect(parseChannelListResponse(null)).toEqual([])
    expect(parseChannelListResponse({ items: [{}] })).toEqual([])
  })
})

describe('parseIsoDuration', () => {
  it('parses hours/minutes/seconds', () => {
    expect(parseIsoDuration('PT1H23M45S')).toBe(5025)
    expect(parseIsoDuration('PT4M')).toBe(240)
    expect(parseIsoDuration('PT58S')).toBe(58)
    expect(parseIsoDuration('P1DT2H')).toBe(93600)
  })

  it('returns 0 for unknown formats', () => {
    expect(parseIsoDuration('P0D')).toBe(0)
    expect(parseIsoDuration('garbage')).toBe(0)
    expect(parseIsoDuration(null)).toBe(0)
    expect(parseIsoDuration('')).toBe(0)
  })
})

describe('parseVideoListResponse', () => {
  it('parses duration, kids flag and stats', () => {
    const out = parseVideoListResponse({
      items: [
        {
          id: 'vid00000001',
          snippet: {
            title: 'V',
            description: 'D',
            publishedAt: '2026-02-01T00:00:00Z',
            defaultAudioLanguage: 'en-US'
          },
          contentDetails: { duration: 'PT10M' },
          status: { madeForKids: false, selfDeclaredMadeForKids: true },
          statistics: { viewCount: '777', likeCount: '9' }
        }
      ]
    })
    expect(out[0]).toMatchObject({
      videoId: 'vid00000001',
      durationSeconds: 600,
      madeForKids: true,
      views: 777,
      likeCount: 9,
      thumbnail: 'https://i.ytimg.com/vi/vid00000001/hqdefault.jpg',
      language: 'en-US'
    })
  })

  it('returns [] on malformed bodies', () => {
    expect(parseVideoListResponse(undefined)).toEqual([])
  })
})

describe('parsePlaylistItemsResponse', () => {
  it('extracts video refs and the next page token', () => {
    const out = parsePlaylistItemsResponse({
      items: [
        { contentDetails: { videoId: 'a', videoPublishedAt: '2026-01-01T00:00:00Z' } },
        { contentDetails: {} },
        { contentDetails: { videoId: 'b' } }
      ],
      nextPageToken: 'TOK'
    })
    expect(out.videos).toEqual([
      { videoId: 'a', publishedAt: '2026-01-01T00:00:00Z' },
      { videoId: 'b', publishedAt: null }
    ])
    expect(out.nextPageToken).toBe('TOK')
    expect(parsePlaylistItemsResponse({}).nextPageToken).toBeNull()
  })
})

describe('batchIds', () => {
  it('dedupes, drops empties and batches by 50', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i % 60}`)
    const batches = batchIds([...ids, ''])
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(50)
    expect(batches[1]).toHaveLength(10)
  })
})

describe('parseChannelRef', () => {
  it('parses ids, handles and URL forms', () => {
    expect(parseChannelRef('UCabcdefghijklm')).toEqual({ kind: 'id', value: 'UCabcdefghijklm' })
    expect(parseChannelRef('@finance')).toEqual({ kind: 'handle', value: '@finance' })
    expect(parseChannelRef('finance')).toEqual({ kind: 'handle', value: '@finance' })
    expect(parseChannelRef('https://www.youtube.com/channel/UCabcdefghijklm')).toEqual({
      kind: 'id',
      value: 'UCabcdefghijklm'
    })
    expect(parseChannelRef('https://youtube.com/@finance?si=x')).toEqual({
      kind: 'handle',
      value: '@finance'
    })
    expect(parseChannelRef('https://www.youtube.com/c/FinanceTV')).toEqual({
      kind: 'handle',
      value: '@FinanceTV'
    })
    expect(parseChannelRef('https://www.youtube.com/user/oldname')).toEqual({
      kind: 'handle',
      value: '@oldname'
    })
  })

  it('rejects empty or hopeless input', () => {
    expect(parseChannelRef('')).toBeNull()
    expect(parseChannelRef('  ')).toBeNull()
    expect(parseChannelRef('a b c')).toBeNull()
  })
})

describe('parseYoutubeVideoUrl', () => {
  it('parses every URL form and the bare id', () => {
    expect(parseYoutubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseYoutubeVideoUrl('https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=1')).toBe(
      'dQw4w9WgXcQ'
    )
    expect(parseYoutubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ')
    expect(parseYoutubeVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseYoutubeVideoUrl('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('rejects garbage', () => {
    expect(parseYoutubeVideoUrl('')).toBeNull()
    expect(parseYoutubeVideoUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(parseYoutubeVideoUrl('not-an-id')).toBeNull()
  })
})

describe('nicheRatio / ratioSignal', () => {
  it('handles the edge cases', () => {
    expect(nicheRatio(0, 100)).toBe(0)
    expect(nicheRatio(500, 0)).toBe(Infinity)
    expect(nicheRatio(500, HIDDEN_SUBSCRIBERS)).toBe(Infinity)
    expect(nicheRatio(500, 100)).toBe(5)
  })

  it('maps ratios to signals', () => {
    expect(ratioSignal(15)).toBe('strong')
    expect(ratioSignal(Infinity)).toBe('strong')
    expect(ratioSignal(5)).toBe('interesting')
    expect(ratioSignal(1)).toBe('neutral')
    expect(ratioSignal(0)).toBe('neutral')
  })
})

describe('channelAgeMonths', () => {
  it('computes months since creation', () => {
    const age = channelAgeMonths('2026-02-01T00:00:00Z', NOW)
    expect(age).toBeGreaterThan(5.5)
    expect(age).toBeLessThan(6.5)
  })

  it('returns null when unknown', () => {
    expect(channelAgeMonths(null, NOW)).toBeNull()
    expect(channelAgeMonths('garbage', NOW)).toBeNull()
  })
})

describe('filterNicheVideos', () => {
  it('dedupes by videoId', () => {
    const out = filterNicheVideos([video({}), video({})], { ...DEFAULT_NICHE_FILTERS }, NOW)
    expect(out).toHaveLength(1)
  })

  it('long format keeps unknown durations, short excludes them', () => {
    const unknown = video({ videoId: 'u', durationSeconds: 0 })
    const short = video({ videoId: 's', durationSeconds: 60 })
    const long = video({ videoId: 'l', durationSeconds: 600 })
    const base = { ...DEFAULT_NICHE_FILTERS, maxSubscribers: null, maxChannelAgeMonths: null }
    expect(
      filterNicheVideos([unknown, short, long], { ...base, format: 'long' }, NOW).map(
        (v) => v.videoId
      )
    ).toEqual(expect.arrayContaining(['u', 'l']))
    expect(
      filterNicheVideos([unknown, short, long], { ...base, format: 'short' }, NOW).map(
        (v) => v.videoId
      )
    ).toEqual(['s'])
    expect(filterNicheVideos([unknown, short, long], { ...base, format: 'all' }, NOW)).toHaveLength(
      3
    )
  })

  it('applies subscriber cap but lets hidden counts through', () => {
    const big = video({ videoId: 'big', channelSubscribers: 500_000 })
    const hidden = video({ videoId: 'hid', channelSubscribers: HIDDEN_SUBSCRIBERS })
    const out = filterNicheVideos([big, hidden], DEFAULT_NICHE_FILTERS, NOW)
    expect(out.map((v) => v.videoId)).toEqual(['hid'])
  })

  it('applies channel age, view floor and kids filters', () => {
    const old = video({ videoId: 'old', channelCreatedAt: '2020-01-01T00:00:00Z' })
    const fresh = video({ videoId: 'new' })
    const lowViews = video({ videoId: 'low', views: 10 })
    const kids = video({ videoId: 'kids', madeForKids: true })
    expect(
      filterNicheVideos(
        [old, fresh],
        { ...DEFAULT_NICHE_FILTERS, maxChannelAgeMonths: 12 },
        NOW
      ).map((v) => v.videoId)
    ).toEqual(['new'])
    expect(
      filterNicheVideos(
        [fresh, lowViews],
        { ...DEFAULT_NICHE_FILTERS, minViews: 1000, sort: 'views' },
        NOW
      ).map((v) => v.videoId)
    ).toEqual(['new'])
    expect(
      filterNicheVideos(
        [fresh, kids],
        { ...DEFAULT_NICHE_FILTERS, madeForKidsOnly: true },
        NOW
      ).map((v) => v.videoId)
    ).toEqual(['kids'])
  })

  it('sorts by ratio with Infinity first, then views, then date', () => {
    const inf = video({ videoId: 'inf', views: 100, channelSubscribers: 0 })
    const ten = video({ videoId: 'ten', views: 10_000, channelSubscribers: 1_000 })
    const two = video({ videoId: 'two', views: 2_000, channelSubscribers: 1_000 })
    const filters = { ...DEFAULT_NICHE_FILTERS, maxSubscribers: null, maxChannelAgeMonths: null }
    expect(filterNicheVideos([two, ten, inf], filters, NOW).map((v) => v.videoId)).toEqual([
      'inf',
      'ten',
      'two'
    ])
    expect(
      filterNicheVideos([two, ten, inf], { ...filters, sort: 'views' }, NOW).map((v) => v.videoId)
    ).toEqual(['ten', 'two', 'inf'])
    const older = video({ videoId: 'older', publishedAt: '2024-01-01T00:00:00Z' })
    const newer = video({ videoId: 'newer', publishedAt: '2026-07-01T00:00:00Z' })
    const noDate = video({ videoId: 'nodate', publishedAt: null })
    expect(
      filterNicheVideos([older, noDate, newer], { ...filters, sort: 'date' }, NOW).map(
        (v) => v.videoId
      )
    ).toEqual(['newer', 'older', 'nodate'])
  })
})

describe('matchesLanguageFilter', () => {
  it('trusts the declared audio language, region subtags ignored', () => {
    expect(matchesLanguageFilter('en', { language: 'en-US', title: 'whatever' })).toBe(true)
    expect(matchesLanguageFilter('en', { language: 'hi', title: 'English title' })).toBe(false)
    expect(matchesLanguageFilter('fr', { language: 'fr-CA', title: '' })).toBe(true)
  })

  it('falls back to the title script when the language is undeclared', () => {
    expect(
      matchesLanguageFilter('en', { language: null, title: 'The subprime crisis explained' })
    ).toBe(true)
    // The "US search full of Hindi content" case: Devanagari title, no metadata.
    expect(
      matchesLanguageFilter('en', { language: null, title: 'दुनिया की सबसे रहस्यमयी घटनाएं' })
    ).toBe(false)
    expect(
      matchesLanguageFilter('en', { language: null, title: '„Приховані факти історії"' })
    ).toBe(false)
    // A few foreign characters in a Latin title do not exclude it.
    expect(
      matchesLanguageFilter('en', { language: null, title: 'Tokyo 東京 street food tour' })
    ).toBe(true)
  })

  it('keeps unknowns for non-Latin filter languages and empty titles', () => {
    expect(matchesLanguageFilter('ja', { language: null, title: 'Latin words only' })).toBe(true)
    expect(matchesLanguageFilter('en', { language: null, title: '12345 !!!' })).toBe(true)
  })

  it('is applied by the filter pipeline', () => {
    const en = video({ videoId: 'en', language: 'en' })
    const hi = video({ videoId: 'hi', language: 'hi' })
    const devanagari = video({ videoId: 'dev', title: 'रहस्यमयी घटनाएं की कहानी', language: null })
    const filters = {
      ...DEFAULT_NICHE_FILTERS,
      maxSubscribers: null,
      maxChannelAgeMonths: null,
      language: 'en'
    }
    expect(filterNicheVideos([en, hi, devanagari], filters, NOW).map((v) => v.videoId)).toEqual([
      'en'
    ])
  })
})

describe('mergeSearchResults', () => {
  const channel: ChannelStats = {
    channelId: 'UCabc',
    title: 'Chan',
    description: '',
    handle: '@chan',
    url: 'https://www.youtube.com/@chan',
    thumbnail: 'c.jpg',
    subscribers: 1000,
    videoCount: 10,
    viewCount: 50_000,
    createdAt: '2025-06-01T00:00:00Z',
    uploadsPlaylistId: 'UUabc'
  }
  const meta: VideoMeta = {
    videoId: 'vid1',
    title: 'From API',
    description: 'Full description',
    publishedAt: '2026-03-01T00:00:00Z',
    thumbnail: 't.jpg',
    views: 999,
    likeCount: 3,
    durationSeconds: 600,
    madeForKids: false,
    language: 'en'
  }

  it('joins by channel and video id', () => {
    const [out] = mergeSearchResults(
      [
        {
          videoId: 'vid1',
          channelId: 'UCabc',
          channelTitle: 'serp chan',
          channelUrl: 'serp-url',
          title: 'serp title',
          description: 'serp desc',
          url: 'u',
          thumbnail: 'th',
          publishedAt: '2026-01-01',
          views: 5000
        }
      ],
      [channel],
      [meta]
    )
    expect(out).toMatchObject({
      title: 'From API',
      description: 'Full description',
      views: 5000,
      durationSeconds: 600,
      channelSubscribers: 1000,
      channelCreatedAt: '2025-06-01T00:00:00Z',
      language: 'en'
    })
  })

  it('fills zeros for a missing channel instead of dropping the video', () => {
    const [out] = mergeSearchResults(
      [
        {
          videoId: 'vid2',
          channelId: 'UCgone',
          channelTitle: 'Gone',
          channelUrl: 'g',
          title: 'T',
          description: '',
          url: 'u',
          thumbnail: 'th',
          publishedAt: null,
          views: 100
        }
      ],
      [channel],
      []
    )
    expect(out!.channelSubscribers).toBe(0)
    expect(out!.channelCreatedAt).toBeNull()
    expect(out!.durationSeconds).toBe(0)
    expect(out!.title).toBe('T')
  })
})

describe('computeChannelAggregates', () => {
  it('handles the empty case', () => {
    expect(computeChannelAggregates([]).videosTracked).toBe(0)
    expect(computeChannelAggregates([]).uploadsPerMonth).toBeNull()
  })

  it('computes totals, median and cadence', () => {
    const out = computeChannelAggregates([
      { views: 100, durationSeconds: 300, publishedAt: '2026-01-01T00:00:00Z' },
      { views: 300, durationSeconds: 0, publishedAt: '2026-03-01T00:00:00Z' },
      { views: 200, durationSeconds: 600, publishedAt: '2026-02-01T00:00:00Z' },
      { views: 400, durationSeconds: 900, publishedAt: null }
    ])
    expect(out.videosTracked).toBe(4)
    expect(out.totalViews).toBe(1000)
    expect(out.avgViews).toBe(250)
    expect(out.medianViews).toBe(250)
    expect(out.avgDurationSeconds).toBe(600)
    expect(out.uploadsPerMonth).toBeGreaterThan(1)
    expect(out.uploadsPerMonth).toBeLessThan(2)
  })

  it('median of odd counts is the middle value', () => {
    const out = computeChannelAggregates([
      { views: 1, durationSeconds: 0, publishedAt: null },
      { views: 100, durationSeconds: 0, publishedAt: null },
      { views: 7, durationSeconds: 0, publishedAt: null }
    ])
    expect(out.medianViews).toBe(7)
    expect(out.uploadsPerMonth).toBeNull()
  })
})

describe('transcripts', () => {
  it('extracts ytInitialPlayerResponse from watch-page HTML', () => {
    const payload = { captions: { note: 'a "quoted" {brace}' }, videoDetails: { videoId: 'x' } }
    const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(payload)};var meta = {};</script>`
    expect(extractPlayerResponse(html)).toEqual(payload)
  })

  it('returns null when the marker or JSON is broken', () => {
    expect(extractPlayerResponse('<html></html>')).toBeNull()
    expect(extractPlayerResponse('ytInitialPlayerResponse = {broken')).toBeNull()
    expect(extractPlayerResponse('ytInitialPlayerResponse = nope')).toBeNull()
  })

  it('extracts caption tracks', () => {
    const tracks = extractCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://a',
              languageCode: 'en',
              kind: 'asr',
              name: { simpleText: 'English (auto)' }
            },
            { baseUrl: 'https://b', languageCode: 'fr', name: { runs: [{ text: 'Français' }] } },
            { languageCode: 'de' }
          ]
        }
      }
    })
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toMatchObject({ kind: 'asr', name: 'English (auto)' })
    expect(tracks[1]).toMatchObject({ kind: null, name: 'Français' })
    expect(extractCaptionTracks({})).toEqual([])
  })

  it('picks human track in preferred language, then asr, then anything', () => {
    const asrEn = { baseUrl: 'a', languageCode: 'en', kind: 'asr', name: '' }
    const humanFr = { baseUrl: 'b', languageCode: 'fr-FR', kind: null, name: '' }
    const humanEn = { baseUrl: 'c', languageCode: 'en-US', kind: null, name: '' }
    expect(pickCaptionTrack([asrEn, humanFr, humanEn], ['en'])).toBe(humanEn)
    expect(pickCaptionTrack([asrEn, humanFr], ['en'])).toBe(asrEn)
    expect(pickCaptionTrack([asrEn, humanFr], ['de'])).toBe(humanFr)
    expect(pickCaptionTrack([asrEn], ['de'])).toBe(asrEn)
    expect(pickCaptionTrack([], ['en'])).toBeNull()
  })

  it('parses json3 timedtext and formats it', () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 1000, segs: [{ utf8: '\n' }] },
        { tStartMs: 65_000, segs: [{ utf8: 'second  line' }] },
        { tStartMs: 2000 }
      ]
    })
    const segments = parseTimedTextJson3(raw)
    expect(segments).toEqual([
      { startMs: 0, text: 'Hello world' },
      { startMs: 65_000, text: 'second line' }
    ])
    expect(transcriptToText(segments)).toBe('Hello world second line')
    expect(formatTranscriptWithTimestamps(segments)).toBe('[0:00] Hello world\n[1:05] second line')
  })

  it('returns [] on malformed timedtext', () => {
    expect(parseTimedTextJson3('not json')).toEqual([])
    expect(parseTimedTextJson3('{}')).toEqual([])
  })
})
