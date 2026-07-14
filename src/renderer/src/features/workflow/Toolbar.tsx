import { useReactFlow } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLine,
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
  Plus,
  Redo2,
  Search,
  Sparkles,
  Undo2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { GraphEdge, GraphNode } from '@shared/ipc/contracts'
import { MODELS, defaultParamsFor } from '@shared/models'
import { STYLES } from '@shared/styles/registry'
import { invoke } from '@renderer/lib/ipc'
import { useFlag } from '@renderer/features/flags/useFlags'
import { Button } from '@renderer/components/ui/Button'
import { Logo } from '@renderer/components/Logo'
import { graphKeys, useIpcMutation, useProject, useVideo } from './data'
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

  async function addNode(modelId: string) {
    // Spawn the node at the centre of the CURRENT viewport (not at fixed canvas
    // coords, which end up off-screen once the user has panned/zoomed away).
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect()
    const screenCentre = pane
      ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const centre = screenToFlowPosition(screenCentre)
    // Small cascade so consecutive adds don't stack exactly on top of each other.
    const cascade = (graph.nodes.length % 5) * 28
    const position = {
      x: Math.round(centre.x - 144 + cascade), // ~half a modelNode width
      y: Math.round(centre.y - 130 + cascade) // ~half a modelNode height
    }
    await createNode({
      videoId,
      modelId,
      position,
      params: modelId === 'studio/asset' ? {} : defaultParamsFor(modelId)
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
      <AddNodeMenu onAdd={addNode} />

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
  kind: 'image' | 'video' | 'audio' | 'asset'
}

const KIND_ICONS: Record<AddEntry['kind'], React.ReactNode> = {
  image: <FileImage className="h-3.5 w-3.5 text-accent-soft" />,
  video: <FileVideo className="h-3.5 w-3.5 text-accent" />,
  audio: <Music className="h-3.5 w-3.5 text-highlight-soft" />,
  asset: <FolderInput className="h-3.5 w-3.5 text-warning" />
}
const KIND_ORDER: AddEntry['kind'][] = ['image', 'video', 'audio', 'asset']

/** Lowercase + strip accents so an accented query still matches "Seedance". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function AddNodeMenu({ onAdd }: { onAdd: (modelId: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const entries = useMemo<AddEntry[]>(
    () => [
      ...MODELS.map((m) => ({ id: m.id, label: m.label, kind: m.kind as AddEntry['kind'] })),
      { id: 'studio/asset', label: t('editor.assetEntry'), kind: 'asset' }
    ],
    [t]
  )

  const q = normalize(query.trim())
  const filtered = q
    ? entries.filter((e) => normalize(`${e.label} ${e.id} ${e.kind}`).includes(q))
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
    if (open) inputRef.current?.focus()
  }, [open])

  function choose(entry: AddEntry | undefined) {
    if (!entry) return
    onAdd(entry.id)
    setOpen(false)
    setQuery('')
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
      setOpen(false)
      setQuery('')
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
        <div className="absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
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
            {groups.map((group) => (
              <div key={group.kind}>
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
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
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-200 ${
                        idx === active ? 'bg-neutral-800' : ''
                      }`}
                    >
                      {KIND_ICONS[entry.kind]}
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      <span className="truncate text-[10px] text-neutral-600">{entry.id}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
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
