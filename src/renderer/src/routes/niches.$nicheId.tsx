import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Captions, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HIDDEN_SUBSCRIBERS } from '@shared/niches'
import { STYLES } from '@shared/styles/registry'
import type {
  NicheChannel,
  NicheChannelAggregates,
  NicheVideoFiltersInput,
  VideoAspectRatio
} from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { RoadmapSection } from '@renderer/features/niches/RoadmapSection'
import { compactNumber, formatSubscribers, VideoRow } from '@renderer/features/niches/VideoRow'
import { invoke } from '@renderer/lib/ipc'
import { relativeTime } from '@renderer/lib/relativeTime'

export const Route = createFileRoute('/niches/$nicheId')({
  component: NicheDetailPage
})

/**
 * One niche, arranged top-down by importance: header (stats + refresh state +
 * actions) → positioning brief → channels (mine vs competitors, with the
 * tracked-video indicators) → the scored video list. Keyword hunting lives on
 * the /niches page — from there "+ Track" feeds channels into this niche.
 */
function NicheDetailPage(): React.JSX.Element {
  const { nicheId } = Route.useParams()
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const queryClient = useQueryClient()

  const detail = useQuery({
    queryKey: ['niches', nicheId],
    queryFn: () => invoke('niches:get', { nicheId })
  })

  // Brief (positioning notes) — saved on demand, synced from the server value.
  const [brief, setBrief] = useState('')
  useEffect(() => {
    setBrief(detail.data?.niche.description ?? '')
  }, [detail.data?.niche.description])

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['niches'] })
  }
  const saveBrief = useMutation({
    mutationFn: (description: string) =>
      invoke('niches:update', { nicheId, description: description.trim() || null }),
    onSuccess: invalidate
  })
  // Production profile — saved as soon as a control changes.
  const saveProfile = useMutation({
    mutationFn: (patch: {
      styleId?: string | null
      aspectRatio?: VideoAspectRatio | null
      targetSeconds?: number | null
    }) => invoke('niches:update', { nicheId, ...patch }),
    onSuccess: invalidate,
    onError: (err) => toast.error(err.message)
  })

  // Channels
  const [channelRef, setChannelRef] = useState('')
  const [asMine, setAsMine] = useState(false)
  const addChannel = useMutation({
    mutationFn: () =>
      invoke('niches:addChannel', { nicheId, ref: channelRef.trim(), isMine: asMine }),
    onSuccess: () => {
      setChannelRef('')
      setAsMine(false)
      invalidate()
    },
    onError: (err) => toast.error(err.message)
  })
  const removeChannel = useMutation({
    mutationFn: (nicheChannelId: string) => invoke('niches:removeChannel', { nicheChannelId }),
    onSuccess: invalidate
  })
  const toggleMine = useMutation({
    mutationFn: (input: { nicheChannelId: string; isMine: boolean }) =>
      invoke('niches:updateChannel', input),
    onSuccess: invalidate
  })

  // Refresh + transcripts
  const refresh = useMutation({
    mutationFn: () => invoke('niches:refresh', { nicheId }),
    onSuccess: (result) => {
      invalidate()
      toast.success(
        t('niches.refreshResult', {
          channels: result.channelsRefreshed,
          added: result.videosAdded,
          updated: result.videosUpdated
        })
      )
    },
    onError: (err) => toast.error(err.message)
  })
  const fetchTranscripts = useMutation({
    mutationFn: () => invoke('niches:fetchTranscripts', { nicheId }),
    onSuccess: (result) => {
      invalidate()
      toast.success(
        t('niches.transcriptsResult', {
          fetched: result.fetched,
          failed: result.failed.length,
          remaining: result.remaining
        })
      )
    },
    onError: (err) => toast.error(err.message)
  })

  // Tracked videos + filters
  const [format, setFormat] = useState<'all' | 'long' | 'short'>('long')
  const [sort, setSort] = useState<'ratio' | 'views' | 'date'>('ratio')
  const [smallChannels, setSmallChannels] = useState(false)
  const [youngChannels, setYoungChannels] = useState(false)
  const filters: NicheVideoFiltersInput = {
    format,
    sort,
    maxSubscribers: smallChannels ? 100_000 : null,
    maxChannelAgeMonths: youngChannels ? 12 : null
  }
  const videos = useQuery({
    queryKey: ['niches', nicheId, 'videos', filters],
    queryFn: () => invoke('niches:videos', { nicheId, filters })
  })

  // Transcript viewer
  const [transcriptOf, setTranscriptOf] = useState<string | null>(null)
  const transcript = useQuery({
    queryKey: ['niches', 'transcript', transcriptOf],
    queryFn: () => invoke('niches:getTranscript', { nicheVideoId: transcriptOf as string }),
    enabled: transcriptOf !== null
  })

  if (!detail.data) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-500" />
      </div>
    )
  }
  const { niche, channels, aggregates, videoCount } = detail.data
  const mine = channels.filter((c) => c.isMine)
  const competitors = channels.filter((c) => !c.isMine)
  const lastRefreshedAt = channels.reduce<number | null>(
    (latest, c) =>
      c.lastRefreshedAt !== null && (latest === null || c.lastRefreshedAt > latest)
        ? c.lastRefreshedAt
        : latest,
    null
  )

  const channelCard = (channel: NicheChannel): React.JSX.Element => (
    <ChannelCard
      key={channel.id}
      channel={channel}
      aggregates={aggregates[channel.channelId]}
      onToggleMine={() =>
        toggleMine.mutate({ nicheChannelId: channel.id, isMine: !channel.isMine })
      }
      onRemove={() => {
        void confirmModal({
          message: t('niches.removeChannelConfirm', { name: channel.title }),
          confirmLabel: t('niches.delete'),
          danger: true
        }).then((accepted) => {
          if (accepted) removeChannel.mutate(channel.id)
        })
      }}
    />
  )

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      {/* ── Header: identity, freshness, actions ── */}
      <div>
        <Link to="/niches" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← {t('niches.title')}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-100">{niche.name}</h1>
            <p className="mt-1 text-xs text-neutral-500">
              {t('niches.channelCount', { count: channels.length })} ·{' '}
              {t('niches.videoCount', { count: videoCount })} ·{' '}
              {lastRefreshedAt !== null ? (
                t('niches.lastRefresh', { when: relativeTime(t, lastRefreshedAt) })
              ) : (
                <span className="text-warning">{t('niches.neverRefreshed')}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => fetchTranscripts.mutate()}
              disabled={fetchTranscripts.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              {fetchTranscripts.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Captions className="h-4 w-4" />
              )}{' '}
              {t('niches.fetchTranscripts')}
            </button>
            <button
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`} />{' '}
              {t('niches.refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* ── Positioning brief — the field the assistant maintains too ── */}
      <div className="island flex flex-col gap-2 p-4">
        <label className="text-xs text-neutral-400">{t('niches.briefLabel')}</label>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={t('niches.briefPlaceholder')}
          rows={2}
          className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
        />
        {brief !== (niche.description ?? '') && (
          <div>
            <button
              onClick={() => saveBrief.mutate(brief)}
              disabled={saveBrief.isPending}
              className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
            >
              {t('niches.briefSave')}
            </button>
          </div>
        )}
        {/* Production profile — shapes every workflow the roadmap creates. */}
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-neutral-800/60 pt-3">
          <span className="text-xs text-neutral-400" title={t('niches.profile.hint')}>
            {t('niches.profile.title')}
          </span>
          <select
            value={niche.styleId ?? ''}
            onChange={(e) => saveProfile.mutate({ styleId: e.target.value || null })}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300"
          >
            <option value="">{t('niches.profile.styleNone')}</option>
            {STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label}
              </option>
            ))}
          </select>
          <select
            value={niche.aspectRatio ?? ''}
            onChange={(e) =>
              saveProfile.mutate({
                aspectRatio: (e.target.value || null) as VideoAspectRatio | null
              })
            }
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300"
          >
            <option value="">{t('niches.profile.aspectAny')}</option>
            {(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const).map((aspect) => (
              <option key={aspect} value={aspect}>
                {aspect}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            defaultValue={niche.targetSeconds ?? ''}
            key={`target-${niche.targetSeconds ?? 'none'}`}
            placeholder={t('niches.profile.targetPlaceholder')}
            title={t('niches.profile.hint')}
            onBlur={(e) => {
              const value = Number(e.target.value)
              const next = Number.isFinite(value) && value > 0 ? Math.round(value) : null
              if (next !== niche.targetSeconds) saveProfile.mutate({ targetSeconds: next })
            }}
            className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <RoadmapSection nicheId={nicheId} />

      {/* ── Channels: add, then mine / competitors ── */}
      <section className="flex flex-col gap-3">
        <form
          className="island flex items-center gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (channelRef.trim()) addChannel.mutate()
          }}
        >
          <Plus className="h-4 w-4 shrink-0 text-neutral-500" />
          <input
            value={channelRef}
            onChange={(e) => setChannelRef(e.target.value)}
            placeholder={t('niches.addChannelPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
            <input type="checkbox" checked={asMine} onChange={(e) => setAsMine(e.target.checked)} />
            {t('niches.addAsMine')}
          </label>
          <button
            type="submit"
            disabled={addChannel.isPending || channelRef.trim() === ''}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
          >
            {addChannel.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('niches.addChannel')}
          </button>
        </form>

        {mine.length > 0 && (
          <>
            <h2 className="text-sm font-medium text-neutral-300">
              {t('niches.myChannels')}{' '}
              <span className="font-normal text-neutral-500">({mine.length})</span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {mine.map(channelCard)}
            </div>
          </>
        )}
        {competitors.length > 0 && (
          <>
            <h2 className="text-sm font-medium text-neutral-300">
              {t('niches.competitors')}{' '}
              <span className="font-normal text-neutral-500">({competitors.length})</span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {competitors.map(channelCard)}
            </div>
          </>
        )}
      </section>

      {/* ── Tracked videos ── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-300">
            {t('niches.videos')}{' '}
            <span className="font-normal text-neutral-500">
              {videos.data && t('niches.shown', { shown: videos.data.length, total: videoCount })}
            </span>
          </h2>
          <div className="flex-1" />
          {(
            [
              ['format-all', 'all', t('niches.filters.formatAll')],
              ['format-long', 'long', t('niches.filters.formatLong')],
              ['format-short', 'short', t('niches.filters.formatShort')]
            ] as const
          ).map(([key, value, label]) => (
            <button
              key={key}
              onClick={() => setFormat(value)}
              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                format === value
                  ? 'bg-accent font-medium text-neutral-900'
                  : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setSmallChannels((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              smallChannels
                ? 'bg-accent font-medium text-neutral-900'
                : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {t('niches.filters.smallChannels')}
          </button>
          <button
            onClick={() => setYoungChannels((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              youngChannels
                ? 'bg-accent font-medium text-neutral-900'
                : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {t('niches.filters.youngChannels')}
          </button>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'ratio' | 'views' | 'date')}
            className="cursor-pointer appearance-none rounded-full bg-neutral-800/80 px-2.5 py-1 text-[11px] text-neutral-300 hover:text-neutral-100 focus:outline-none"
          >
            <option value="ratio">{t('niches.filters.sortRatio')}</option>
            <option value="views">{t('niches.filters.sortViews')}</option>
            <option value="date">{t('niches.filters.sortDate')}</option>
          </select>
        </div>
        {videos.isPending ? (
          <div className="island flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
          </div>
        ) : videos.data?.length === 0 ? (
          <p className="text-sm italic text-neutral-500">{t('niches.noVideos')}</p>
        ) : (
          <div className="island overflow-hidden">
            {(videos.data ?? []).map((video) => (
              <VideoRow
                key={video.id}
                video={{
                  key: video.id,
                  nicheVideoId: video.id,
                  title: video.title,
                  url: video.url,
                  thumbnail: video.thumbnail,
                  channelTitle: video.channelTitle,
                  views: video.views,
                  durationSeconds: video.durationSeconds,
                  publishedAt: video.publishedAt,
                  channelSubscribers: video.channelSubscribers,
                  hasTranscript: video.hasTranscript
                }}
                onTranscript={setTranscriptOf}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Transcript viewer ── */}
      {transcriptOf !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
          onClick={() => setTranscriptOf(null)}
        >
          <div
            className="island flex max-h-full w-full max-w-2xl flex-col gap-3 overflow-hidden p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="line-clamp-1 text-sm font-medium text-neutral-100">
                {transcript.data?.title ?? t('niches.transcriptTitle')}
              </h3>
              <button
                onClick={() => setTranscriptOf(null)}
                title={t('niches.close')}
                className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-300">
              {transcript.isPending ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
                </div>
              ) : (
                (transcript.data?.transcript ?? t('niches.noTranscript'))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One tracked channel: identity, channel-wide stats, and the indicators
 * computed over the videos tracked in THIS niche (count, median views,
 * upload cadence). The mine/competitor toggle is always visible — it is the
 * axis every niche analysis compares along.
 */
function ChannelCard({
  channel,
  aggregates,
  onToggleMine,
  onRemove
}: {
  channel: NicheChannel
  aggregates: NicheChannelAggregates | undefined
  onToggleMine: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="island group flex items-start gap-3 p-3">
      {channel.thumbnail ? (
        <img src={channel.thumbnail} alt="" className="h-10 w-10 shrink-0 rounded-full" />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a
            href={channel.url}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-1 text-sm text-neutral-200 hover:text-accent"
          >
            {channel.title}
          </a>
          {channel.isMine && (
            <span className="shrink-0 rounded-full bg-highlight-soft px-1.5 py-0.5 text-[10px] font-medium text-neutral-900">
              {t('niches.mineBadge')}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">
          {formatSubscribers(channel.subscribers, t('niches.subsHidden'))}{' '}
          {channel.subscribers !== HIDDEN_SUBSCRIBERS && t('niches.subsShort')} ·{' '}
          {t('niches.videoCount', { count: channel.videoCount })}
        </p>
        {aggregates && aggregates.videosTracked > 0 && (
          <p className="mt-0.5 text-[11px] text-neutral-600">
            {t('niches.aggTracked', { count: aggregates.videosTracked })} ·{' '}
            {t('niches.aggMedian', { label: compactNumber.format(aggregates.medianViews) })}
            {aggregates.uploadsPerMonth !== null &&
              ` · ${t('niches.aggCadence', {
                label: aggregates.uploadsPerMonth.toFixed(1)
              })}`}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-3">
          <button
            onClick={onToggleMine}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            {channel.isMine ? t('niches.makeCompetitor') : t('niches.makeMine')}
          </button>
          <button
            onClick={onRemove}
            className="text-[11px] text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
          >
            {t('niches.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
