import { useReactFlow } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightToLine,
  ChevronDown,
  FileImage,
  FileVideo,
  FolderInput,
  History,
  Loader2,
  Maximize2,
  Music,
  PanelBottom,
  PanelBottomClose,
  Palette,
  PenTool,
  Plus,
  Redo2,
  Search,
  Sparkles,
  Undo2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AssetWithUrl, GraphEdge, GraphNode } from '@shared/ipc/contracts'
import { MODELS, defaultParamsFor } from '@shared/models'
import { STYLES, getStyle } from '@shared/styles/registry'
import {
  DESIGN_RECIPES,
  designIntent,
  designNodeParams,
  getDesignRecipe,
  type DesignRecipe
} from '@shared/designs/registry'
import { invoke } from '@renderer/lib/ipc'
import { useFlag } from '@renderer/features/flags/useFlags'
import { Button } from '@renderer/components/ui/Button'
import { Logo } from '@renderer/components/Logo'
import { graphKeys, useIpcMutation, useProject, useProjectAssets, useVideo } from './data'
import type { LayoutDirection } from './autoLayout'

interface Props {
  videoId: string
  projectId: string
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  onTidy: (direction: LayoutDirection) => void
  onFit: () => void
  timelineCollapsed: boolean
  onToggleTimeline: () => void
  historyOpen: boolean
  onToggleHistory: () => void
  onRunAllVideos: () => void
  runningAllVideos: boolean
  videoNodeCount: number
}

export function WorkflowToolbar({
  videoId,
  projectId,
  graph,
  onTidy,
  onFit,
  timelineCollapsed,
  onToggleTimeline,
  historyOpen,
  onToggleHistory,
  onRunAllVideos,
  runningAllVideos,
  videoNodeCount
}: Props) {
  const { t } = useTranslation()
  const { mutateAsync: createNode } = useIpcMutation('nodes:create', [graphKeys.graph(videoId)])
  const { screenToFlowPosition } = useReactFlow()
  const video = useVideo(videoId).data
  const project = useProject(projectId).data
  const creativeTemplates = useFlag('creative-templates')
  const designRecipes = useFlag('design-recipes')
  const { mutate: setStyle } = useIpcMutation('videos:setStyle', [['videos']])

  // Undo/redo — state is refreshed by the ['history'] invalidation that every
  // graph mutation triggers (event:workflowChanged from the main process).
  const historyState = useQuery({
    queryKey: ['history', videoId],
    queryFn: () => invoke('history:state', { videoId })
  })
  const { mutate: undo } = useIpcMutation('history:undo', [
    graphKeys.graph(videoId),
    ['generations'],
    ['history']
  ])
  const { mutate: redo } = useIpcMutation('history:redo', [
    graphKeys.graph(videoId),
    ['generations'],
    ['history']
  ])

  function spawnPosition(): { x: number; y: number } {
    // Spawn the node at the centre of the CURRENT viewport (not at fixed canvas
    // coords, which end up off-screen once the user has panned/zoomed away).
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect()
    const screenCentre = pane
      ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const centre = screenToFlowPosition(screenCentre)
    // Small cascade so consecutive adds don't stack exactly on top of each other.
    const cascade = (graph.nodes.length % 5) * 28
    return {
      x: Math.round(centre.x - 144 + cascade), // ~half a modelNode width
      y: Math.round(centre.y - 130 + cascade) // ~half a modelNode height
    }
  }

  async function addNode(modelId: string) {
    await createNode({
      videoId,
      modelId,
      position: spawnPosition(),
      params: modelId === 'studio/asset' ? {} : defaultParamsFor(modelId)
    })
  }

  // Published design sheets of the project — offered as "from library" entries
  // in the add-node menu (design-recipes flag only).
  const projectAssets = useProjectAssets(projectId).data
  const designAssets = useMemo(
    () => (projectAssets ?? []).filter((a) => a.designId !== null),
    [projectAssets]
  )

  /**
   * Library design sheet → a studio/asset node wired to it, with the same
   * reference-only intent convention as freshly created design nodes.
   */
  async function addLibraryDesignNode(asset: AssetWithUrl) {
    await createNode({
      videoId,
      modelId: 'studio/asset',
      position: spawnPosition(),
      params: { assetId: asset.id },
      label: asset.name,
      intent: `Design sheet "${asset.name}"${asset.designSubject ? ` (${asset.designSubject})` : ''} from the project library — reference only; on a frame anchor it would appear on screen.`
    })
  }

  /**
   * Design recipe → a pre-configured image node: prompt built for the target
   * model and the video's current style, reference-only intent, marker in
   * params so the editor can warn about frame-anchor connections.
   */
  async function addDesignNode(recipeId: string, description: string) {
    const recipe = getDesignRecipe(recipeId)
    if (!recipe) return
    const style = video?.styleId ? getStyle(video.styleId) : undefined
    const name = t(`designs.${recipeId}.name` as never) as string
    const subject = description.trim()
    await createNode({
      videoId,
      modelId: recipe.defaultModelId,
      position: spawnPosition(),
      params: designNodeParams(recipe, recipe.defaultModelId, { description: subject, style }),
      label: subject ? `${name} — ${subject.slice(0, 40)}` : name,
      intent: designIntent(recipe)
    })
  }

  return (
    <div className="island flex items-center gap-1 px-2 py-1">
      {/* Left: brand + project / video breadcrumb */}
      <Link
        to="/"
        className="flex flex-shrink-0 items-center gap-2 text-sm font-semibold text-neutral-100"
      >
        <Logo className="h-5 w-5" /> Raccord
      </Link>
      <span className="text-neutral-700">/</span>
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="max-w-[10rem] truncate text-sm text-neutral-400 hover:text-neutral-100"
        title={project?.name}
      >
        {project?.name ?? '…'}
      </Link>
      <span className="text-neutral-700">/</span>
      <span className="max-w-[10rem] truncate text-sm text-neutral-200" title={video?.name}>
        {video?.name ?? '…'}
      </span>

      <div className="flex-1" />

      {/* Right: actions */}
      <AddNodeMenu
        onAdd={addNode}
        onAddDesign={designRecipes ? addDesignNode : undefined}
        libraryAssets={designRecipes ? designAssets : undefined}
        onAddFromLibrary={designRecipes ? addLibraryDesignNode : undefined}
      />

      {creativeTemplates && (
        <StyleMenu
          current={video?.styleId ?? null}
          onSelect={(styleId) => setStyle({ videoId, styleId })}
        />
      )}

      <div className="mx-1.5 h-5 w-px bg-neutral-800" />

      <Button
        variant="ghost"
        size="sm"
        onClick={() => undo({ videoId })}
        disabled={!historyState.data?.canUndo}
        title={t('editor.undo')}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => redo({ videoId })}
        disabled={!historyState.data?.canRedo}
        title={t('editor.redo')}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>

      <div className="mx-1.5 h-5 w-px bg-neutral-800" />

      {/* One-click: generate every video node in the workflow (skips clips that
          already succeeded; runs each video's upstream deps first). */}
      <Button
        variant="primary"
        size="sm"
        className="!border-highlight/50 !bg-highlight !shadow-highlight/20 hover:!bg-highlight-hover"
        onClick={onRunAllVideos}
        disabled={videoNodeCount === 0 || runningAllVideos}
        title={videoNodeCount === 0 ? t('editor.noVideoNodes') : t('editor.generateVideosTitle')}
      >
        {runningAllVideos ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('editor.generating')}
          </>
        ) : (
          <>
            <FileVideo className="h-3.5 w-3.5" /> {t('editor.generateVideos')}
            {videoNodeCount > 0 ? ` (${videoNodeCount})` : ''}
          </>
        )}
      </Button>

      <div className="mx-1.5 h-5 w-px bg-neutral-800" />

      {/* One-click auto-arrange (like Fit) — chevron for the direction variants. */}
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onTidy('LR')}
          disabled={graph.nodes.length === 0}
          title={t('editor.tidyTitle')}
        >
          <Sparkles className="h-3.5 w-3.5" /> {t('editor.tidy')}
        </Button>
        <Dropdown label="" icon={<ChevronDown className="h-3 w-3" />} variant="ghost">
          <DropdownItem
            onClick={() => onTidy('LR')}
            icon={<ArrowRightToLine className="h-3.5 w-3.5" />}
          >
            {t('editor.leftRight')}
          </DropdownItem>
          <DropdownItem
            onClick={() => onTidy('TB')}
            icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
          >
            {t('editor.topBottom')}
          </DropdownItem>
        </Dropdown>
      </div>
      <Button variant="ghost" size="sm" onClick={onFit} title={t('editor.fitTitle')}>
        <Maximize2 className="h-3.5 w-3.5" /> {t('editor.fit')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleTimeline}
        title={timelineCollapsed ? t('editor.showTimeline') : t('editor.hideTimeline')}
      >
        {timelineCollapsed ? (
          <PanelBottom className="h-3.5 w-3.5" />
        ) : (
          <PanelBottomClose className="h-3.5 w-3.5" />
        )}{' '}
        {t('editor.timeline')}
      </Button>
      <Button
        variant={historyOpen ? 'secondary' : 'ghost'}
        size="sm"
        onClick={onToggleHistory}
        title={t('editor.historyBtnTitle')}
      >
        <History className="h-3.5 w-3.5" /> {t('editor.historyBtn')}
      </Button>
    </div>
  )
}

// ─── Add-node combobox ──────────────────────────────────────────────────────
// One compact button + a type-to-filter list, instead of one dropdown per media
// kind — scales as the model catalogue grows.

interface AddEntry {
  id: string
  label: string
  /** Secondary line: what the entry does (localized for designs/asset, product data for models). */
  desc: string
  kind: 'design' | 'image' | 'video' | 'audio' | 'asset'
  /** Set on design entries — choosing one opens the description step instead of adding. */
  recipe?: DesignRecipe
  /** Set on the "from library" entry — choosing it opens the design-asset picker step. */
  library?: boolean
}

const KIND_ICONS: Record<AddEntry['kind'], React.ReactNode> = {
  design: <PenTool className="h-3.5 w-3.5 text-highlight" />,
  image: <FileImage className="h-3.5 w-3.5 text-accent-soft" />,
  video: <FileVideo className="h-3.5 w-3.5 text-accent" />,
  audio: <Music className="h-3.5 w-3.5 text-highlight-soft" />,
  asset: <FolderInput className="h-3.5 w-3.5 text-warning" />
}
// Designs first: the guided entries are the beginner-friendly starting point.
const KIND_ORDER: AddEntry['kind'][] = ['design', 'image', 'video', 'audio', 'asset']

/** Lowercase + strip accents so an accented query still matches "Seedance". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function AddNodeMenu({
  onAdd,
  onAddDesign,
  libraryAssets,
  onAddFromLibrary
}: {
  onAdd: (modelId: string) => void
  /** Present only when the design-recipes flag is on. */
  onAddDesign?: (recipeId: string, description: string) => void
  /** Published design sheets of the project (design-recipes flag only). */
  libraryAssets?: AssetWithUrl[]
  onAddFromLibrary?: (asset: AssetWithUrl) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** Non-null while the second step (design subject description) is showing. */
  const [pendingDesign, setPendingDesign] = useState<DesignRecipe | null>(null)
  const [designDesc, setDesignDesc] = useState('')
  /** True while the design-asset picker step is showing. */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const designInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  // Mirrors for the search input's onBlur timeout (the state values are stale there).
  const pendingDesignRef = useRef<DesignRecipe | null>(null)
  const libraryOpenRef = useRef(false)
  useEffect(() => {
    pendingDesignRef.current = pendingDesign
  }, [pendingDesign])
  useEffect(() => {
    libraryOpenRef.current = libraryOpen
  }, [libraryOpen])

  const entries = useMemo<AddEntry[]>(
    () => [
      ...(onAddFromLibrary && (libraryAssets?.length ?? 0) > 0
        ? [
            {
              id: 'design:library',
              label: t('editor.designFromLibrary'),
              desc: t('editor.designFromLibraryDesc'),
              kind: 'design' as const,
              library: true
            }
          ]
        : []),
      ...(onAddDesign
        ? DESIGN_RECIPES.map((r) => ({
            id: `design:${r.id}`,
            label: t(`designs.${r.id}.name` as never) as string,
            desc: t(`designs.${r.id}.desc` as never) as string,
            kind: 'design' as const,
            recipe: r
          }))
        : []),
      // Model label/description are product data (English), like the ids — not localized.
      ...MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        desc: `${m.description.split('.')[0]}.`,
        kind: m.kind as AddEntry['kind']
      })),
      {
        id: 'studio/asset',
        label: t('editor.assetEntry'),
        desc: t('editor.assetEntryDesc'),
        kind: 'asset'
      }
    ],
    [t, onAddDesign, onAddFromLibrary, libraryAssets]
  )

  const q = normalize(query.trim())
  const filtered = q
    ? entries.filter((e) => normalize(`${e.label} ${e.desc} ${e.id} ${e.kind}`).includes(q))
    : entries
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: filtered.filter((e) => e.kind === kind)
  })).filter((g) => g.items.length > 0)
  // Flat list (in render order) for keyboard navigation across group boundaries.
  const flat = groups.flatMap((g) => g.items)

  // Reset the highlight to the first hit whenever the filter changes.
  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (open && !pendingDesign && !libraryOpen) inputRef.current?.focus()
  }, [open, pendingDesign, libraryOpen])

  useEffect(() => {
    if (pendingDesign) designInputRef.current?.focus()
  }, [pendingDesign])

  useEffect(() => {
    if (libraryOpen) libraryInputRef.current?.focus()
  }, [libraryOpen])

  function close() {
    setOpen(false)
    setQuery('')
    setPendingDesign(null)
    setDesignDesc('')
    setLibraryOpen(false)
    setLibraryQuery('')
  }

  function choose(entry: AddEntry | undefined) {
    if (!entry) return
    if (entry.library) {
      // Second step: pick a published design sheet from the project library.
      setLibraryOpen(true)
      setLibraryQuery('')
      return
    }
    if (entry.recipe) {
      // Second step: ask for the subject before building the prompt.
      setPendingDesign(entry.recipe)
      setDesignDesc('')
      return
    }
    onAdd(entry.id)
    close()
  }

  function confirmDesign() {
    if (!pendingDesign) return
    onAddDesign?.(pendingDesign.id, designDesc)
    close()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(flat.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(flat[active])
    } else if (e.key === 'Escape') {
      close()
    }
  }

  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={t('editor.addNodeTitle')}
      >
        <Plus className="h-3.5 w-3.5" /> {t('editor.addNode')}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-80 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          {pendingDesign ? (
            <div className="p-2.5">
              <div className="flex items-center gap-2">
                <button
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setPendingDesign(null)
                  }}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title={t('editor.designBack')}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                {KIND_ICONS.design}
                <span className="text-sm font-medium text-neutral-100">
                  {t(`designs.${pendingDesign.id}.name` as never)}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
                {t('editor.designHint')}
              </p>
              <input
                ref={designInputRef}
                value={designDesc}
                onChange={(e) => setDesignDesc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    confirmDesign()
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setPendingDesign(null)
                  }
                }}
                onBlur={() => setTimeout(close, 150)}
                placeholder={t(`designs.${pendingDesign.id}.placeholder` as never)}
                className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    confirmDesign()
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> {t('editor.designAdd')}
                </Button>
              </div>
            </div>
          ) : libraryOpen ? (
            <div className="p-2.5">
              <div className="flex items-center gap-2">
                <button
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setLibraryOpen(false)
                  }}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title={t('editor.designBack')}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                {KIND_ICONS.design}
                <span className="text-sm font-medium text-neutral-100">
                  {t('editor.designFromLibrary')}
                </span>
              </div>
              <input
                ref={libraryInputRef}
                value={libraryQuery}
                onChange={(e) => setLibraryQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setLibraryOpen(false)
                  }
                }}
                onBlur={() => setTimeout(close, 150)}
                placeholder={t('editor.designLibraryFilter')}
                className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                {(libraryAssets ?? [])
                  .filter((a) =>
                    normalize(
                      `${a.name} ${a.designSubject ?? ''} ${a.designId ?? ''} ${a.tags.join(' ')}`
                    ).includes(normalize(libraryQuery.trim()))
                  )
                  .map((a) => (
                    <li key={a.id}>
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault()
                          onAddFromLibrary?.(a)
                          close()
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-neutral-800"
                      >
                        {a.url ? (
                          <img
                            src={a.url}
                            alt=""
                            loading="lazy"
                            className="h-9 w-9 flex-shrink-0 rounded object-cover"
                          />
                        ) : (
                          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded bg-neutral-800">
                            {KIND_ICONS.design}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-neutral-100">{a.name}</span>
                          <span className="block truncate text-[11px] leading-snug text-neutral-500">
                            {t(`designs.${a.designId}.name` as never)}
                            {a.designSubject ? ` — ${a.designSubject}` : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-neutral-800 px-2.5 py-2">
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  onBlur={() =>
                    setTimeout(() => {
                      // Not when the blur is the hand-off to a second-step input.
                      if (!pendingDesignRef.current && !libraryOpenRef.current) close()
                    }, 150)
                  }
                  placeholder={t('editor.filterPlaceholder')}
                  className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
                />
              </div>
              <div className="max-h-80 overflow-y-auto py-1">
                {flat.length === 0 && (
                  <div className="px-3 py-2 text-xs italic text-neutral-500">
                    {t('editor.noModelMatch', { query })}
                  </div>
                )}
                {groups.map((group, gi) => (
                  <div
                    key={group.kind}
                    className={gi > 0 ? 'mt-1 border-t border-neutral-800/60 pt-1' : ''}
                  >
                    <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                      {t(`editor.kinds.${group.kind}`)}
                    </div>
                    {group.items.map((entry) => {
                      const idx = flat.indexOf(entry)
                      return (
                        <button
                          key={entry.id}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            choose(entry)
                          }}
                          onMouseEnter={() => setActive(idx)}
                          title={entry.recipe ? undefined : entry.id}
                          className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left ${
                            idx === active ? 'bg-neutral-800' : ''
                          }`}
                        >
                          <span className="mt-0.5 flex-shrink-0">{KIND_ICONS[entry.kind]}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-neutral-100">
                              {entry.label}
                            </span>
                            <span className="block truncate text-[11px] leading-snug text-neutral-500">
                              {entry.desc}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Style-template picker — the video's art direction, shared by every shot's prompts. */
function StyleMenu({
  current,
  onSelect
}: {
  current: string | null
  onSelect: (styleId: string | null) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  function choose(styleId: string | null) {
    onSelect(styleId)
    setOpen(false)
  }

  return (
    <div className="relative">
      <Button
        variant={current ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        title={t('editor.styleTitle')}
      >
        <Palette className="h-3.5 w-3.5" />{' '}
        {current ? t(`styles.${current}.name` as never) : t('editor.style')}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 min-w-56 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              choose(null)
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800 ${
              current === null ? 'text-accent' : 'text-neutral-400'
            }`}
          >
            {t('editor.styleNone')}
          </button>
          {STYLES.map((style) => (
            <button
              key={style.id}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(style.id)
              }}
              className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-neutral-800 ${
                current === style.id ? 'text-accent' : 'text-neutral-200'
              }`}
            >
              <span className="text-sm">{t(`styles.${style.id}.name` as never)}</span>
              <span className="text-[10px] text-neutral-500">
                {t(`styles.${style.id}.desc` as never)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Dropdown({
  label,
  icon,
  variant = 'secondary',
  children
}: {
  label: string
  icon?: React.ReactNode
  variant?: 'secondary' | 'ghost'
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <Button
        variant={variant}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      >
        {icon} {label}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 min-w-48 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          {children}
        </div>
      )}
    </div>
  )
}

function DropdownItem({
  children,
  onClick,
  icon
}: {
  children: React.ReactNode
  onClick: () => void
  icon?: React.ReactNode
}) {
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
    >
      {icon} {children}
    </button>
  )
}
