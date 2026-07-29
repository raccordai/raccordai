import { useReactFlow } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightToLine,
  ChevronDown,
  Clapperboard,
  FileImage,
  FlaskConical,
  FileVideo,
  FolderInput,
  Loader2,
  Maximize2,
  Music,
  Palette,
  PenTool,
  Plus,
  Redo2,
  Search,
  Sparkles,
  Undo2
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  AssetWithUrl,
  GraphEdge,
  GraphNode,
  Video,
  VideoAspectRatio,
  VideoResolution
} from '@shared/ipc/contracts'
import { MODELS, getModel, videoDefaultParams } from '@shared/models'
import { STYLES, type StyleTemplate } from '@shared/styles/registry'
import {
  RECIPES,
  buildRecipePrompt,
  defaultModeOf,
  getRecipeMode,
  recipeFieldsFor,
  recipeModelChoices,
  type Recipe,
  type RecipeValues
} from '@shared/designs/registry'
import { invoke } from '@renderer/lib/ipc'
import { Button } from '@renderer/components/ui/Button'
import { useDismissable } from '@renderer/components/ui/useDismissable'
import { useToast } from '@renderer/components/feedback/Feedback'
import { Logo } from '@renderer/components/Logo'
import { graphKeys, useIpcMutation, useProject, useVideo } from './data'
import { useNodeCreation, type CreateRecipeArgs, type SourceNodeOption } from './useNodeCreation'
import type { LayoutDirection } from './autoLayout'

interface Props {
  videoId: string
  projectId: string
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  onTidy: (direction: LayoutDirection) => void
  onFit: () => void
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
  onRunAllVideos,
  runningAllVideos,
  videoNodeCount
}: Props) {
  const { t } = useTranslation()
  const { screenToFlowPosition } = useReactFlow()
  const video = useVideo(videoId).data
  const nodeCreation = useNodeCreation(videoId, projectId)
  const project = useProject(projectId).data
  const { mutate: setStyle } = useIpcMutation('videos:setStyle', [['videos']])
  const { mutate: setDefaults } = useIpcMutation('videos:setDefaults', [['videos']])
  const { mutate: setDraftMode } = useIpcMutation('videos:setDraftMode', [['videos']])
  const { mutate: setQcEnabled } = useIpcMutation('videos:setQcEnabled', [['videos']])
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const { mutateAsync: applyDefaults } = useIpcMutation('nodes:applyVideoDefaults', [
    graphKeys.graph(videoId),
    ['history']
  ])
  const toast = useToast()

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
      {video?.draftMode && (
        <span
          className="ml-1 flex flex-shrink-0 items-center gap-1 rounded-full bg-accent-soft/15 px-2 py-0.5 text-[10px] font-semibold text-accent-soft"
          title={t('editor.draft.badgeTitle')}
        >
          <FlaskConical className="h-3 w-3" /> {t('editor.draft.badge')}
        </span>
      )}

      <div className="flex-1" />

      {/* Right: actions */}
      <AddNodeMenu
        onAdd={(modelId) => void nodeCreation.addNode(modelId, spawnPosition())}
        onAddRecipe={(args) => void nodeCreation.addRecipeNode(args, spawnPosition())}
        libraryAssets={nodeCreation.designAssets}
        projectAssets={nodeCreation.projectAssets}
        sourceNodes={nodeCreation.sourceNodes}
        style={nodeCreation.style}
        onAddFromLibrary={(asset) => void nodeCreation.addLibraryDesignNode(asset, spawnPosition())}
      />

      <StyleMenu
        video={video}
        graph={graph}
        onSelect={(styleId) => setStyle({ videoId, styleId })}
        onSetDefaults={(defaults) => setDefaults({ videoId, ...defaults })}
        onApplyDefaults={() => {
          void applyDefaults({ videoId }).then(({ updated }) =>
            toast.success(t('editor.videoDefaults.applied', { count: updated }))
          )
        }}
        onSetDraftMode={(enabled) => setDraftMode({ videoId, enabled })}
        onSetQcEnabled={(enabled) => setQcEnabled({ videoId, enabled })}
        onFinalize={() => setFinalizeOpen(true)}
      />
      {finalizeOpen && <FinalizeModal videoId={videoId} onClose={() => setFinalizeOpen(false)} />}

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
          <Sparkles className="h-3.5 w-3.5" />
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
        <Maximize2 className="h-3.5 w-3.5" />
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
  /** Secondary line: what the entry does (localized for recipes/asset, product data for models). */
  desc: string
  kind: 'design' | 'shot' | 'image' | 'video' | 'audio' | 'asset'
  /** Set on recipe entries — choosing one opens the recipe form instead of adding. */
  recipe?: Recipe
  /** Set on the "from library" entry — choosing it opens the design-asset picker step. */
  library?: boolean
  /** Use-case tags from ModelDefinition.recommendedFor — badges + recommended sort. */
  tags?: string[]
}

const KIND_ICONS: Record<AddEntry['kind'], React.ReactNode> = {
  design: <PenTool className="h-3.5 w-3.5 text-highlight" />,
  shot: <Clapperboard className="h-3.5 w-3.5 text-accent" />,
  image: <FileImage className="h-3.5 w-3.5 text-accent-soft" />,
  video: <FileVideo className="h-3.5 w-3.5 text-accent" />,
  audio: <Music className="h-3.5 w-3.5 text-highlight-soft" />,
  asset: <FolderInput className="h-3.5 w-3.5 text-warning" />
}
// Recipes first: the guided entries are the beginner-friendly starting point,
// and a shot preset is a better default than a bare video model.
const KIND_ORDER: AddEntry['kind'][] = ['design', 'shot', 'image', 'video', 'audio', 'asset']

/** Lowercase + strip accents so an accented query still matches "Seedance". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export interface AddNodeActions {
  onAdd: (modelId: string) => void
  /** Adds a recipe node (design sheet or shot preset), source wired in one undo step. */
  onAddRecipe?: (args: CreateRecipeArgs) => void
  /** Published design sheets of the project. */
  libraryAssets?: AssetWithUrl[]
  onAddFromLibrary?: (asset: AssetWithUrl) => void
  /** Every project asset — the pool a from-image/from-video mode picks from. */
  projectAssets?: AssetWithUrl[]
  /** Graph nodes usable as a recipe source (the previous clip, a validated sheet). */
  sourceNodes?: SourceNodeOption[]
  /** The video's art direction, so the form previews the prompt that will really run. */
  style?: StyleTemplate
}

/** Toolbar trigger around the shared panel (the pane right-click reuses AddNodePanel). */
function AddNodeMenu(props: AddNodeActions) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Was dismissed by the search input's onBlur + a 150 ms timer, which only
  // fired when the click landed on something focusable.
  useDismissable(open, close, rootRef)

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={t('editor.addNodeTitle')}
      >
        <Plus className="h-3.5 w-3.5" /> {t('editor.addNode')}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1">
          <AddNodePanel {...props} onClose={close} />
        </div>
      )}
    </div>
  )
}

/**
 * Type-to-filter node catalogue (models, recipes, library sheets, asset entry)
 * — shared between the toolbar button and the canvas right-click menu (§4.6).
 * Unmounting on close resets every step.
 */
export function AddNodePanel({
  onAdd,
  onAddRecipe,
  libraryAssets,
  onAddFromLibrary,
  projectAssets,
  sourceNodes,
  style,
  onClose
}: AddNodeActions & { onClose: () => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** Non-null while the second step (the recipe form) is showing. */
  const [pendingRecipe, setPendingRecipe] = useState<Recipe | null>(null)
  /** True while the design-asset picker step is showing. */
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
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
      ...(onAddRecipe
        ? RECIPES.map((r) => ({
            id: `recipe:${r.id}`,
            label: t(`designs.${r.id}.name` as never) as string,
            desc: t(`designs.${r.id}.desc` as never) as string,
            kind: (r.kind === 'shot' ? 'shot' : 'design') as AddEntry['kind'],
            recipe: r
          }))
        : []),
      // Model label/description are product data (English), like the ids — not localized.
      ...MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        desc: `${m.description.split('.')[0]}.`,
        kind: m.kind as AddEntry['kind'],
        tags: m.recommendedFor
      })),
      {
        id: 'studio/asset',
        label: t('editor.assetEntry'),
        desc: t('editor.assetEntryDesc'),
        kind: 'asset'
      }
    ],
    [t, onAddRecipe, onAddFromLibrary, libraryAssets]
  )

  const q = normalize(query.trim())
  const filtered = q
    ? entries.filter((e) =>
        normalize(`${e.label} ${e.desc} ${e.id} ${e.kind} ${(e.tags ?? []).join(' ')}`).includes(q)
      )
    : entries
  // Recommended sort: entries whose use-case tags match the query rank first
  // within their group ("character" surfaces the character-consistency models).
  const tagMatches = (e: AddEntry): boolean =>
    q !== '' && (e.tags ?? []).some((tag) => normalize(tag).includes(q))
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: filtered
      .filter((e) => e.kind === kind)
      .sort((a, b) => Number(tagMatches(b)) - Number(tagMatches(a)))
  })).filter((g) => g.items.length > 0)
  // Flat list (in render order) for keyboard navigation across group boundaries.
  const flat = groups.flatMap((g) => g.items)

  // Reset the highlight to the first hit whenever the filter changes.
  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!pendingRecipe && !libraryOpen) inputRef.current?.focus()
  }, [pendingRecipe, libraryOpen])

  useEffect(() => {
    if (libraryOpen) libraryInputRef.current?.focus()
  }, [libraryOpen])

  function close() {
    // Unmounting resets the query/steps — the caller owns the visibility.
    onClose()
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
      // Second step: the recipe form (fields + mode + prompt preview).
      setPendingRecipe(entry.recipe)
      return
    }
    onAdd(entry.id)
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
    <div
      className={`overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl ${
        pendingRecipe ? 'w-96' : 'w-80'
      }`}
    >
      {pendingRecipe ? (
        <RecipeForm
          recipe={pendingRecipe}
          style={style}
          projectAssets={projectAssets ?? []}
          sourceNodes={sourceNodes ?? []}
          onBack={() => setPendingRecipe(null)}
          onSubmit={(args) => {
            onAddRecipe?.(args)
            close()
          }}
        />
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
                        {entry.tags && entry.tags.length > 0 && (
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {entry.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-accent/10 px-1.5 py-px text-[9px] text-accent-soft"
                              >
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
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
  )
}

/**
 * Step 2 of the add-node menu: the recipe FORM (§6.8). One free-text box used
 * to be the whole guidance — the user typed a subject and bought a prompt they
 * never saw. Here every choice the recipe knows how to make is an enumerated
 * field, the mode says whether the node is described or built from an existing
 * image/clip, and the exact prompt that will run is one click away: the same
 * pure builder the main service will use, so the preview cannot drift from the
 * result.
 */
function RecipeForm({
  recipe,
  style,
  projectAssets,
  sourceNodes,
  onBack,
  onSubmit
}: {
  recipe: Recipe
  style?: StyleTemplate
  projectAssets: AssetWithUrl[]
  sourceNodes: SourceNodeOption[]
  onBack: () => void
  onSubmit: (args: CreateRecipeArgs) => void
}) {
  const { t } = useTranslation()
  const [modeId, setModeId] = useState(defaultModeOf(recipe).id)
  const [modelId, setModelId] = useState(defaultModeOf(recipe).modelId)
  const [values, setValues] = useState<RecipeValues>({})
  const [sourceRef, setSourceRef] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    descriptionRef.current?.focus()
  }, [])

  const mode = getRecipeMode(recipe, modeId) ?? defaultModeOf(recipe)
  const fields = recipeFieldsFor(recipe, mode)
  const [subjectField, ...optionFields] = fields
  // A shot preset reads the same across the Seedance 2 tiers; a design recipe
  // switches model by switching mode, so it offers no choice here.
  const modelChoices = recipeModelChoices(recipe, mode)
  const effectiveModelId = modelChoices.includes(modelId) ? modelId : mode.modelId

  const sourceOptions = mode.source
    ? [
        ...sourceNodes
          .filter((n) => n.kind === mode.source!.accepts)
          .map((n) => ({ value: `node:${n.id}`, label: n.label })),
        ...projectAssets
          .filter((a) => a.kind === mode.source!.accepts)
          .map((a) => ({ value: `asset:${a.id}`, label: a.name }))
      ]
    : []

  const prompt = buildRecipePrompt(recipe, effectiveModelId, {
    values,
    ...(style ? { style } : {}),
    mode
  })
  const missingSubject = (values.description ?? '').trim() === ''
  const missingSource = mode.source?.required === true && sourceRef === ''
  const canSubmit = !missingSubject && !missingSource

  function submit() {
    if (!canSubmit) return
    const [kind, id] = sourceRef.split(':')
    onSubmit({
      recipeId: recipe.id,
      modeId: mode.id,
      ...(effectiveModelId === mode.modelId ? {} : { modelId: effectiveModelId }),
      values,
      ...(kind && id ? { source: kind === 'asset' ? { assetId: id } : { nodeId: id } } : {})
    })
  }

  const inputClass =
    'w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none'

  return (
    <div className="max-h-[32rem] overflow-y-auto p-2.5">
      <div className="flex items-center gap-2">
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            onBack()
          }}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={t('editor.designBack')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        {KIND_ICONS[recipe.kind === 'shot' ? 'shot' : 'design']}
        <span className="text-sm font-medium text-neutral-100">
          {t(`designs.${recipe.id}.name` as never)}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">{t('editor.designHint')}</p>

      {recipe.modes.length > 1 && (
        <div className="mt-2.5 flex gap-1 rounded-md bg-neutral-950 p-0.5">
          {recipe.modes.map((m) => (
            <button
              key={m.id}
              onMouseDown={(e) => {
                e.preventDefault()
                setModeId(m.id)
                setModelId(m.modelId)
                setSourceRef('')
              }}
              className={`flex-1 rounded px-2 py-1 text-[11px] ${
                m.id === mode.id
                  ? 'bg-accent/20 font-medium text-accent-soft'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t(`recipeModes.${m.id}.label` as never)}
            </button>
          ))}
        </div>
      )}

      <label className="mt-2.5 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {t(`recipeFields.${subjectField!.key}.label` as never)}
      </label>
      <textarea
        ref={descriptionRef}
        rows={2}
        value={values.description ?? ''}
        onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onBack()
          }
        }}
        placeholder={t(`designs.${recipe.id}.placeholder` as never)}
        className={`mt-1 resize-none ${inputClass}`}
      />

      {mode.source && (
        <>
          <label className="mt-2 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            {t('editor.recipeSource')}
          </label>
          <select
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            className={`mt-1 ${inputClass}`}
          >
            <option value="">{t('editor.recipeSourcePlaceholder')}</option>
            {sourceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {sourceOptions.length === 0 && (
            <p className="mt-1 text-[10px] leading-snug text-warning">
              {t('editor.recipeSourceNone')}
            </p>
          )}
        </>
      )}

      {optionFields.length > 0 && (
        <button
          onMouseDown={(e) => {
            e.preventDefault()
            setShowMore((v) => !v)
          }}
          className="mt-2 flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${showMore ? 'rotate-180' : ''}`} />
          {t('editor.recipeMore')}
        </button>
      )}

      {showMore && (
        <div className="mt-1.5 space-y-2">
          {modelChoices.length > 1 && (
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                {t('editor.recipeModel')}
              </label>
              <select
                value={effectiveModelId}
                onChange={(e) => setModelId(e.target.value)}
                className={`mt-1 ${inputClass}`}
              >
                {modelChoices.map((id) => (
                  <option key={id} value={id}>
                    {getModel(id)?.label ?? id}
                  </option>
                ))}
              </select>
            </div>
          )}
          {optionFields.map((field) => (
            <div key={field.key}>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                {t(`recipeFields.${field.key}.label` as never)}
              </label>
              {field.options ? (
                <select
                  value={values[field.key] ?? field.defaultValue ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  className={`mt-1 ${inputClass}`}
                >
                  {field.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(`recipeFields.${field.key}.options.${o.value}` as never)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  placeholder={t(`recipeFields.${field.key}.placeholder` as never)}
                  className={`mt-1 ${inputClass}`}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* The prompt the run will really use — built by the same pure function
          the main service calls, so what is previewed is what is created. */}
      <button
        onMouseDown={(e) => {
          e.preventDefault()
          setShowPreview((v) => !v)
        }}
        className="mt-2 flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
      >
        <ChevronDown
          className={`h-3 w-3 transition-transform ${showPreview ? 'rotate-180' : ''}`}
        />
        {showPreview ? t('editor.recipePreviewHide') : t('editor.recipePreviewShow')}
      </button>
      {showPreview && (
        <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-2 text-[10px] leading-relaxed text-neutral-300">
          {prompt}
          {style && (
            <p className="mt-1.5 italic text-neutral-500">
              {t('editor.styleAppliedAtRun', { style: t(`styles.${style.id}.name` as never) })}
            </p>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] text-neutral-600">
          {getModel(effectiveModelId)?.label ?? effectiveModelId}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          onMouseDown={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Plus className="h-3.5 w-3.5" /> {t('editor.designAdd')}
        </Button>
      </div>
      {missingSource && sourceOptions.length > 0 && (
        <p className="mt-1 text-[10px] text-neutral-500">{t('editor.recipeSourceRequired')}</p>
      )}
    </div>
  )
}

/** Selectable values for the video-level defaults ('' = leave the model default). */
const DEFAULT_ASPECT_OPTIONS: VideoAspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const DEFAULT_RESOLUTION_OPTIONS: VideoResolution[] = ['480p', '720p', '1080p', '1K', '2K', '4K']

/**
 * Style-template picker + video-level generation defaults (§4.5): the video's
 * art direction, and the default aspect/resolution pre-filled on new nodes,
 * with an explicit journaled "apply to N existing nodes" sweep.
 */
function StyleMenu({
  video,
  graph,
  onSelect,
  onSetDefaults,
  onApplyDefaults,
  onSetDraftMode,
  onSetQcEnabled,
  onFinalize
}: {
  video: Video | null | undefined
  graph: { nodes: GraphNode[] }
  onSelect: (styleId: string | null) => void
  onSetDefaults: (defaults: {
    defaultAspectRatio?: VideoAspectRatio | null
    defaultResolution?: VideoResolution | null
  }) => void
  onApplyDefaults: () => void
  onSetDraftMode: (enabled: boolean) => void
  onSetQcEnabled: (enabled: boolean) => void
  onFinalize: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = video?.styleId ?? null

  // Outside click + Escape (an onBlur close would swallow the selects inside).
  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    rootRef
  )

  function choose(styleId: string | null) {
    onSelect(styleId)
    setOpen(false)
  }

  // Nodes whose params would actually change if the defaults were applied.
  const applicableCount = useMemo(() => {
    if (!video) return 0
    return graph.nodes.filter((n) => {
      const patch = videoDefaultParams(n.modelId, video)
      const params = (n.params ?? {}) as Record<string, unknown>
      return Object.entries(patch).some(([k, v]) => params[k] !== v)
    }).length
  }, [graph.nodes, video])

  const selectClass =
    'w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-accent focus:outline-none'

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant={current ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={t('editor.styleTitle')}
      >
        <Palette className="h-3.5 w-3.5" />{' '}
        <span className="max-w-28 truncate">
          {current ? t(`styles.${current}.name` as never) : t('editor.style')}
        </span>
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-64 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          <button
            onClick={() => choose(null)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800 ${
              current === null ? 'text-accent' : 'text-neutral-400'
            }`}
          >
            {t('editor.styleNone')}
          </button>
          {STYLES.map((style) => (
            <button
              key={style.id}
              onClick={() => choose(style.id)}
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

          <div className="border-t border-neutral-800 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {t('editor.videoDefaults.title')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] text-neutral-400">
                  {t('editor.videoDefaults.aspect')}
                </span>
                <select
                  className={selectClass}
                  value={video?.defaultAspectRatio ?? ''}
                  onChange={(e) =>
                    onSetDefaults({
                      defaultAspectRatio: (e.target.value || null) as VideoAspectRatio | null
                    })
                  }
                >
                  <option value="">{t('editor.videoDefaults.none')}</option>
                  {DEFAULT_ASPECT_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] text-neutral-400">
                  {t('editor.videoDefaults.resolution')}
                </span>
                <select
                  className={selectClass}
                  value={video?.defaultResolution ?? ''}
                  onChange={(e) =>
                    onSetDefaults({
                      defaultResolution: (e.target.value || null) as VideoResolution | null
                    })
                  }
                >
                  <option value="">{t('editor.videoDefaults.none')}</option>
                  {DEFAULT_RESOLUTION_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-neutral-500">
              {t('editor.videoDefaults.hint')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2 w-full justify-center"
              disabled={applicableCount === 0}
              onClick={onApplyDefaults}
            >
              {t('editor.videoDefaults.apply', { count: applicableCount })}
            </Button>
          </div>

          {/* §6 iteration loop: draft mode + vision QC + finalize */}
          <div className="border-t border-neutral-800 p-3">
            <label className="flex cursor-pointer items-start justify-between gap-3">
              <span>
                <span className="block text-xs text-neutral-200">{t('editor.draft.toggle')}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-neutral-500">
                  {t('editor.draft.toggleHint')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={video?.draftMode ?? false}
                onChange={(e) => onSetDraftMode(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-600 bg-neutral-900"
              />
            </label>
            <label className="mt-3 flex cursor-pointer items-start justify-between gap-3">
              <span>
                <span className="block text-xs text-neutral-200">{t('editor.qc.toggle')}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-neutral-500">
                  {t('editor.qc.toggleHint')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={video?.qcEnabled ?? false}
                onChange={(e) => onSetQcEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-neutral-600 bg-neutral-900"
              />
            </label>
            {video?.draftMode && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full justify-center"
                onClick={() => {
                  setOpen(false)
                  onFinalize()
                }}
              >
                <FlaskConical className="h-3.5 w-3.5" /> {t('editor.draft.finalize')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * §6.1 finalize preview: nodes whose selected generation is a draft, the
 * credits already spent in draft vs the estimate on the real models, and the
 * button that re-runs them all (the batch selects each success as it settles).
 */
function FinalizeModal({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const plan = useQuery({
    queryKey: ['finalizePlan', videoId],
    queryFn: () => invoke('generations:planFinalize', { videoId })
  })
  const rows = plan.data?.rows ?? []

  function confirm() {
    const count = rows.length
    void invoke('generations:finalizeVideo', { videoId })
      .then(({ succeeded, failed }) =>
        toast.success(t('editor.draft.finalizeDone', { succeeded, failed }))
      )
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
    toast.success(t('editor.draft.finalizeStarted', { count }))
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island w-full max-w-md px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-neutral-100">
          {t('editor.draft.finalizeTitle')}
        </h2>
        <p className="mt-1 text-[11px] leading-snug text-neutral-500">
          {t('editor.draft.finalizeHint')}
        </p>
        {plan.isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500">
            <Loader2 className="h-3 w-3 animate-spin" /> …
          </div>
        ) : rows.length === 0 ? (
          <div className="mt-3 text-xs text-neutral-500 italic">
            {t('editor.draft.finalizeEmpty')}
          </div>
        ) : (
          <>
            <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
              {rows.map((row) => (
                <li key={row.nodeId} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-neutral-300">{row.label}</span>
                  <span className="font-mono text-neutral-400">
                    {row.draftCredits !== null
                      ? t('editor.costModal.credits', { credits: row.draftCredits })
                      : t('editor.costModal.unknownCost')}
                    {' → '}
                    {row.finalCredits !== null
                      ? t('editor.costModal.credits', { credits: row.finalCredits })
                      : t('editor.costModal.unknownCost')}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-baseline justify-between border-t border-neutral-800 pt-2 text-xs">
              <span className="font-semibold text-neutral-200">{t('editor.costModal.total')}</span>
              <span className="font-mono font-semibold text-neutral-100">
                {t('editor.costModal.credits', { credits: plan.data?.totalDraft ?? 0 })} (
                {t('editor.draft.draftCost')}) {' → '}
                {t('editor.costModal.credits', { credits: plan.data?.totalFinal ?? 0 })} (
                {t('editor.draft.finalCost')})
              </span>
            </div>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={confirm} disabled={rows.length === 0} autoFocus>
            {t('editor.draft.finalizeConfirm', { count: rows.length })}
          </Button>
        </div>
      </div>
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
  const rootRef = useRef<HTMLDivElement>(null)
  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    rootRef
  )

  return (
    <div className="relative" ref={rootRef}>
      <Button variant={variant} size="sm" onClick={() => setOpen((v) => !v)}>
        {icon} {label}
      </Button>
      {open && (
        <div
          // Dismissal is the container's job now, so items can close it on a
          // plain click instead of racing an onBlur timer with onMouseDown.
          onClick={() => setOpen(false)}
          className="absolute left-0 z-20 mt-1 min-w-48 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl"
        >
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
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
    >
      {icon} {children}
    </button>
  )
}
