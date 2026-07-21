import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useChildMatches, useNavigate } from '@tanstack/react-router'
import { Film, FolderInput, Image as ImageIcon, Pencil, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { assetMatchesQuery, nameMatchesQuery } from '@shared/assets/search'
import { DESIGN_RECIPES } from '@shared/designs/registry'
import { WORKFLOW_TEMPLATES, getWorkflowTemplate } from '@shared/templates/registry'
import { AssetCard } from '@renderer/components/AssetCard'
import { LibraryCard } from '@renderer/components/LibraryCard'
import { useProject } from '@renderer/features/workflow/data'
import { invoke } from '@renderer/lib/ipc'
import { relativeTime } from '@renderer/lib/relativeTime'

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectRoute
})

function ProjectRoute(): React.JSX.Element {
  // The editor route ('/projects/$projectId/videos/$videoId') nests under this
  // one; when it matches, hand the whole viewport over to it.
  const hasChild = useChildMatches().length > 0
  if (hasChild) return <Outlet />
  return <VideosPage />
}

/** One project — its video library. */
function VideosPage(): React.JSX.Element {
  const { projectId } = Route.useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'videos' | 'assets'>('videos')
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const project = useProject(projectId).data
  const videos = useQuery({
    queryKey: ['videos', 'overview', projectId],
    queryFn: () => invoke('videos:overview', { projectId })
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['videos'] })
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const createVideo = useMutation({
    // Optionally seed the fresh video from a workflow blueprint: import its graph
    // (prompts pre-filled with [SLOTS]) and attach the matching style template.
    mutationFn: async (value: string) => {
      const video = await invoke('videos:create', { projectId, name: value })
      const template = templateId ? getWorkflowTemplate(templateId) : undefined
      if (template) {
        await invoke('workflow:import', {
          videoId: video.id,
          json: JSON.stringify(template.workflow),
          replace: false
        })
        await invoke('videos:setStyle', { videoId: video.id, styleId: template.styleId })
      }
      return video
    },
    onSuccess: (video) => {
      invalidate()
      setName('')
      setShowForm(false)
      setTemplateId(null)
      void navigate({
        to: '/projects/$projectId/videos/$videoId',
        params: { projectId, videoId: video.id }
      })
    }
  })
  const renameVideo = useMutation({
    mutationFn: (input: { videoId: string; name: string }) => invoke('videos:rename', input),
    onSuccess: invalidate
  })
  const removeVideo = useMutation({
    mutationFn: (videoId: string) => invoke('videos:remove', { videoId }),
    onSuccess: invalidate
  })
  const assets = useQuery({
    queryKey: ['assets', 'project', projectId],
    queryFn: () => invoke('assets:listByProject', { projectId })
  })
  const [assetQuery, setAssetQuery] = useState('')
  // 'all' | a design category present in the library | 'media' (non-design assets)
  const [assetFilter, setAssetFilter] = useState('all')
  const designFilters = useMemo(() => {
    const present = new Set(
      (assets.data ?? []).map((a) => a.designId).filter((id): id is string => id !== null)
    )
    return DESIGN_RECIPES.map((r) => r.id).filter((id) => present.has(id))
  }, [assets.data])
  const filteredAssets = useMemo(
    () =>
      (assets.data ?? [])
        .filter((a) =>
          assetFilter === 'all'
            ? true
            : assetFilter === 'media'
              ? a.designId === null
              : a.designId === assetFilter
        )
        .filter((a) => assetMatchesQuery(a, assetQuery)),
    [assets.data, assetQuery, assetFilter]
  )
  const [videoQuery, setVideoQuery] = useState('')
  const filteredVideos = useMemo(
    () => (videos.data ?? []).filter((v) => nameMatchesQuery(v.name, videoQuery)),
    [videos.data, videoQuery]
  )
  const duplicateGroups = useQuery({
    queryKey: ['assets', 'duplicates', projectId],
    queryFn: () => invoke('assets:duplicateGroups', { projectId })
  })
  const duplicateIds = useMemo(
    () => new Set((duplicateGroups.data ?? []).flat()),
    [duplicateGroups.data]
  )
  const creditsUsage = useQuery({
    queryKey: ['generations', 'creditsUsage', projectId],
    queryFn: () => invoke('projects:creditsUsage', { projectId })
  })
  const invalidateAssets = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
  }
  const importAssets = useMutation({
    mutationFn: () => invoke('assets:importFromDialog', { projectId }),
    onSuccess: invalidateAssets
  })
  const updateAsset = useMutation({
    mutationFn: (input: {
      assetId: string
      name: string
      description: string | null
      designSubject: string | null
    }) => invoke('assets:update', input),
    onSuccess: invalidateAssets
  })
  const setAssetTags = useMutation({
    mutationFn: (input: { assetId: string; tags: string[] }) => invoke('assets:setTags', input),
    onSuccess: invalidateAssets
  })
  const removeAsset = useMutation({
    mutationFn: (assetId: string) => invoke('assets:remove', { assetId }),
    onSuccess: invalidateAssets
  })
  const renameProject = useMutation({
    mutationFn: (value: string) => invoke('projects:rename', { id: projectId, name: value }),
    onSuccess: invalidate
  })

  function commitTitle(): void {
    setEditingTitle(false)
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== project?.name) renameProject.mutate(trimmed)
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      <div>
        <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← {t('library.title')}
        </Link>
        <div className="mt-2 flex items-center justify-between gap-4">
          <div className="group flex min-w-0 items-center gap-2">
            {editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle()
                  if (e.key === 'Escape') setEditingTitle(false)
                }}
                className="rounded border border-accent bg-neutral-900 px-2 py-1 text-2xl font-semibold text-neutral-100 focus:outline-none"
              />
            ) : (
              <>
                <h1 className="truncate text-2xl font-semibold text-neutral-100">
                  {project?.name ?? '…'}
                </h1>
                <button
                  onClick={() => {
                    setTitleDraft(project?.name ?? '')
                    setEditingTitle(true)
                  }}
                  className="rounded p-1 text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:bg-neutral-800 hover:text-neutral-300"
                  title={t('library.rename')}
                >
                  <Pencil className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
          {tab === 'videos' ? (
            <button
              onClick={() => setShowForm((v) => !v)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> {t('videosPage.newVideo')}
            </button>
          ) : (
            <button
              onClick={() => importAssets.mutate()}
              disabled={importAssets.isPending}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-50"
            >
              <FolderInput className="h-4 w-4" /> {t('assetsPage.import')}
            </button>
          )}
        </div>

        {(creditsUsage.data?.generationCount ?? 0) > 0 && (
          <div className="mt-1 text-xs text-neutral-500">
            {t('videosPage.creditsUsage', {
              count: creditsUsage.data!.generationCount,
              credits: Math.round(creditsUsage.data!.estimatedCredits)
            })}
          </div>
        )}

        {/* Videos / Assets tabs — the asset library is project-wide, shared by every video. */}
        <div className="mt-5 flex gap-1 border-b border-neutral-800">
          {(['videos', 'assets'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 pb-2 text-sm transition-colors ${
                tab === key
                  ? 'border-accent font-medium text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {key === 'videos'
                ? `${t('assetsPage.tabVideos')} (${videos.data?.length ?? 0})`
                : `${t('assetsPage.tabAssets')} (${assets.data?.length ?? 0})`}
            </button>
          ))}
        </div>
      </div>

      {tab === 'videos' && showForm && (
        <form
          className="island flex flex-col gap-3 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) createVideo.mutate(name.trim())
          }}
        >
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('videosPage.namePlaceholder')}
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={createVideo.isPending || name.trim() === ''}
              className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
            >
              {t('library.create')}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              {t('library.cancel')}
            </button>
          </div>

          {/* Workflow blueprints — pre-wired shot graphs with [SLOTS] to personalize. */}
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {t('videosPage.startFrom')}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
              <button
                type="button"
                onClick={() => setTemplateId(null)}
                className={`rounded-md border px-3 py-2 text-left transition-colors ${
                  templateId === null
                    ? 'border-accent bg-neutral-800/60'
                    : 'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                <div className="text-sm text-neutral-200">{t('videosPage.blankVideo')}</div>
                <div className="mt-0.5 text-[10px] text-neutral-500">
                  {t('videosPage.blankVideoDesc')}
                </div>
              </button>
              {WORKFLOW_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setTemplateId(template.id)}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${
                    templateId === template.id
                      ? 'border-accent bg-neutral-800/60'
                      : 'border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  <div className="text-sm text-neutral-200">
                    {t(`templates.${template.id}.name` as never)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-neutral-500">
                    {t(`templates.${template.id}.desc` as never)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </form>
      )}

      {tab === 'assets' ? (
        (assets.data?.length ?? 0) === 0 ? (
          <div className="island flex flex-col items-center gap-3 px-8 py-16 text-center">
            <ImageIcon className="h-10 w-10 text-neutral-700" />
            <p className="text-sm font-medium text-neutral-300">{t('assetsPage.empty')}</p>
            <p className="max-w-sm text-xs text-neutral-500">{t('assetsPage.emptyHint')}</p>
            <button
              onClick={() => importAssets.mutate()}
              className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover"
            >
              <FolderInput className="h-4 w-4" /> {t('assetsPage.import')}
            </button>
          </div>
        ) : (
          <>
            <div className="island flex items-center gap-2 px-3 py-2">
              <Search className="h-4 w-4 flex-shrink-0 text-neutral-500" />
              <input
                value={assetQuery}
                onChange={(e) => setAssetQuery(e.target.value)}
                placeholder={t('assetsPage.searchPlaceholder')}
                className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
              />
            </div>
            {designFilters.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {['all', ...designFilters, 'media'].map((key) => (
                  <button
                    key={key}
                    onClick={() => setAssetFilter(key)}
                    className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                      assetFilter === key
                        ? 'bg-accent font-medium text-neutral-900'
                        : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {key === 'all'
                      ? t('assetsPage.filterAll')
                      : key === 'media'
                        ? t('assetsPage.filterMedia')
                        : t(`designs.${key}.name` as never)}
                  </button>
                ))}
              </div>
            )}
            {filteredAssets.length === 0 ? (
              <p className="text-sm italic text-neutral-500">
                {t('assetsPage.noMatch', { query: assetQuery })}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
                {filteredAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    isDuplicate={duplicateIds.has(asset.id)}
                    onSave={(patch) => {
                      updateAsset.mutate({
                        assetId: asset.id,
                        name: patch.name,
                        description: patch.description,
                        designSubject: patch.designSubject
                      })
                      setAssetTags.mutate({ assetId: asset.id, tags: patch.tags })
                    }}
                    onDelete={() => {
                      void (async () => {
                        // Workflows referencing the asset via studio/asset nodes would
                        // break — surface them before confirming the deletion.
                        const refs = await invoke('assets:references', { assetId: asset.id })
                        const message =
                          refs.length > 0
                            ? t('assetsPage.deleteReferencedConfirm', {
                                name: asset.name,
                                count: refs.reduce((sum, r) => sum + r.nodeCount, 0),
                                videos: refs.map((r) => r.videoName).join(', ')
                              })
                            : t('assetsPage.deleteConfirm', { name: asset.name })
                        if (confirm(message)) removeAsset.mutate(asset.id)
                      })()
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )
      ) : videos.data?.length === 0 && !showForm ? (
        <div className="island flex flex-col items-center gap-3 px-8 py-16 text-center">
          <Film className="h-10 w-10 text-neutral-700" />
          <p className="text-sm font-medium text-neutral-300">{t('videosPage.empty')}</p>
          <p className="max-w-sm text-xs text-neutral-500">{t('videosPage.emptyHint')}</p>
          <button
            onClick={() => setShowForm(true)}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> {t('videosPage.newVideo')}
          </button>
        </div>
      ) : (
        <>
          <div className="island flex items-center gap-2 px-3 py-2">
            <Search className="h-4 w-4 flex-shrink-0 text-neutral-500" />
            <input
              value={videoQuery}
              onChange={(e) => setVideoQuery(e.target.value)}
              placeholder={t('videosPage.searchPlaceholder')}
              className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            />
          </div>
          {filteredVideos.length === 0 ? (
            <p className="text-sm italic text-neutral-500">
              {t('videosPage.noMatch', { query: videoQuery })}
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
              {filteredVideos.map((video) => (
                <LibraryCard
                  key={video.id}
                  name={video.name}
                  meta={`${t('videosPage.clipCount', { count: video.clipCount })} · ${t('videosPage.nodeCount', { count: video.nodeCount })} · ${relativeTime(t, video.updatedAt)}`}
                  thumbnailUrl={video.thumbnailUrl}
                  thumbnailKind={video.thumbnailKind}
                  placeholderIcon={Film}
                  onOpen={() =>
                    void navigate({
                      to: '/projects/$projectId/videos/$videoId',
                      params: { projectId, videoId: video.id }
                    })
                  }
                  onRename={(value) => renameVideo.mutate({ videoId: video.id, name: value })}
                  onDelete={() => {
                    if (confirm(t('videosPage.deleteConfirm', { name: video.name }))) {
                      removeVideo.mutate(video.id)
                    }
                  }}
                  renameTitle={t('library.rename')}
                  deleteTitle={t('library.delete')}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
