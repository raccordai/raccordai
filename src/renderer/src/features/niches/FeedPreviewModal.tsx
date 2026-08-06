import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NicheRoadmapItem } from '@shared/ipc/contracts'
import { useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { compactNumber } from './VideoRow'

/**
 * Packaging-first (§7c): the candidate thumbnail + title rendered INSIDE a
 * mock YouTube feed built from the niche's real tracked videos — the pros
 * judge a thumbnail against the competition it will actually sit next to,
 * not on a white background. The candidate image is the workflow's thumbnail
 * node generation; the title cycles through the item's variants.
 */
export function FeedPreviewModal({
  nicheId,
  item,
  onClose
}: {
  nicheId: string
  item: NicheRoadmapItem
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const titles = useMemo(
    () => [item.title, ...(item.titleVariants ?? []).filter((v) => v !== item.title)],
    [item.title, item.titleVariants]
  )
  const [titleIndex, setTitleIndex] = useState(0)

  const videos = useQuery({
    queryKey: ['niches', nicheId, 'videos', 'feed-preview'],
    queryFn: () =>
      invoke('niches:videos', {
        nicheId,
        filters: { format: 'all', sort: 'views' },
        limit: 11
      })
  })
  const graph = useQuery({
    queryKey: ['graph', item.videoId, 'feed-preview'],
    queryFn: () => invoke('graph:get', { videoId: item.videoId as string }),
    enabled: item.videoId !== null
  })
  const thumbnailNode = graph.data?.nodes.find(
    (n) => (n.params as Record<string, unknown> | null)?.designId === 'thumbnail'
  )
  const generations = useQuery({
    queryKey: ['generations', thumbnailNode?.id, 'feed-preview'],
    queryFn: () => invoke('generations:listForNode', { nodeId: thumbnailNode?.id as string }),
    enabled: thumbnailNode !== undefined
  })
  const candidate = useMemo(() => {
    const list = generations.data ?? []
    const selected = list.find(
      (g) => g.id === thumbnailNode?.selectedGenerationId && g.status === 'success' && g.url
    )
    return selected ?? list.find((g) => g.status === 'success' && g.url) ?? null
  }, [generations.data, thumbnailNode?.selectedGenerationId])

  const exportImage = useMutation({
    mutationFn: () =>
      invoke('generations:exportImage', {
        generationId: candidate?.id as string,
        defaultFileName: item.title
      }),
    onSuccess: (result) => {
      if (result) toast.success(t('niches.roadmap.thumbnailExported', { path: result.path }))
    },
    onError: (err) => toast.error(err.message)
  })

  // The candidate sits mid-feed (4th slot) — a realistic position, not a pedestal.
  const feed = useMemo(() => {
    const rows: ({ kind: 'candidate' } | { kind: 'video'; index: number })[] = (
      videos.data ?? []
    ).map((_, index) => ({ kind: 'video', index }) as const)
    rows.splice(Math.min(3, rows.length), 0, { kind: 'candidate' })
    return rows
  }, [videos.data])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="island flex max-h-full w-full max-w-4xl flex-col gap-3 overflow-hidden p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-neutral-100">
              {t('niches.roadmap.feedPreview')}
            </h3>
            <p className="mt-0.5 text-xs text-neutral-500">{t('niches.roadmap.feedPreviewHint')}</p>
          </div>
          <div className="flex items-center gap-2">
            {candidate && (
              <button
                onClick={() => exportImage.mutate()}
                disabled={exportImage.isPending}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                {t('niches.roadmap.exportThumbnail')}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 overflow-y-auto md:grid-cols-3">
          {feed.map((row) =>
            row.kind === 'candidate' ? (
              <div key="candidate" className="rounded-xl p-1 ring-2 ring-highlight">
                {candidate?.url ? (
                  <img
                    src={candidate.url}
                    alt=""
                    className={`w-full rounded-lg bg-neutral-900 object-cover ${
                      item.videoType === 'short' ? 'aspect-[9/16]' : 'aspect-video'
                    }`}
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-neutral-900 p-3 text-center text-[11px] text-neutral-500">
                    {t('niches.roadmap.noThumbnailYet')}
                  </div>
                )}
                <button
                  onClick={() => setTitleIndex((titleIndex + 1) % titles.length)}
                  title={titles.length > 1 ? t('niches.roadmap.cycleTitles') : undefined}
                  className="mt-1.5 w-full px-1 text-left"
                >
                  <span className="line-clamp-2 text-xs font-medium text-neutral-100">
                    {titles[titleIndex]}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-highlight">
                    {t('niches.roadmap.feedYourChannel')}
                    {titles.length > 1 && ` · ${titleIndex + 1}/${titles.length}`}
                  </span>
                </button>
              </div>
            ) : (
              (() => {
                const video = videos.data?.[row.index]
                if (!video) return null
                return (
                  <div key={video.id} className="p-1">
                    {video.thumbnail ? (
                      <img
                        src={video.thumbnail}
                        alt=""
                        loading="lazy"
                        className="aspect-video w-full rounded-lg bg-neutral-900 object-cover"
                      />
                    ) : (
                      <div className="aspect-video w-full rounded-lg bg-neutral-900" />
                    )}
                    <p className="mt-1.5 line-clamp-2 px-1 text-xs font-medium text-neutral-200">
                      {video.title}
                    </p>
                    <p className="mt-0.5 px-1 text-[11px] text-neutral-500">
                      {video.channelTitle} · {compactNumber.format(video.views)}{' '}
                      {t('niches.viewsShort')}
                    </p>
                  </div>
                )
              })()
            )
          )}
        </div>
      </div>
    </div>
  )
}
