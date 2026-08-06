import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LayoutGrid,
  Loader2,
  Map,
  Plus
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NicheRoadmapItem } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { FeedPreviewModal } from './FeedPreviewModal'
import { compactNumber } from './VideoRow'

/**
 * The niche's video roadmap (§7b): grounded ideas carried to production.
 * Assigning an item creates the Raccord workflow (niche production profile
 * applied, thumbnail node seeded from the brief) and jumps into the editor.
 */
export function RoadmapSection({ nicheId }: { nicheId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')

  const roadmap = useQuery({
    queryKey: ['niches', nicheId, 'roadmap'],
    queryFn: () => invoke('niches:roadmap', { nicheId })
  })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => invoke('projects:list') })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['niches'] })
  }
  const add = useMutation({
    mutationFn: (value: string) => invoke('niches:addRoadmapItem', { nicheId, title: value }),
    onSuccess: () => {
      setTitle('')
      invalidate()
    }
  })

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-neutral-300">
        {t('niches.roadmap.title')}{' '}
        {(roadmap.data?.length ?? 0) > 0 && (
          <span className="font-normal text-neutral-500">({roadmap.data?.length})</span>
        )}
      </h2>
      <form
        className="island flex items-center gap-2 py-2 pr-2 pl-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) add.mutate(title.trim())
        }}
      >
        <Plus className="h-4 w-4 shrink-0 text-neutral-500" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('niches.roadmap.addPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
        />
        <button
          type="submit"
          disabled={add.isPending || title.trim() === ''}
          className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          {t('niches.roadmap.add')}
        </button>
      </form>

      {roadmap.data?.length === 0 ? (
        <div className="island flex items-center gap-3 px-4 py-5">
          <Map className="h-5 w-5 shrink-0 text-neutral-700" />
          <p className="text-xs text-neutral-500">{t('niches.roadmap.empty')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(roadmap.data ?? []).map((item) => (
            <RoadmapItemCard
              key={item.id}
              item={item}
              projects={projects.data ?? []}
              onChanged={invalidate}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const STATUS_CLASS: Record<NicheRoadmapItem['status'], string> = {
  idea: 'bg-neutral-800 text-neutral-300',
  in_production: 'bg-accent text-neutral-900',
  published: 'bg-success/20 text-success'
}

function RoadmapItemCard({
  item,
  projects,
  onChanged
}: {
  item: NicheRoadmapItem
  projects: { id: string; name: string }[]
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const [drafts, setDrafts] = useState({
    angle: item.angle ?? '',
    description: item.description ?? '',
    thumbnailBrief: item.thumbnailBrief ?? '',
    evidence: item.evidence ?? ''
  })
  const [targetProjectId, setTargetProjectId] = useState('')
  const [publishedUrl, setPublishedUrl] = useState('')
  const [feedPreviewOpen, setFeedPreviewOpen] = useState(false)

  const dirty =
    drafts.angle !== (item.angle ?? '') ||
    drafts.description !== (item.description ?? '') ||
    drafts.thumbnailBrief !== (item.thumbnailBrief ?? '') ||
    drafts.evidence !== (item.evidence ?? '')

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof buildPatch>[0]) =>
      invoke('niches:updateRoadmapItem', { itemId: item.id, ...buildPatch(patch) }),
    onSuccess: onChanged,
    onError: (err) => toast.error(err.message)
  })
  const remove = useMutation({
    mutationFn: () => invoke('niches:deleteRoadmapItem', { itemId: item.id }),
    onSuccess: onChanged
  })
  const assign = useMutation({
    mutationFn: () =>
      invoke('niches:assignRoadmapItem', { itemId: item.id, projectId: targetProjectId }),
    onSuccess: (result) => {
      onChanged()
      toast.success(t('niches.roadmap.assigned'))
      void navigate({
        to: '/projects/$projectId/videos/$videoId',
        params: { projectId: result.projectId, videoId: result.videoId }
      })
    },
    onError: (err) => toast.error(err.message)
  })
  const markPublished = useMutation({
    mutationFn: () =>
      invoke('niches:markRoadmapPublished', { itemId: item.id, url: publishedUrl.trim() }),
    onSuccess: () => {
      setPublishedUrl('')
      onChanged()
    },
    onError: (err) => toast.error(err.message)
  })

  return (
    <div className="island p-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-md p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <select
          value={item.status}
          onChange={(e) => update.mutate({ status: e.target.value as NicheRoadmapItem['status'] })}
          className={`shrink-0 cursor-pointer appearance-none rounded-full px-2 py-0.5 text-[11px] font-medium focus:outline-none ${STATUS_CLASS[item.status]}`}
        >
          {(['idea', 'in_production', 'published'] as const).map((status) => (
            <option key={status} value={status}>
              {t(`niches.roadmap.status.${status}`)}
            </option>
          ))}
        </select>
        {item.videoType === 'short' && (
          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-neutral-900">
            {t('niches.roadmap.typeShort')}
          </span>
        )}
        <span className="line-clamp-1 flex-1 text-sm text-neutral-100">{item.title}</span>
        {item.videoId && (
          <button
            onClick={() => setFeedPreviewOpen(true)}
            title={t('niches.roadmap.feedPreview')}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <LayoutGrid className="h-3 w-3" /> {t('niches.roadmap.feedPreviewShort')}
          </button>
        )}
        {item.videoId && item.projectId && (
          <button
            onClick={() =>
              void navigate({
                to: '/projects/$projectId/videos/$videoId',
                params: { projectId: item.projectId as string, videoId: item.videoId as string }
              })
            }
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            {t('niches.roadmap.openWorkflow')} <ExternalLink className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={() => {
            void confirmModal({
              message: t('niches.roadmap.deleteConfirm', { title: item.title }),
              confirmLabel: t('niches.delete'),
              danger: true
            }).then((accepted) => {
              if (accepted) remove.mutate()
            })
          }}
          className="shrink-0 text-[11px] text-neutral-600 hover:text-danger"
        >
          {t('niches.delete')}
        </button>
      </div>

      {item.angle && !expanded && (
        <p className="mt-1 ml-6 line-clamp-1 text-xs text-neutral-500">{item.angle}</p>
      )}
      {item.published && (
        <p className="mt-1 ml-6 text-xs text-success">
          {t('niches.roadmap.publishedPerf', {
            views: compactNumber.format(item.published.views),
            median: compactNumber.format(item.published.nicheMedianViews)
          })}
        </p>
      )}

      {expanded && (
        <div className="mt-3 ml-6 flex flex-col gap-3">
          {/* Packaging-first: the candidate titles written before production.
              Promoting one swaps it into `title`; the old title joins the list. */}
          {(item.titleVariants?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
                {t('niches.roadmap.titleVariantsLabel')}
              </span>
              <div className="flex flex-col gap-1">
                {(item.titleVariants ?? []).map((variant) => (
                  <div
                    key={variant}
                    className="flex items-center gap-2 rounded-md border border-neutral-800 px-2.5 py-1.5"
                  >
                    <span className="line-clamp-1 flex-1 text-xs text-neutral-300">{variant}</span>
                    <button
                      onClick={() =>
                        update.mutate({
                          title: variant,
                          titleVariants: [
                            item.title,
                            ...(item.titleVariants ?? []).filter((v) => v !== variant)
                          ]
                        })
                      }
                      disabled={update.isPending}
                      className="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                    >
                      {t('niches.roadmap.promoteTitle')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(
            [
              ['angle', 'anglePlaceholder', 'angleLabel', 2],
              ['description', 'descriptionPlaceholder', 'descriptionLabel', 4],
              ['thumbnailBrief', 'thumbnailPlaceholder', 'thumbnailLabel', 2],
              ['evidence', 'evidencePlaceholder', 'evidenceLabel', 2]
            ] as const
          ).map(([key, placeholderKey, labelKey, rows]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
                {t(`niches.roadmap.${labelKey}`)}
              </span>
              <textarea
                value={drafts[key]}
                onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                placeholder={t(`niches.roadmap.${placeholderKey}`)}
                rows={rows}
                className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <button
                onClick={() =>
                  update.mutate({
                    angle: drafts.angle.trim() || null,
                    description: drafts.description.trim() || null,
                    thumbnailBrief: drafts.thumbnailBrief.trim() || null,
                    evidence: drafts.evidence.trim() || null
                  })
                }
                disabled={update.isPending}
                className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
              >
                {t('niches.roadmap.save')}
              </button>
            )}
            <div className="flex-1" />
            {!item.videoId &&
              (projects.length === 0 ? (
                <span className="text-xs italic text-neutral-500">
                  {t('niches.roadmap.noProjects')}
                </span>
              ) : (
                <>
                  <select
                    value={targetProjectId}
                    onChange={(e) => setTargetProjectId(e.target.value)}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300"
                  >
                    <option value="">{t('niches.roadmap.assign')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => assign.mutate()}
                    disabled={targetProjectId === '' || assign.isPending}
                    className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
                  >
                    {assign.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('niches.roadmap.assignConfirm')}
                  </button>
                </>
              ))}
            {item.status !== 'published' && item.videoId && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (publishedUrl.trim()) markPublished.mutate()
                }}
              >
                <input
                  value={publishedUrl}
                  onChange={(e) => setPublishedUrl(e.target.value)}
                  placeholder={t('niches.roadmap.publishedUrlPlaceholder')}
                  className="w-64 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={publishedUrl.trim() === '' || markPublished.isPending}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                >
                  {t('niches.roadmap.markPublished')}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {feedPreviewOpen && (
        <FeedPreviewModal
          nicheId={item.nicheId}
          item={item}
          onClose={() => setFeedPreviewOpen(false)}
        />
      )}
    </div>
  )
}

function buildPatch(patch: {
  status?: NicheRoadmapItem['status']
  title?: string
  titleVariants?: string[] | null
  angle?: string | null
  description?: string | null
  thumbnailBrief?: string | null
  evidence?: string | null
}): typeof patch {
  return patch
}
