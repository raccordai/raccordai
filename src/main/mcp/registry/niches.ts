import {
  analyzeSerpOpportunity,
  channelRatioSignal,
  combineSignals,
  nicheRatio,
  ratioSignal,
  SP_PRESETS
} from '@shared/niches'
import * as niches from '../../services/niches'
import { feedPreview, nicheThumbnails } from '../../services/nicheVisuals'
import { fetchSearchSuggestions } from '../../services/youtubeApi'
import { obj, str, type AgentTool } from './types'

/** YouTube niche research (§7) and the production roadmap (§7b). */
export const nicheTools: AgentTool[] = [
  {
    name: 'list_niches',
    description:
      'The YouTube niches under watch: name, positioning brief, tracked channel/video counts. A niche is a watchlist of competitor channels plus the user’s own, refreshed on demand. Details: docs "niches".',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => niches.listNiches()
  },
  {
    name: 'get_niche',
    description:
      'One niche in full: brief, tracked channels (subscribers, age, isMine) and per-channel aggregates over the tracked videos (avg/median views, upload cadence). The starting point of any niche analysis.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheId }) => {
      const { aggregates, ...detail } = niches.getNiche(String(nicheId))
      return {
        ...detail,
        channels: detail.channels.map((c) => ({ ...c, aggregates: aggregates[c.channelId] }))
      }
    }
  },
  {
    name: 'create_niche',
    description:
      'Create a niche watchlist. languageCode/locationCode are the DataForSEO defaults for its keyword searches (2840=US, 2250=FR…). Put the positioning brief in description — you own that field.',
    inputSchema: obj(
      {
        name: str(),
        description: str('Positioning brief / angle notes — the assistant maintains this.'),
        languageCode: str('Default "en".'),
        locationCode: {
          type: 'number',
          description: 'DataForSEO location code, default 2840 (US).'
        }
      },
      ['name']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ name, description, languageCode, locationCode }) =>
      niches.createNiche({
        name: String(name),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(languageCode !== undefined ? { languageCode: String(languageCode) } : {}),
        ...(locationCode !== undefined ? { locationCode: Number(locationCode) } : {})
      })
  },
  {
    name: 'update_niche',
    description:
      'Rename a niche, rewrite its positioning brief (description), or set its PRODUCTION PROFILE (style_id from docs "styles", aspect_ratio, target_seconds) — the profile shapes every workflow created from the roadmap.',
    inputSchema: obj(
      {
        nicheId: str(),
        name: str(),
        description: str(),
        languageCode: str(),
        location_code: {
          type: 'number',
          description: 'DataForSEO location code (2840=US, 2250=FR…).'
        },
        style_id: str('A Raccord style template id (docs "styles"), or empty to clear.'),
        aspect_ratio: str('16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9'),
        target_seconds: { type: 'number', description: 'Target video length in seconds.' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      nicheId,
      name,
      description,
      languageCode,
      location_code,
      style_id,
      aspect_ratio,
      target_seconds
    }) =>
      niches.updateNiche(String(nicheId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(languageCode !== undefined ? { languageCode: String(languageCode) } : {}),
        ...(location_code !== undefined ? { locationCode: Number(location_code) } : {}),
        ...(style_id !== undefined ? { styleId: String(style_id) || null } : {}),
        ...(aspect_ratio !== undefined ? { aspectRatio: String(aspect_ratio) || null } : {}),
        ...(target_seconds !== undefined ? { targetSeconds: Number(target_seconds) || null } : {})
      })
  },
  {
    name: 'delete_niche',
    description:
      'Delete a niche and everything tracked in it (channels, videos, transcripts). Unrecoverable.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nicheId }) => niches.deleteNiche(String(nicheId))
  },
  {
    name: 'add_niche_channel',
    description:
      'Track a YouTube channel in a niche, by id (UC…), @handle or URL. Set is_mine=true for the user’s own channels — analyses compare "mine" against the rest. Stats come back immediately; run refresh_niche to pull its videos.',
    inputSchema: obj(
      {
        nicheId: str(),
        ref: str('Channel id, @handle or youtube.com URL.'),
        is_mine: { type: 'boolean', description: 'True for the user’s own channel.' },
        notes: str()
      },
      ['nicheId', 'ref']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, ref, is_mine, notes }) =>
      niches.addChannel({
        nicheId: String(nicheId),
        ref: String(ref),
        ...(is_mine !== undefined ? { isMine: Boolean(is_mine) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'update_niche_channel',
    description: 'Toggle a tracked channel’s is_mine flag or rewrite its notes.',
    inputSchema: obj({ nicheChannelId: str(), is_mine: { type: 'boolean' }, notes: str() }, [
      'nicheChannelId'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheChannelId, is_mine, notes }) =>
      niches.updateChannel(String(nicheChannelId), {
        ...(is_mine !== undefined ? { isMine: Boolean(is_mine) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'remove_niche_channel',
    description:
      'Stop tracking a channel. Its channel-sourced videos (and their transcripts) are deleted with it; keyword-search finds survive.',
    inputSchema: obj({ nicheChannelId: str() }, ['nicheChannelId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nicheChannelId }) => niches.removeChannel(String(nicheChannelId))
  },
  {
    name: 'refresh_niche',
    description:
      'Pull fresh data for a whole niche: channel stats, latest uploads of every tracked channel, and updated stats of every tracked video. Free (YouTube quota only, ~1 unit per 50 items). Run it before an analysis session.',
    inputSchema: obj(
      {
        nicheId: str(),
        videos_per_channel: {
          type: 'number',
          description: 'Latest uploads to track per channel (default 30).'
        }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, videos_per_channel }) =>
      niches.refreshNiche(
        String(nicheId),
        videos_per_channel !== undefined ? Number(videos_per_channel) : undefined
      )
  },
  {
    name: 'list_niche_videos',
    description:
      'Tracked videos of a niche, scored through three outlier lenses: ratio = views/subscribers (null = hidden subs, very strong), channel_ratio = views vs the channel’s own median, views_per_day = velocity; `signal` combines the first two. Filters: format, max_subscribers, max_channel_age_months, min_views, sort. Lens semantics: docs "niches".',
    inputSchema: obj(
      {
        nicheId: str(),
        format: str('long | short | all (default long).'),
        max_subscribers: { type: 'number' },
        max_channel_age_months: { type: 'number' },
        min_views: { type: 'number' },
        sort: str('ratio | views | date (default ratio).'),
        language: str('BCP-47 primary subtag (en, fr…) — best-effort audio-language filter.'),
        limit: { type: 'number', description: 'Default 200.' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({
      nicheId,
      format,
      max_subscribers,
      max_channel_age_months,
      min_views,
      sort,
      language,
      limit
    }) =>
      niches
        .listNicheVideos(
          String(nicheId),
          {
            ...(format !== undefined ? { format: format as 'all' | 'long' | 'short' } : {}),
            ...(max_subscribers !== undefined ? { maxSubscribers: Number(max_subscribers) } : {}),
            ...(max_channel_age_months !== undefined
              ? { maxChannelAgeMonths: Number(max_channel_age_months) }
              : {}),
            ...(min_views !== undefined ? { minViews: Number(min_views) } : {}),
            ...(sort !== undefined ? { sort: sort as 'ratio' | 'views' | 'date' } : {}),
            ...(language !== undefined ? { language: String(language) } : {})
          },
          limit !== undefined ? Number(limit) : undefined
        )
        .map((v) => {
          const ratio = nicheRatio(v.views, v.channelSubscribers)
          return {
            ...v,
            ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
            channelRatio: v.channelRatio === null ? null : Math.round(v.channelRatio * 100) / 100,
            viewsPerDay: v.viewsPerDay === null ? null : Math.round(v.viewsPerDay),
            signal: combineSignals(ratioSignal(ratio), channelRatioSignal(v.channelRatio))
          }
        })
  },
  {
    name: 'get_niche_video',
    description:
      'One tracked video in full: description AND transcript (when fetched — run fetch_niche_transcripts first). This is the raw material for topic analysis and video ideas.',
    inputSchema: obj({ nicheVideoId: str() }, ['nicheVideoId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheVideoId }) => niches.getNicheVideoDetail(String(nicheVideoId))
  },
  {
    name: 'get_niche_thumbnails',
    description:
      'SEE the niche’s packaging: the strongest tracked videos’ thumbnails as inline images (best outlier signal first), each with its title, channel, views and ratio in the text part. Read it before writing a thumbnail_brief — the visual language the niche actually clicks on.',
    inputSchema: obj(
      {
        nicheId: str(),
        format: { type: 'string', enum: ['all', 'long', 'short'] },
        limit: { type: 'number', description: 'Thumbnails to fetch (default 8, max 12).' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheId, format, limit }) =>
      nicheThumbnails(String(nicheId), {
        ...(format === 'all' || format === 'long' || format === 'short' ? { format } : {}),
        ...(typeof limit === 'number' ? { limit } : {})
      })
  },
  {
    name: 'get_feed_preview',
    description:
      'The feed test as images: image 1 is the video’s candidate thumbnail (its thumbnail recipe node), followed by the niche’s strongest competitor thumbnails, with the roadmap item’s title variants in the text part. Judge legibility, contrast and differentiation at feed size, then iterate the thumbnail node or the titles. Needs the video assigned to a roadmap item.',
    inputSchema: obj(
      {
        videoId: str(),
        competitors: { type: 'number', description: 'Competitor thumbnails (default 6, max 12).' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId, competitors }) =>
      feedPreview(String(videoId), {
        ...(typeof competitors === 'number' ? { competitors } : {})
      })
  },
  {
    name: 'fetch_niche_transcripts',
    description:
      'Fetch missing transcripts (YouTube captions, human track preferred) for a niche’s tracked videos, most-viewed first. Videos without captions are marked resolved and listed in "failed". Batch of `limit` (default 10) per call; "remaining" says how many are left.',
    inputSchema: obj(
      {
        nicheId: str(),
        video_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these YouTube video ids.'
        },
        limit: { type: 'number' }
      },
      ['nicheId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nicheId, video_ids, limit }) =>
      niches.fetchTranscripts({
        nicheId: String(nicheId),
        ...(Array.isArray(video_ids) ? { videoIds: video_ids.map(String) } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {})
      })
  },
  {
    name: 'niche_keyword_search',
    description: `Hunt niche videos on a keyword: DataForSEO scrapes the real YouTube SERP (native filters via search_param presets: ${SP_PRESETS.map((p) => p.id).join(', ')}), the YouTube API enriches, results come back scored (views/subscribers). save=true adds the hits to the niche. Paid per 20 results on DataForSEO’s side.`,
    inputSchema: obj(
      {
        keyword: str(),
        nicheId: str(
          'Optional — required with save=true; also provides default location/language.'
        ),
        depth: { type: 'number', description: '20–700 results, billed per 20 (default 100).' },
        search_param: str('An sp preset id, a raw sp value or a filtered YouTube URL.'),
        location_code: { type: 'number' },
        language_code: str(),
        save: { type: 'boolean', description: 'Save the hits into the niche (source "search").' }
      },
      ['keyword']
    ),
    scope: 'global',
    risk: 'write',
    execute: async ({
      keyword,
      nicheId,
      depth,
      search_param,
      location_code,
      language_code,
      save
    }) => {
      const result = await niches.keywordSearch({
        keyword: String(keyword),
        ...(nicheId !== undefined ? { nicheId: String(nicheId) } : {}),
        ...(depth !== undefined ? { depth: Number(depth) } : {}),
        ...(search_param !== undefined ? { searchParam: String(search_param) } : {}),
        ...(location_code !== undefined ? { locationCode: Number(location_code) } : {}),
        ...(language_code !== undefined ? { languageCode: String(language_code) } : {}),
        ...(save !== undefined ? { save: Boolean(save) } : {})
      })
      return {
        ...result,
        /** The SERP landscape at a glance — approachable/contested/saturated. */
        opportunity: analyzeSerpOpportunity(result.videos, new Date()),
        videos: result.videos.map((v) => {
          const ratio = nicheRatio(v.views, v.channelSubscribers)
          return {
            ...v,
            ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
            signal: ratioSignal(ratio)
          }
        })
      }
    }
  },

  {
    name: 'youtube_keyword_suggestions',
    description:
      'YouTube search autocomplete for a seed query — the real "what people type" demand signal. FREE and unlimited: expand seeds recursively here, then spend niche_keyword_search (paid) only on the best 2-3 keywords.',
    inputSchema: obj(
      {
        query: str('Seed keyword, e.g. "learn english".'),
        language_code: str('Interface language for suggestions (default en).')
      },
      ['query']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ query, language_code }) =>
      fetchSearchSuggestions(
        String(query),
        language_code !== undefined ? String(language_code) : 'en'
      )
  },

  // ── Roadmap (§7b): the videos to make, idea → workflow → published ────────
  {
    name: 'list_roadmap',
    description:
      'The niche’s video roadmap: ideas with angle, evidence, title/description drafts, thumbnail brief, status (idea | in_production | published) and the assigned workflow. Published items carry live views vs the niche median.',
    inputSchema: obj({ nicheId: str() }, ['nicheId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nicheId }) => niches.listRoadmap(String(nicheId))
  },
  {
    name: 'add_roadmap_item',
    description:
      'Add a video idea to the niche roadmap. ALWAYS ground it: evidence must cite the tracked videos proving demand (title, ratio, views). Write the YouTube title AND 5-10 title_variants (packaging-first: the click is decided at ideation), the description draft, and a thumbnail_brief (subject + emotion + 2-4 word overlay) — it seeds the thumbnail node on assignment. Method: docs "niches".',
    inputSchema: obj(
      {
        nicheId: str(),
        title: str('The YouTube title — punchy, curiosity-driven, in the niche’s language.'),
        title_variants: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Candidate titles (max 20) — different promises/angles, not rewordings. The user promotes one to `title`.'
        },
        angle: str('One-line pitch: what makes this video different.'),
        description: str('YouTube description draft.'),
        thumbnail_brief: str('Prompt brief for the thumbnail recipe node.'),
        evidence: str('The tracked videos proving demand, with ratio and views.'),
        video_type: str('long (default) | short')
      },
      ['nicheId', 'title']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      nicheId,
      title,
      title_variants,
      angle,
      description,
      thumbnail_brief,
      evidence,
      video_type
    }) =>
      niches.addRoadmapItem({
        nicheId: String(nicheId),
        title: String(title),
        ...(Array.isArray(title_variants) ? { titleVariants: title_variants.map(String) } : {}),
        ...(angle !== undefined ? { angle: String(angle) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(thumbnail_brief !== undefined ? { thumbnailBrief: String(thumbnail_brief) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence) } : {}),
        ...(video_type !== undefined ? { videoType: video_type as 'long' | 'short' } : {})
      })
  },
  {
    name: 'update_roadmap_item',
    description:
      'Rewrite a roadmap item’s title/title_variants/angle/description/thumbnail brief/evidence, or move its status. Use it to iterate on titles and descriptions when the user asks for variants.',
    inputSchema: obj(
      {
        itemId: str(),
        title: str(),
        title_variants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Candidate titles (max 20); empty array clears the list.'
        },
        angle: str(),
        description: str(),
        thumbnail_brief: str(),
        evidence: str(),
        video_type: str('long | short'),
        status: str('idea | in_production | published'),
        sort_order: { type: 'number', description: 'Position in the roadmap.' }
      },
      ['itemId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({
      itemId,
      title,
      title_variants,
      angle,
      description,
      thumbnail_brief,
      evidence,
      video_type,
      status,
      sort_order
    }) =>
      niches.updateRoadmapItem(String(itemId), {
        ...(title !== undefined ? { title: String(title) } : {}),
        ...(Array.isArray(title_variants) ? { titleVariants: title_variants.map(String) } : {}),
        ...(angle !== undefined ? { angle: String(angle) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(thumbnail_brief !== undefined ? { thumbnailBrief: String(thumbnail_brief) } : {}),
        ...(evidence !== undefined ? { evidence: String(evidence) } : {}),
        ...(video_type !== undefined ? { videoType: video_type as 'long' | 'short' } : {}),
        ...(status !== undefined
          ? { status: status as 'idea' | 'in_production' | 'published' }
          : {}),
        ...(sort_order !== undefined ? { sortOrder: Number(sort_order) } : {})
      })
  },
  {
    name: 'delete_roadmap_item',
    description: 'Delete a roadmap idea. The assigned Raccord video (if any) is NOT touched.',
    inputSchema: obj({ itemId: str() }, ['itemId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ itemId }) => niches.deleteRoadmapItem(String(itemId))
  },
  {
    name: 'assign_roadmap_item',
    description:
      'Idea → workflow: creates the Raccord video (or links video_id), applies the niche’s production profile (a `short` forces 9:16, vertical thumbnail included), seeds the thumbnail node from the brief and stamps the video↔item back-link — the editor assistant then receives the niche context automatically. Then write_scenario (angle + evidence transcripts as brief, niche target_seconds).',
    inputSchema: obj(
      {
        itemId: str(),
        project_id: str('Project to create the workflow in (omit when passing video_id).'),
        video_id: str('Link an existing Raccord video instead of creating one.')
      },
      ['itemId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ itemId, project_id, video_id }) =>
      niches.assignRoadmapItem(String(itemId), {
        ...(project_id !== undefined ? { projectId: String(project_id) } : {}),
        ...(video_id !== undefined ? { videoId: String(video_id) } : {})
      })
  },
  {
    name: 'mark_roadmap_published',
    description:
      'Mark a roadmap item live: pass the YouTube URL (or id). If the channel is tracked in the niche (is_mine), the item reports its views against the niche median on the next refresh.',
    inputSchema: obj({ itemId: str(), url: str('YouTube watch/shorts URL or the video id.') }, [
      'itemId',
      'url'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ itemId, url }) => niches.markRoadmapPublished(String(itemId), String(url))
  }
]
