import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cpu,
  Film,
  Image as ImageIcon,
  Loader2
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { GraphEdge, GraphNode } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import { formatSeconds } from '../../lib/formatSeconds'
import { useNodeGenerations, useTimelineFallbackImages } from './data'

interface Props {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  videoId: string
  /** Recenter the React Flow canvas on the given node (clicking a clip jumps to its node). */
  onFocusNode?: (nodeId: string) => void
  /** Collapsed (hidden) state — owned by the parent so the toolbar can toggle it too. */
  collapsed: boolean
  setCollapsed: (v: boolean) => void
}

/**
 * Extracts the shot number from a node's title — the first number found in the
 * label (e.g. "Clip — Shot 28" → 28, "03 - finale" → 3), falling back to the
 * node key. Undefined when neither contains a number.
 */
export function shotNumber(node: GraphNode): number | undefined {
  for (const s of [node.label, node.key]) {
    if (typeof s === 'string') {
      const m = s.match(/\d+/)
      if (m) return parseInt(m[0], 10)
    }
  }
  return undefined
}

/**
 * Timeline display order = the shot number in the node's title (01, 02, 03…).
 * The title is the source of truth: when a shot fails and the user renames
 * another node to take its place, the timeline follows the rename — no need to
 * move anything on the canvas. Numbered nodes come first (sorted numerically,
 * so 2 < 12); unnumbered ones fall back to canvas position (Y, then X), which
 * is also the tiebreaker for equal/missing numbers.
 *
 * We deliberately don't use topological order here: parallel chains (e.g. four
 * independent shots with no cross-edges) all sit at the same dependency depth
 * and would be returned in whatever order Kahn's queue popped them.
 *
 * Execution order is still topological — see `topologicalOrder` in WorkflowEditor.tsx
 * which is what `Run all` relies on.
 */
export function timelineOrder(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => {
    const na = shotNumber(a)
    const nb = shotNumber(b)
    if (na !== undefined && nb !== undefined && na !== nb) return na - nb
    if ((na !== undefined) !== (nb !== undefined)) return na !== undefined ? -1 : 1
    return a.position.y - b.position.y || a.position.x - b.position.x
  })
}

/**
 * The ordered list of clips that make up the timeline: every video-kind node
 * (asset nodes excluded), ordered by shot number.
 * Shared with the FCPXML export so what you see is what you export.
 *
 * Replacement workflow: when a shot fails, the user renames another node to
 * take over its number — leaving two nodes with the same shot number. Only one
 * gets the slot: the node with a usable output wins (`selectedGenerationId` is
 * only set once a generation succeeded or the user picked one), then the most
 * recently updated. Unnumbered clips are all kept.
 */
export function collectTimelineClips(nodes: GraphNode[]): GraphNode[] {
  const videos = nodes.filter((n) => {
    if (n.modelId === 'studio/asset') return false
    return getModel(n.modelId)?.kind === 'video'
  })

  const score = (n: GraphNode) => (n.selectedGenerationId ? 1 : 0)
  const byNumber = new Map<number, GraphNode>()
  const unnumbered: GraphNode[] = []
  for (const n of videos) {
    const num = shotNumber(n)
    if (num === undefined) {
      unnumbered.push(n)
      continue
    }
    const current = byNumber.get(num)
    if (
      !current ||
      score(n) - score(current) > 0 ||
      (score(n) === score(current) && n.updatedAt > current.updatedAt)
    ) {
      byNumber.set(num, n)
    }
  }
  return timelineOrder([...byNumber.values(), ...unnumbered])
}

/**
 * The generation a timeline slot should display/export: the node's selected
 * generation when it's a playable success, otherwise the most recent successful
 * one (covers selections pointing at a failed retry or a stale id). `gens` must
 * be newest-first — the order `generations.listForNode` returns.
 */
export function bestGeneration<T extends { id: string; status: string; url?: string | null }>(
  node: GraphNode,
  gens: T[] | undefined
): T | undefined {
  if (!gens) return undefined
  const selected = node.selectedGenerationId
    ? gens.find((g) => g.id === node.selectedGenerationId)
    : undefined
  if (selected?.status === 'success' && selected.url) return selected
  return gens.find((g) => g.status === 'success' && !!g.url) ?? selected
}

/** Best-effort duration extraction from a video node's params (Seedance & Grok both use `duration` seconds). */
export function clipDuration(node: GraphNode): number | undefined {
  const d = (node.params as { duration?: unknown } | undefined)?.duration
  return typeof d === 'number' ? d : undefined
}

export function clipResolution(node: GraphNode): string | undefined {
  const params = node.params as { resolution?: unknown; aspect_ratio?: unknown } | undefined
  const r = params?.resolution
  const a = params?.aspect_ratio
  if (typeof r === 'string' && typeof a === 'string') return `${r} · ${a}`
  if (typeof r === 'string') return r
  if (typeof a === 'string') return a
  return undefined
}

const HEIGHT_STORAGE_KEY = 'raccord:timeline-height'
const COLLAPSED_STORAGE_KEY = 'raccord:timeline-collapsed'
const MIN_HEIGHT = 160
const MAX_HEIGHT_VH = 0.8 // 80% of viewport

export function Timeline({ graph, videoId, onFocusNode, collapsed, setCollapsed }: Props) {
  // Only video-kind nodes go into the timeline, ordered by their visual layout.
  const clips = useMemo(() => collectTimelineClips(graph.nodes), [graph.nodes])

  // Input image per video node — shown as a still placeholder when the video failed.
  const fallbackImages = useTimelineFallbackImages(videoId).data

  const totalDuration = useMemo(
    () => clips.reduce((acc, n) => acc + (clipDuration(n) ?? 0), 0),
    [clips]
  )

  const [current, setCurrent] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { height, startDrag, dragging } = useResizableHeight()

  useEffect(() => {
    if (current >= clips.length) setCurrent(0)
  }, [clips.length, current])

  // Collapsed: show only a thin bar so the timeline can be hidden and restored.
  if (collapsed) {
    return (
      <div className="island flex items-center gap-3 overflow-hidden px-3 py-1.5 text-[11px]">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-semibold text-neutral-200 hover:bg-neutral-800"
          title="Show timeline"
        >
          <Film className="h-3.5 w-3.5 text-accent" /> Timeline
          <ChevronUp className="h-3.5 w-3.5 text-neutral-400" />
        </button>
        {clips.length > 0 && (
          <span className="text-neutral-500">
            {clips.length} clip{clips.length > 1 ? 's' : ''}
            {totalDuration > 0 && ` · ${formatSeconds(totalDuration)}`}
          </span>
        )}
      </div>
    )
  }

  if (clips.length === 0) {
    return (
      <div className="island relative flex h-32 items-center justify-center overflow-hidden text-xs text-neutral-600">
        <Film className="mr-2 h-4 w-4" /> Add video nodes to populate the timeline.
        <button
          onClick={() => setCollapsed(true)}
          className="absolute right-2 top-2 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title="Hide timeline"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const currentClip = clips[current] ?? clips[0]!
  const currentDur = clipDuration(currentClip)
  const currentRes = clipResolution(currentClip)

  return (
    <div className="island relative flex flex-col overflow-hidden" style={{ height }}>
      {/* Resize handle — drag to grow/shrink the timeline */}
      <div
        onPointerDown={startDrag}
        className={`group absolute left-0 right-0 top-0 z-10 h-2 -translate-y-1 cursor-row-resize ${
          dragging ? 'bg-accent/15' : 'bg-transparent hover:bg-accent/10'
        }`}
        title="Drag to resize the timeline"
      >
        <div
          className={`mx-auto h-1 w-12 translate-y-0.5 rounded-full transition ${
            dragging ? 'bg-accent' : 'bg-neutral-700 group-hover:bg-accent'
          }`}
        />
      </div>
      {/* ── Aggregate header ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px]">
        <span className="flex items-center gap-1.5 font-semibold text-neutral-200">
          <Film className="h-3.5 w-3.5 text-accent" /> Timeline
        </span>
        <span className="text-neutral-500">
          {clips.length} clip{clips.length > 1 ? 's' : ''}
        </span>
        {totalDuration > 0 && (
          <span className="flex items-center gap-1 text-neutral-500">
            <Clock className="h-3 w-3" /> {formatSeconds(totalDuration)} total
          </span>
        )}
        <span className="ml-auto text-neutral-500">
          Selected:{' '}
          <span className="text-neutral-200">
            {currentClip.label ?? currentClip.modelId.split('/').pop()}
          </span>{' '}
          ({current + 1}/{clips.length})
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          title="Hide timeline"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {/* ── Main row ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* Player */}
        <div className="flex w-[28rem] flex-shrink-0 flex-col border-r border-neutral-800">
          <PlayerPane
            node={currentClip}
            videoRef={videoRef}
            fallbackImageUrl={fallbackImages?.[currentClip.id]}
          />
          <div className="flex items-center justify-between gap-2 border-t border-neutral-800 px-2 py-1">
            <button
              onClick={() => setCurrent((c) => Math.max(0, c - 1))}
              disabled={current === 0}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
              title="Previous clip"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-[10px] text-neutral-400">
              <span className="truncate">
                {currentClip.label ?? currentClip.modelId.split('/').pop()}
              </span>
              <span className="flex items-center gap-1 rounded bg-accent/15 px-1 py-0.5 text-accent-soft">
                <Cpu className="h-2.5 w-2.5" />
                {getModel(currentClip.modelId)?.label ?? currentClip.modelId.split('/').pop()}
              </span>
              {currentDur !== undefined && (
                <span className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-300">
                  {currentDur}s
                </span>
              )}
              {currentRes && (
                <span className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-300">
                  {currentRes}
                </span>
              )}
            </div>
            <button
              onClick={() => setCurrent((c) => Math.min(clips.length - 1, c + 1))}
              disabled={current >= clips.length - 1}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
              title="Next clip"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Strip of clips */}
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-2">
          {clips.map((n, idx) => (
            <ClipThumb
              key={n.id}
              node={n}
              index={idx}
              total={clips.length}
              active={idx === current}
              fallbackImageUrl={fallbackImages?.[n.id]}
              onClick={() => {
                setCurrent(idx)
                onFocusNode?.(n.id)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlayerPane({
  node,
  videoRef,
  fallbackImageUrl
}: {
  node: GraphNode
  videoRef: React.RefObject<HTMLVideoElement | null>
  fallbackImageUrl?: string
}) {
  const gens = useNodeGenerations(node.id).data
  // Best playable output: the selected generation if successful, else the most
  // recent success — a selection stuck on a failed retry no longer hides a video.
  const selected = bestGeneration(node, gens)
  const anyRunning = gens?.some((g) => g.status === 'running')

  // Still placeholder = the input image standing in for a failed video.
  // `fallbackImageUrl` is only populated for nodes the server deems "in error";
  // the success guard avoids flashing the still over a freshly-succeeded retry while the query lags.
  const showStill = !!fallbackImageUrl && selected?.status !== 'success'

  // States: success+url → show paused (user presses play); failed+input image → still;
  // running → spinner; failed → error; nothing → placeholder.
  if (selected?.status === 'success' && selected.url) {
    return (
      <video
        ref={videoRef}
        key={selected.id}
        src={selected.url}
        controls
        preload="auto"
        className="h-full w-full bg-black"
      />
    )
  }

  if (showStill) {
    return (
      <div className="relative h-full w-full bg-black">
        <img src={fallbackImageUrl} alt="" className="h-full w-full object-contain" />
        <div className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-warning">
          <ImageIcon className="h-3 w-3" /> Still — video failed, showing input image
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-neutral-950 px-3 text-center text-xs">
      {anyRunning ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-warning" />
          <span className="text-warning">Generating…</span>
        </>
      ) : selected?.status === 'failed' ? (
        <>
          <AlertCircle className="h-5 w-5 text-danger" />
          <span className="text-danger">Generation failed</span>
          {selected.errorMessage && (
            <span className="line-clamp-2 text-[10px] text-neutral-500">
              {selected.errorMessage}
            </span>
          )}
        </>
      ) : (
        <>
          <Film className="h-5 w-5 text-neutral-700" />
          <span className="text-neutral-500">No output yet</span>
          <span className="text-[10px] text-neutral-600">
            Run "{node.label ?? node.modelId.split('/').pop()}" to populate this slot.
          </span>
        </>
      )}
    </div>
  )
}

function ClipThumb({
  node,
  index,
  total: _total,
  active,
  fallbackImageUrl,
  onClick
}: {
  node: GraphNode
  index: number
  total: number
  active: boolean
  fallbackImageUrl?: string
  onClick: () => void
}) {
  const gens = useNodeGenerations(node.id).data
  // Same "best playable output" rule as the player pane.
  const selected = bestGeneration(node, gens)
  const anyRunning = gens?.some((g) => g.status === 'running')
  const successCount = gens?.filter((g) => g.status === 'success').length ?? 0

  // A failed video with a resolvable input image is shown as a still placeholder.
  // `fallbackImageUrl` is only set for nodes the server deems "in error".
  const showStill = !!fallbackImageUrl && selected?.status !== 'success'

  const status: 'empty' | 'running' | 'success' | 'failed' | 'still' =
    selected?.status === 'success'
      ? 'success'
      : showStill
        ? 'still'
        : anyRunning
          ? 'running'
          : selected?.status === 'failed'
            ? 'failed'
            : 'empty'

  const borderClass = active
    ? 'border-accent'
    : status === 'success'
      ? 'border-neutral-700 hover:border-neutral-500'
      : status === 'running'
        ? 'border-warning/60'
        : status === 'still'
          ? 'border-warning/40'
          : status === 'failed'
            ? 'border-danger/60'
            : 'border-dashed border-neutral-800 hover:border-neutral-600'

  const dur = clipDuration(node)
  const res = clipResolution(node)
  const label = node.label ?? node.modelId.split('/').pop() ?? '?'
  const modelLabel = getModel(node.modelId)?.label ?? node.modelId.split('/').pop() ?? node.modelId

  return (
    <button
      onClick={onClick}
      className={`group relative flex w-44 flex-shrink-0 flex-col overflow-hidden rounded border-2 bg-neutral-900 text-left transition ${borderClass}`}
    >
      {/* Thumbnail area */}
      <div className="relative aspect-video bg-neutral-950">
        {status === 'success' && selected?.url ? (
          <video src={selected.url} muted className="h-full w-full object-cover" />
        ) : status === 'still' ? (
          <img src={fallbackImageUrl} alt="" className="h-full w-full object-cover" />
        ) : status === 'running' ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-warning" />
          </div>
        ) : status === 'failed' ? (
          <div className="flex h-full w-full items-center justify-center">
            <AlertCircle className="h-5 w-5 text-danger" />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-600">
            empty
          </div>
        )}

        {/* Index badge top-left */}
        <div className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent-soft">
          {index + 1}
        </div>

        {/* Status icon top-right */}
        {status === 'success' && (
          <div className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5">
            <CheckCircle2 className="h-3 w-3 text-success" />
          </div>
        )}
        {status === 'still' && (
          <div
            className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-black/70 px-1 py-0.5 text-[8px] font-semibold text-warning"
            title="Video generation failed — input image used as a still"
          >
            <ImageIcon className="h-2.5 w-2.5" /> STILL
          </div>
        )}

        {/* Duration badge bottom-right */}
        {dur !== undefined && (
          <div className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-neutral-100">
            {formatSeconds(dur)}
          </div>
        )}
      </div>

      {/* Caption */}
      <div className="border-t border-neutral-800 px-1.5 py-1">
        <div className="truncate text-[11px] font-medium text-neutral-100" title={label}>
          {label}
        </div>
        <div
          className="mt-0.5 flex items-center gap-1 text-[9px] text-accent-soft/80"
          title={modelLabel}
        >
          <Cpu className="h-2.5 w-2.5 flex-shrink-0" />
          <span className="truncate">{modelLabel}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[9px] text-neutral-500">
          <span className="truncate">{res ?? node.modelId.split('/').pop()}</span>
          {successCount > 1 && (
            <span
              className="rounded bg-neutral-800 px-1 font-mono text-neutral-400"
              title={`${successCount} successful generations`}
            >
              {successCount}×
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

// ─── Collapsed (hidden) state hook ───────────────────────────────────────
// Lets the timeline be hidden down to a thin bar and restored, persisted across
// sessions like the height.
export function useCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  })

  const set = useCallback((v: boolean) => {
    setCollapsed(v)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, v ? '1' : '0')
    }
  }, [])

  return [collapsed, set]
}

// ─── Resizable height hook ───────────────────────────────────────────────
function readStoredHeight(): number {
  if (typeof window === 'undefined') return 256
  const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed)) return 256
  return clampHeight(parsed)
}

function clampHeight(h: number): number {
  const max = typeof window === 'undefined' ? 800 : Math.round(window.innerHeight * MAX_HEIGHT_VH)
  return Math.max(MIN_HEIGHT, Math.min(max, Math.round(h)))
}

export function useResizableHeight() {
  const [height, setHeight] = useState<number>(() => readStoredHeight())
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startHeight: height }
      setDragging(true)
    },
    [height]
  )

  useEffect(() => {
    if (!dragging) return
    function onMove(e: PointerEvent) {
      if (!dragRef.current) return
      // Dragging UP grows the timeline (we anchor at the bottom).
      const delta = dragRef.current.startY - e.clientY
      setHeight(clampHeight(dragRef.current.startHeight + delta))
    }
    function onUp() {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // Prevent text selection while dragging.
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = ''
    }
  }, [dragging])

  // Persist on stable height (when drag ends).
  useEffect(() => {
    if (dragging || typeof window === 'undefined') return
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height))
  }, [height, dragging])

  // Re-clamp if the window shrinks below the stored size.
  useEffect(() => {
    function onResize() {
      setHeight((h) => clampHeight(h))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return { height, startDrag, dragging }
}
