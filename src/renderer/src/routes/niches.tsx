import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useChildMatches, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Loader2, Plus, Search, Telescope } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DATAFORSEO_LOCATIONS,
  filterNicheVideos,
  NICHE_FILTER_LANGUAGES,
  SP_PRESETS,
  type NicheFormat,
  type NicheSort
} from '@shared/niches'
import type { NicheOverview } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { compactNumber, VideoRow } from '@renderer/features/niches/VideoRow'
import { invoke } from '@renderer/lib/ipc'
import { relativeTime } from '@renderer/lib/relativeTime'

export const Route = createFileRoute('/niches')({
  component: NichesRoute
})

function NichesRoute(): React.JSX.Element {
  // The detail route ('/niches/$nicheId') nests under this one; when it
  // matches, hand the viewport over to it (same pattern as the project page).
  const hasChild = useChildMatches().length > 0
  if (hasChild) return <Outlet />
  return <NichesPage />
}

/**
 * YouTube niche research (§7). The keyword hunt is the main content; the
 * niches live in a right-hand column (assistant-sidebar layout) — the
 * selected niche is where the results' "+ track" buttons send channels.
 */
function NichesPage(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const nichesQuery = useQuery({
    queryKey: ['niches'],
    queryFn: () => invoke('niches:list')
  })
  const keys = useQuery({
    queryKey: ['settings', 'settings:nicheKeysStatus'],
    queryFn: () => invoke('settings:nicheKeysStatus')
  })
  const [targetNicheId, setTargetNicheId] = useState('')
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['niches'] })
  }

  return (
    <div className="mx-auto flex max-w-6xl items-start gap-6 px-8 py-10">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
            ← {t('library.title')}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-neutral-100">{t('niches.title')}</h1>
        </div>

        {keys.data && !keys.data.youtubeConfigured && (
          <div className="island px-4 py-3 text-xs text-warning">
            {t('niches.keysMissing')}{' '}
            <Link to="/settings" className="underline hover:text-neutral-200">
              {t('onboarding.bannerCta')}
            </Link>
          </div>
        )}

        <KeywordSearch targetNicheId={targetNicheId} onTracked={invalidate} />
      </div>

      <NichesSidebar
        niches={nichesQuery.data ?? []}
        loading={nichesQuery.isPending}
        targetNicheId={targetNicheId}
        onSelect={setTargetNicheId}
        onChanged={invalidate}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Keyword search — one search row, then one row of preset filter chips
// ---------------------------------------------------------------------------

interface SearchFilters {
  format: NicheFormat
  /** '' = no cap; otherwise the numeric value as a string (select preset). */
  maxSubs: string
  ageMonths: string
  minViews: string
  sort: NicheSort
  /** '' = any; otherwise a BCP-47 primary subtag ('en', 'fr'…). */
  language: string
}

/** The niche-detector defaults: small young channel + long-form + ratio sort. */
const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  format: 'long',
  maxSubs: '100000',
  ageMonths: '12',
  minViews: '',
  sort: 'ratio',
  language: ''
}

const SUBS_PRESETS = ['1000', '10000', '50000', '100000', '500000'] as const
const AGE_PRESETS = ['3', '6', '12', '24'] as const
const VIEWS_PRESETS = ['1000', '10000', '100000'] as const

function toNullableNumber(value: string): number | null {
  const parsed = Number(value)
  return value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Unobtrusive select for the search row (blends into the island). */
const GHOST_SELECT =
  'max-w-36 cursor-pointer truncate rounded-md bg-transparent px-1.5 py-1 text-xs text-neutral-400 hover:text-neutral-200 focus:outline-none'

/** Preset filter chip — same look as the app's filter chips, but a select. */
const CHIP_SELECT =
  'cursor-pointer appearance-none rounded-full bg-neutral-800/80 px-2.5 py-1 text-[11px] text-neutral-300 hover:text-neutral-100 focus:outline-none'

function KeywordSearch({
  targetNicheId,
  onTracked
}: {
  targetNicheId: string
  onTracked: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const toast = useToast()

  const [keyword, setKeyword] = useState('')
  const [preset, setPreset] = useState('nicheHunt')
  const [depth, setDepth] = useState(100)
  const [locationCode, setLocationCode] = useState(2840)
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS)
  const [trackedChannels, setTrackedChannels] = useState<ReadonlySet<string>>(new Set())

  const regionNames = useMemo(
    () => new Intl.DisplayNames(i18n.language, { type: 'region' }),
    [i18n.language]
  )
  const languageNames = useMemo(
    () => new Intl.DisplayNames(i18n.language, { type: 'language' }),
    [i18n.language]
  )

  const search = useMutation({
    mutationFn: () => {
      const location = DATAFORSEO_LOCATIONS.find((l) => l.code === locationCode)
      return invoke('niches:keywordSearch', {
        keyword: keyword.trim(),
        depth,
        searchParam: preset,
        locationCode,
        languageCode: location?.defaultLanguage ?? 'en'
      })
    },
    onSuccess: () => setTrackedChannels(new Set()),
    onError: (err) => toast.error(err.message)
  })

  const trackChannel = useMutation({
    mutationFn: (channelId: string) =>
      invoke('niches:addChannel', { nicheId: targetNicheId, ref: channelId }),
    onSuccess: (channel, channelId) => {
      setTrackedChannels((prev) => new Set(prev).add(channelId))
      onTracked()
      toast.success(t('niches.channelTracked', { name: channel.title }))
    },
    onError: (err) => toast.error(err.message)
  })

  // The filter pipeline runs in memory on the fetched result set — refining
  // costs zero API calls.
  const filtered = useMemo(() => {
    if (!search.data) return []
    return filterNicheVideos(
      search.data.videos,
      {
        format: filters.format,
        maxSubscribers: toNullableNumber(filters.maxSubs),
        maxChannelAgeMonths: toNullableNumber(filters.ageMonths),
        minViews: toNullableNumber(filters.minViews),
        madeForKidsOnly: false,
        sort: filters.sort,
        language: filters.language || null
      },
      new Date()
    )
  }, [search.data, filters])

  const setFilter = (patch: Partial<SearchFilters>): void => setFilters({ ...filters, ...patch })

  return (
    <>
      <form
        className="island flex items-center gap-1.5 py-2 pr-2 pl-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (keyword.trim()) search.mutate()
        }}
      >
        <Search className="h-4 w-4 shrink-0 text-neutral-500" />
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t('niches.keywordPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
        />
        <select
          value={locationCode}
          onChange={(e) => setLocationCode(Number(e.target.value))}
          title={t('niches.locationLabel')}
          className={GHOST_SELECT}
        >
          {DATAFORSEO_LOCATIONS.map((location) => (
            <option key={location.code} value={location.code}>
              {regionNames.of(location.country) ?? location.country}
            </option>
          ))}
        </select>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          title={t('niches.presetLabel')}
          className={GHOST_SELECT}
        >
          {SP_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(`niches.spPresets.${p.id}` as never)}
            </option>
          ))}
        </select>
        <select
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          title={t('niches.depthTitle')}
          className={GHOST_SELECT}
        >
          {[20, 60, 100, 200, 300].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={search.isPending || keyword.trim() === ''}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          {search.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('niches.search')}
        </button>
      </form>

      {search.isPending && (
        <div className="island flex items-center gap-3 px-4 py-5">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent" />
          <div>
            <p className="text-sm text-neutral-200">{t('niches.searching')}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{t('niches.searchingHint')}</p>
          </div>
        </div>
      )}

      {!search.isPending && search.data && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={filters.format}
              onChange={(e) => setFilter({ format: e.target.value as NicheFormat })}
              title={t('niches.filters.format')}
              className={CHIP_SELECT}
            >
              <option value="long">{t('niches.filters.formatLong')}</option>
              <option value="short">{t('niches.filters.formatShort')}</option>
              <option value="all">{t('niches.filters.formatAll')}</option>
            </select>
            <select
              value={filters.maxSubs}
              onChange={(e) => setFilter({ maxSubs: e.target.value })}
              title={t('niches.filters.maxSubs')}
              className={CHIP_SELECT}
            >
              <option value="">{t('niches.filters.subsAny')}</option>
              {SUBS_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {t('niches.filters.subsMax', { label: compactNumber.format(Number(value)) })}
                </option>
              ))}
            </select>
            <select
              value={filters.ageMonths}
              onChange={(e) => setFilter({ ageMonths: e.target.value })}
              title={t('niches.filters.ageMonths')}
              className={CHIP_SELECT}
            >
              <option value="">{t('niches.filters.ageAny')}</option>
              {AGE_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {t('niches.filters.ageMax', { count: Number(value) })}
                </option>
              ))}
            </select>
            <select
              value={filters.minViews}
              onChange={(e) => setFilter({ minViews: e.target.value })}
              title={t('niches.filters.minViews')}
              className={CHIP_SELECT}
            >
              <option value="">{t('niches.filters.viewsAny')}</option>
              {VIEWS_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {t('niches.filters.viewsMin', { label: compactNumber.format(Number(value)) })}
                </option>
              ))}
            </select>
            <select
              value={filters.language}
              onChange={(e) => setFilter({ language: e.target.value })}
              title={t('niches.filters.language')}
              className={CHIP_SELECT}
            >
              <option value="">{t('niches.filters.langAny')}</option>
              {NICHE_FILTER_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {languageNames.of(code) ?? code}
                </option>
              ))}
            </select>
            <select
              value={filters.sort}
              onChange={(e) => setFilter({ sort: e.target.value as NicheSort })}
              title={t('niches.filters.sortBy')}
              className={CHIP_SELECT}
            >
              <option value="ratio">{t('niches.filters.sortRatio')}</option>
              <option value="views">{t('niches.filters.sortViews')}</option>
              <option value="date">{t('niches.filters.sortDate')}</option>
            </select>
            <div className="flex-1" />
            <span className="text-xs text-neutral-500">
              {t('niches.shown', { shown: filtered.length, total: search.data.videos.length })}
            </span>
          </div>

          {filtered.length > 0 && (
            <div className="island overflow-hidden">
              {filtered.slice(0, 100).map((video) => (
                <VideoRow
                  key={video.videoId}
                  video={{
                    key: video.videoId,
                    title: video.title,
                    url: video.url,
                    thumbnail: video.thumbnail || null,
                    channelTitle: video.channelTitle,
                    views: video.views,
                    durationSeconds: video.durationSeconds,
                    publishedAt: video.publishedAt,
                    channelSubscribers: video.channelSubscribers
                  }}
                  trailing={
                    trackedChannels.has(video.channelId) ? (
                      <span className="text-[11px] text-success">✓</span>
                    ) : trackChannel.isPending && trackChannel.variables === video.channelId ? (
                      <span className="px-2 py-1">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                      </span>
                    ) : (
                      <button
                        disabled={targetNicheId === '' || trackChannel.isPending}
                        onClick={() => trackChannel.mutate(video.channelId)}
                        title={targetNicheId === '' ? t('niches.panelHint') : undefined}
                        className="rounded-md bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
                      >
                        + {t('niches.addChannel')}
                      </button>
                    )
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Right-hand niches panel (assistant-sidebar layout)
// ---------------------------------------------------------------------------

function NichesSidebar({
  niches,
  loading,
  targetNicheId,
  onSelect,
  onChanged
}: {
  niches: NicheOverview[]
  loading: boolean
  targetNicheId: string
  onSelect: (nicheId: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const navigate = useNavigate()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: (value: string) => invoke('niches:create', { name: value }),
    onSuccess: (niche) => {
      onChanged()
      onSelect(niche.id)
      setName('')
      setShowForm(false)
    }
  })
  const remove = useMutation({
    mutationFn: (nicheId: string) => invoke('niches:delete', { nicheId }),
    onSuccess: (_result, nicheId) => {
      if (nicheId === targetNicheId) onSelect('')
      onChanged()
    }
  })

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">
          {t('niches.title')}{' '}
          {niches.length > 0 && (
            <span className="font-normal text-neutral-500">{niches.length}</span>
          )}
        </h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          title={t('niches.newNiche')}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-accent-hover"
        >
          <Plus className="h-3.5 w-3.5" /> {t('niches.newNiche')}
        </button>
      </div>
      <p className="text-xs text-neutral-600">{t('niches.panelHint')}</p>

      {showForm && (
        <form
          className="island flex items-center gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate(name.trim())
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('niches.namePlaceholder')}
            className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={create.isPending || name.trim() === ''}
            className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
          >
            {t('niches.create')}
          </button>
        </form>
      )}

      {loading ? (
        // Skeletons — never flash the "no niche yet" empty state while loading.
        <div className="flex flex-col gap-2">
          <div className="island h-20 animate-pulse" />
          <div className="island h-20 animate-pulse" />
        </div>
      ) : niches.length === 0 && !showForm ? (
        <div className="island flex flex-col items-center gap-2 px-4 py-8 text-center">
          <Telescope className="h-8 w-8 text-neutral-700" />
          <p className="text-xs font-medium text-neutral-300">{t('niches.empty')}</p>
          <p className="text-[11px] text-neutral-500">{t('niches.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {niches.map((niche) => (
            <div
              key={niche.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(niche.id === targetNicheId ? '' : niche.id)}
              className={`island group cursor-pointer p-3 transition-colors ${
                niche.id === targetNicheId ? 'border-accent' : 'hover:border-neutral-600'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="line-clamp-1 text-sm font-medium text-neutral-100">
                  {niche.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigate({ to: '/niches/$nicheId', params: { nicheId: niche.id } })
                  }}
                  title={t('niches.open')}
                  className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  {t('niches.open')} <ChevronRight className="h-3 w-3" />
                </button>
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">
                {t('niches.channelCount', { count: niche.channelCount })} ·{' '}
                {t('niches.videoCount', { count: niche.videoCount })}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-neutral-600">
                  {t('library.updated', { when: relativeTime(t, niche.updatedAt) })}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void confirmModal({
                      message: t('niches.deleteConfirm', { name: niche.name }),
                      confirmLabel: t('niches.delete'),
                      danger: true
                    }).then((accepted) => {
                      if (accepted) remove.mutate(niche.id)
                    })
                  }}
                  className="text-[11px] text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                >
                  {t('niches.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
