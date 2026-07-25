import {
  Background,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type Connection
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FocusNodePayload, GraphNode } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { ModelNode, AssetNode } from './nodes/ModelNode'
import { NodeParamsPanel } from './NodeParamsPanel'
import { useCollapsed } from './timelineHooks'
import { TimelineV2 } from './TimelineV2'
import { HistoryPanel } from './HistoryPanel'
import {
  Anchor,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  Image as ImageIcon,
  PanelBottom,
  PanelBottomClose,
  Play,
  Replace,
  Trash2
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/Button'
import { useAppMenus, useHeaderActions, type AppMenu } from '@renderer/components/menubar/MenuBar'
import { openAssistant } from '@renderer/features/assistant/assistantStore'
import { resetEditorContext, setEditorContext } from '@renderer/features/assistant/appContextStore'
import { WorkflowToolbar, AddNodePanel } from './Toolbar'
import { ExportDialog } from './ExportDialog'
import { useWorkflowIO } from './useWorkflowIO'
import { WorkflowGraphContext, edgeAliases, type WorkflowGraph } from './workflowContext'
import { autoLayoutPositions, resolveOverlaps, type LayoutDirection } from './autoLayout'
import { useLastFrameExtractor } from './useLastFrameExtractor'
import { graphKeys, useGraph, useIpcMutation, useProjectAssets } from './data'
import { useNodeCreation } from './useNodeCreation'
import { MODELS, getModel } from '@shared/models'

const NODE_TYPES = {
  modelNode: ModelNode,
  assetNode: AssetNode
}

/** "Don't ask again under X credits" — remembered locally on this machine. */
const COST_SKIP_KEY = 'raccord.costConfirmSkipUnder'

/**
 * In-app clipboard for node copy/paste (§4.6) — a workflow-JSON v1 fragment,
 * pasted through the importWorkflow validator with fresh keys and an offset.
 * Module-level so it survives switching videos (paste across videos of the
 * same project keeps working; asset references resolve project-wide).
 */
interface NodeClipboard {
  nodes: {
    key: string
    modelId: string
    label?: string
    intent?: string
    position: { x: number; y: number }
    params: Record<string, unknown>
  }[]
  edges: { from: string; to: string; input: string; output: string }[]
}
let nodeClipboard: NodeClipboard | null = null

interface CostPreviewState {
  rows: { id: string; label: string; credits: number | null }[]
  total: number
  /** Current kie.ai balance, null when unreachable (no key, offline). */
  balance: number | null
  resolve: (accepted: boolean) => void
}

/**
 * Pending frame-anchor guard (§4.6): a design sheet is about to be wired to a
 * frame anchor — the modal teaches the anchor/reference distinction and offers
 * to rewire to the target's reference input when it has one.
 */
interface AnchorGuardState {
  sourceLabel: string
  anchorHandleLabel: string
  /** Reference input available on the target model (null = none, no rewire CTA). */
  referenceHandle: { key: string; label: string } | null
  resolve: (choice: 'anchor' | 'reference' | 'cancel') => void
}

interface Props {
  videoId: string
  projectId: string
}

export function WorkflowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  )
}

function WorkflowEditorInner({ videoId, projectId }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const graph = useGraph(videoId).data
  // Needed by the frame-anchor guard: a studio/asset node's design category
  // lives on the asset, not in the node params.
  const projectAssets = useProjectAssets(projectId).data

  // Auto-extracts the last frame of every successful video generation in this
  // video so downstream `sourceHandle === 'lastFrame'` edges have a resolvable URL.
  useLastFrameExtractor(videoId, graph?.nodes ?? [])

  // No invalidation on plain drag-end: React Flow's local state is authoritative
  // during interaction, a refetch would fight the drag.
  const { mutate: updatePosition } = useIpcMutation('nodes:updatePosition')
  const { mutate: updatePositions, mutateAsync: updatePositionsAsync } = useIpcMutation(
    'nodes:updatePositions',
    [graphKeys.graph(videoId)]
  )
  const { mutate: removeNode } = useIpcMutation('nodes:remove', [
    graphKeys.graph(videoId),
    ['generations']
  ])
  const { mutate: connectEdge } = useIpcMutation('edges:connect', [graphKeys.graph(videoId)])
  const { mutate: disconnectEdge } = useIpcMutation('edges:disconnect', [graphKeys.graph(videoId)])
  const { mutate: undoGraph } = useIpcMutation('history:undo', [
    graphKeys.graph(videoId),
    ['generations'],
    ['history']
  ])
  const { mutate: redoGraph } = useIpcMutation('history:redo', [
    graphKeys.graph(videoId),
    ['generations'],
    ['history']
  ])
  const { fitView, screenToFlowPosition } = useReactFlow()
  const queryClient = useQueryClient()
  const nodeCreation = useNodeCreation(videoId, projectId)
  const { mutateAsync: createNodeAsync } = useIpcMutation('nodes:create', [
    graphKeys.graph(videoId)
  ])
  const { mutateAsync: replaceModelAsync } = useIpcMutation('nodes:replaceModel', [
    graphKeys.graph(videoId),
    ['generations']
  ])

  // Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z — skipped while typing in a field so text
  // editing keeps its native undo.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      if (e.shiftKey) redoGraph({ videoId })
      else undoGraph({ videoId })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [videoId, undoGraph, redoGraph])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** "Fix with the assistant" buttons → global sidebar with a prepared draft. */
  const askAssistant = useCallback((text: string) => {
    openAssistant(text)
  }, [])

  // Feed the assistant's per-send <app-context> snapshot (§4.10 phase 2).
  useEffect(() => {
    setEditorContext({ selectedNodeId })
  }, [selectedNodeId])
  useEffect(() => resetEditorContext, [])
  const [timelineCollapsed, setTimelineCollapsed] = useCollapsed()
  /** True while a "generate all videos" batch run is in flight. */
  const [runningAll, setRunningAll] = useState(false)
  /** Pending cost-preview modal for a multi-node run (null = none). */
  const [costPreview, setCostPreview] = useState<CostPreviewState | null>(null)
  /** Pending frame-anchor guard modal (null = none). */
  const [anchorGuard, setAnchorGuard] = useState<AnchorGuardState | null>(null)
  /** Pane right-click menu — add-node panel at the cursor (§4.6). */
  const [paneMenu, setPaneMenu] = useState<{
    x: number
    y: number
    flow: { x: number; y: number }
  } | null>(null)
  /** Node right-click menu — Run / Duplicate / Replace model / Delete (§4.6). */
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)

  // ── Local React Flow state, seeded from the store and reconciled on change ──
  // Local state lets React Flow update positions instantly during drag.
  // We persist on dragEnd only, and reconcile from server when the graph structure changes.
  const [rfNodes, setRfNodes] = useState<Node[]>([])
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  /** Ids of nodes currently being dragged — protected from server-side position overwrites. */
  const draggingRef = useRef<Set<string>>(new Set())
  /**
   * Ref so node `data.onRun` callbacks can invoke the latest handler without
   * making `serverNodes` re-build every time the closure is recreated.
   */
  const handleRunNodeRef = useRef<((nodeId: string) => Promise<void>) | null>(null)

  // Build the store-derived node data once per server update.
  // Belt-and-suspenders: we wire BOTH `onNodeClick` (RF canonical path) AND a
  // `data.onOpenPanel` callback that custom node components invoke on a body
  // click — sometimes RF's own click detection misses depending on the inner DOM.
  const serverNodes = useMemo(() => {
    if (!graph) return []
    return graph.nodes.map((n) => ({
      id: n.id,
      type: n.modelId === 'studio/asset' ? 'assetNode' : 'modelNode',
      position: n.position,
      data: {
        node: n,
        onOpenPanel: () => setSelectedNodeId(n.id),
        onRun: () => handleRunNodeRef.current?.(n.id)
      }
    })) satisfies Node[]
  }, [graph])

  const serverEdges = useMemo(() => {
    if (!graph) return []
    // @ImageN badge on the edge itself — the number the model sees is the
    // number the user sees (same ordering as the chips and the run engine).
    const aliases = edgeAliases(graph)
    return graph.edges.map((e) => {
      const alias = aliases.get(e.id)
      return {
        id: e.id,
        source: e.sourceNodeId,
        target: e.targetNodeId,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        ...(alias
          ? {
              label: alias,
              labelStyle: { fill: '#afdeff', fontSize: 10, fontFamily: 'monospace' },
              labelBgStyle: { fill: '#171717', fillOpacity: 0.9 },
              labelBgPadding: [4, 2] as [number, number],
              labelBgBorderRadius: 4
            }
          : {})
      }
    }) satisfies Edge[]
  }, [graph])

  // Reconcile local nodes whenever the server pushes a fresh snapshot:
  //   - Add new server nodes
  //   - Drop nodes the server no longer has
  //   - Refresh `data` so the latest row is reflected in the UI
  //   - Keep the local position if the user is mid-drag, otherwise take server's
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      return serverNodes.map((s) => {
        const local = prevById.get(s.id)
        if (!local) return s
        const isDragging = draggingRef.current.has(s.id)
        return {
          ...s,
          position: isDragging ? local.position : s.position,
          // Keep React Flow's measured dimensions — server snapshots don't have
          // them, and wiping them would re-trigger measurement churn.
          measured: local.measured
        }
      })
    })
  }, [serverNodes])

  useEffect(() => {
    setRfEdges(serverEdges)
  }, [serverEdges])

  // ── Push neighbours away when a node grows ──────────────────────────────
  // When a generation succeeds, the media preview makes the node taller and it
  // can end up covering nodes below. React Flow re-measures nodes on DOM size
  // changes; watch those measured heights and, on growth, shove any overlapping
  // neighbour out of the way (cascading), then persist the new positions.
  const measuredHeightsRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const grown: string[] = []
    for (const n of rfNodes) {
      const h = n.measured?.height
      if (h == null) continue
      const prev = measuredHeightsRef.current.get(n.id)
      measuredHeightsRef.current.set(n.id, h)
      // The first measurement is the baseline — only react to actual growth.
      if (prev != null && h > prev + 1) grown.push(n.id)
    }
    if (grown.length === 0) return
    const moved = resolveOverlaps(rfNodes, grown, draggingRef.current)
    if (moved.length === 0) return
    const movedById = new Map(moved.map((m) => [m.id, m.position]))
    setRfNodes((current) =>
      current.map((n) => {
        const position = movedById.get(n.id)
        return position ? { ...n, position } : n
      })
    )
    updatePositions({
      updates: moved.map((m) => ({ nodeId: m.id, position: m.position }))
    })
  }, [rfNodes, updatePositions])

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  )

  // ── Change handlers ─────────────────────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply locally first so drag feels instant.
      setRfNodes((nodes) => applyNodeChanges(changes, nodes))

      for (const change of changes) {
        if (change.type === 'position') {
          if (change.dragging) {
            draggingRef.current.add(change.id)
          } else if (change.dragging === false && change.position) {
            draggingRef.current.delete(change.id)
            updatePosition({
              nodeId: change.id,
              position: change.position
            })
          }
        }
        if (change.type === 'remove') {
          void confirmModal({
            message: t('editor.deleteNodeConfirm'),
            confirmLabel: t('library.delete'),
            danger: true
          }).then((accepted) => {
            if (accepted) {
              removeNode({ nodeId: change.id })
            } else {
              // Re-sync from server since we already applied the local removal.
              setRfNodes(serverNodes)
            }
          })
        }
      }
    },
    [updatePosition, removeNode, serverNodes, confirmModal, t]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setRfEdges((edges) => applyEdgeChanges(changes, edges))
      for (const change of changes) {
        if (change.type === 'remove') {
          disconnectEdge({ edgeId: change.id })
        }
      }
    },
    [disconnectEdge]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const { source: sourceId, target: targetId, targetHandle } = connection
      if (!sourceId || !targetId || !targetHandle) return
      void (async () => {
        // Design sheets (character/décor/prop) are references: wired to a frame
        // anchor they would literally appear on screen — warn before connecting.
        // Same rule for studio/asset nodes carrying a published design sheet.
        const source = graph?.nodes.find((n) => n.id === sourceId)
        const sourceParams = source?.params as
          { designId?: string; assetId?: string } | null | undefined
        const designId =
          sourceParams?.designId ??
          (source?.modelId === 'studio/asset' && sourceParams?.assetId
            ? (projectAssets?.find((a) => a.id === sourceParams.assetId)?.designId ?? undefined)
            : undefined)
        let resolvedTargetHandle = targetHandle
        if (designId) {
          const target = graph?.nodes.find((n) => n.id === targetId)
          const targetModel = target ? getModel(target.modelId) : undefined
          const handle = targetModel?.inputs.find((h) => h.key === targetHandle)
          if (handle?.frameAnchor) {
            // Styled two-column modal instead of a bare confirm: teaches the
            // anchor/reference distinction and can rewire to a reference input.
            const referenceInput = targetModel?.inputs.find(
              (h) => !h.frameAnchor && h.referenceAlias && h.accepts.includes('image')
            )
            const choice = await new Promise<'anchor' | 'reference' | 'cancel'>((resolve) =>
              setAnchorGuard({
                sourceLabel: source?.label ?? source?.key ?? '',
                anchorHandleLabel: handle.label,
                referenceHandle: referenceInput
                  ? { key: referenceInput.key, label: referenceInput.label }
                  : null,
                resolve
              })
            )
            setAnchorGuard(null)
            if (choice === 'cancel') return
            if (choice === 'reference' && referenceInput) {
              resolvedTargetHandle = referenceInput.key
            }
          }
        }
        connectEdge({
          videoId,
          sourceNodeId: sourceId,
          sourceHandle: connection.sourceHandle ?? 'output',
          targetNodeId: targetId,
          targetHandle: resolvedTargetHandle
        })
      })()
    },
    [connectEdge, videoId, graph, projectAssets]
  )

  // ── Recenter the canvas on a single node ────────────────────────────────
  // Used by the Timeline strip: clicking a clip pans/zooms the flow so the
  // matching node is centred and selected. fitView on a single-node set centres
  // it; maxZoom keeps it from blowing up to full zoom on a small node.
  const focusNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId)
      fitView({ nodes: [{ id: nodeId }], duration: 500, padding: 0.6, maxZoom: 1.2 })
    },
    [fitView]
  )

  // Clicking a completion notification (main process) centers the node it's about.
  useEffect(() => {
    return window.api.on('event:focusNode', (payload) => {
      const p = payload as FocusNodePayload
      if (p.videoId === videoId) focusNode(p.nodeId)
    })
  }, [videoId, focusNode])

  // ── Canvas affordances (§4.6): duplicate, copy/paste, media drop ────────

  /** Exact copy of a node (params/label/intent), offset so it doesn't stack. */
  const duplicateNode = useCallback(
    async (nodeId: string) => {
      const node = graph?.nodes.find((n) => n.id === nodeId)
      if (!node) return
      await createNodeAsync({
        videoId,
        modelId: node.modelId,
        position: { x: node.position.x + 48, y: node.position.y + 48 },
        params: (node.params as Record<string, unknown> | null) ?? {},
        label: node.label ?? undefined,
        intent: node.intent ?? undefined
      })
    },
    [graph, createNodeAsync, videoId]
  )

  /** Copy the selected nodes (and the edges between them) to the in-app clipboard. */
  const copySelection = useCallback((): boolean => {
    if (!graph) return false
    const selectedIds = new Set(rfNodes.filter((n) => n.selected).map((n) => n.id))
    if (selectedIds.size === 0) return false
    const keyById = new Map(graph.nodes.map((n) => [n.id, n.key]))
    const copied = graph.nodes.filter((n) => selectedIds.has(n.id))
    nodeClipboard = {
      nodes: copied.map((n) => ({
        key: n.key,
        modelId: n.modelId,
        label: n.label ?? undefined,
        intent: n.intent ?? undefined,
        position: n.position,
        params: (n.params as Record<string, unknown> | null) ?? {}
      })),
      edges: graph.edges
        .filter((e) => selectedIds.has(e.sourceNodeId) && selectedIds.has(e.targetNodeId))
        // Keep creation order so the @ numbering survives the round-trip.
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((e) => ({
          from: keyById.get(e.sourceNodeId)!,
          to: keyById.get(e.targetNodeId)!,
          input: e.targetHandle,
          output: e.sourceHandle
        }))
    }
    toast.info(t('editor.copied', { count: copied.length }))
    return true
  }, [graph, rfNodes, toast, t])

  /** Paste the clipboard fragment through the importWorkflow validator. */
  const pasteClipboard = useCallback(async () => {
    const clip = nodeClipboard
    if (!clip || clip.nodes.length === 0) return
    // Fresh keys so repeated pastes never collide with the originals.
    const suffix = Math.random().toString(36).slice(2, 6)
    const keyMap = new Map(clip.nodes.map((n) => [n.key, `${n.key}_${suffix}`]))
    const fragment = {
      version: 1,
      assets: [],
      nodes: clip.nodes.map((n) => ({
        ...n,
        key: keyMap.get(n.key)!,
        position: { x: n.position.x + 48, y: n.position.y + 48 }
      })),
      edges: clip.edges.map((e) => ({ ...e, from: keyMap.get(e.from)!, to: keyMap.get(e.to)! }))
    }
    try {
      const res = await invoke('workflow:import', {
        videoId,
        json: JSON.stringify(fragment),
        replace: false
      })
      void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
      toast.success(t('editor.pasted', { count: res.nodeCount }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [videoId, queryClient, toast, t])

  // Cmd/Ctrl+C / Cmd/Ctrl+V on the canvas — skipped while typing and when the
  // user is copying selected text (native copy keeps working).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key !== 'c' && key !== 'v') return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (key === 'c') {
        if (window.getSelection()?.toString()) return
        if (copySelection()) e.preventDefault()
      } else {
        e.preventDefault()
        void pasteClipboard()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [copySelection, pasteClipboard])

  /** Drop image/video/audio files on the canvas → import + asset node at the drop point. */
  const handleCanvasDrop = useCallback(
    async (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      e.preventDefault()
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const paths = files
        .map((f) => {
          try {
            return window.api.getPathForFile(f)
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      if (paths.length === 0) return
      try {
        const imported = await invoke('assets:importFromPaths', { projectId, paths })
        void queryClient.invalidateQueries({ queryKey: ['assets'] })
        for (const [i, asset] of imported.entries()) {
          await createNodeAsync({
            videoId,
            modelId: 'studio/asset',
            position: { x: flow.x + i * 40, y: flow.y + i * 40 },
            params: { assetId: asset.id },
            label: asset.name
          })
        }
        const skipped = paths.length - imported.length
        if (skipped > 0) toast.warning(t('editor.dropSkipped', { count: skipped }))
        else toast.success(t('editor.dropImported', { count: imported.length }))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [projectId, videoId, screenToFlowPosition, createNodeAsync, queryClient, toast, t]
  )

  // ── Auto-layout (Tidy) ──────────────────────────────────────────────────
  const handleTidy = useCallback(
    async (direction: LayoutDirection) => {
      if (rfNodes.length === 0) return
      const laidOut = autoLayoutPositions(rfNodes, rfEdges, direction)
      // Apply locally first for an instant snap.
      setRfNodes((current) =>
        current.map((n) => {
          const next = laidOut.find((l) => l.id === n.id)
          return next ? { ...n, position: next.position } : n
        })
      )
      // Persist in one batched mutation.
      await updatePositionsAsync({
        updates: laidOut.map((n) => ({
          nodeId: n.id,
          position: n.position
        }))
      })
      // Then refit the view.
      requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }))
    },
    [rfNodes, rfEdges, updatePositionsAsync, fitView]
  )

  /**
   * Smart per-node run — planned AND executed in the main process since §4.10
   * phase 4 (`generations:planRun` / `generations:runBatch`): dependency-aware,
   * shared upstreams generate once, independent branches in parallel, targets
   * regenerate unless `reuseTargets` (batch mode). The renderer keeps exactly
   * two concerns: the §4.4 cost gate (modal below) and failure feedback.
   */
  const runNodes = useCallback(
    async (targetNodeIds: string[], opts?: { reuseTargets?: boolean }) => {
      if (targetNodeIds.length === 0) return
      const reuseTargets = opts?.reuseTargets ?? false
      const plan = await invoke('generations:planRun', { videoId, targetNodeIds, reuseTargets })

      // Cost gate: multi-node runs get a per-node breakdown + total + balance
      // before any credit is spent; "don't ask under X" short-circuits it.
      if (plan.rows.length >= 2) {
        const skipUnder = Number(localStorage.getItem(COST_SKIP_KEY) ?? '0')
        if (!(skipUnder > 0 && plan.total <= skipUnder)) {
          const balance = await invoke('kie:credits')
            .then((r) => r.credits)
            .catch(() => null)
          const accepted = await new Promise<boolean>((resolve) =>
            setCostPreview({
              rows: plan.rows.map((r) => ({ id: r.nodeId, label: r.label, credits: r.credits })),
              total: plan.total,
              balance,
              resolve
            })
          )
          setCostPreview(null)
          if (!accepted) return
        }
      }

      const res = await invoke('generations:runBatch', { videoId, targetNodeIds, reuseTargets })
      if (res.failed > 0) {
        const message = t('editor.batchFailed', { count: res.failed })
        setEditorContext({ lastError: message })
        toast.error(message)
      }
    },
    [videoId, toast, t]
  )

  const handleRunNode = useCallback((targetNodeId: string) => runNodes([targetNodeId]), [runNodes])

  // "Generate all videos": run every video node in the graph (with its upstream
  // deps), skipping any that already have a successful output.
  const handleRunAllVideos = useCallback(async () => {
    if (!graph) return
    const videoIds = graph.nodes
      .filter((n) => getModel(n.modelId)?.kind === 'video')
      .map((n) => n.id)
    if (videoIds.length === 0) return
    setRunningAll(true)
    try {
      await runNodes(videoIds, { reuseTargets: true })
    } finally {
      setRunningAll(false)
    }
  }, [graph, runNodes])

  const videoNodeCount = useMemo(
    () => (graph?.nodes ?? []).filter((n) => getModel(n.modelId)?.kind === 'video').length,
    [graph]
  )

  // "Fichier" menu in the app menu bar — import/export live there, not in the toolbar.
  // Export is a single entry opening the guided dialog (one card per format).
  const io = useWorkflowIO(videoId, graph?.nodes ?? [])
  const [exportOpen, setExportOpen] = useState(false)
  const menus = useMemo<AppMenu[]>(
    () => [
      {
        id: 'file',
        label: t('menu.file'),
        sections: [
          {
            id: 'import',
            entries: [
              {
                id: 'import-json',
                label: io.importing ? t('menu.importing') : t('menu.importWorkflow'),
                onSelect: io.importWorkflow,
                disabled: io.importing
              }
            ]
          },
          {
            id: 'export',
            entries: [
              {
                id: 'export-open',
                label: t('menu.export'),
                onSelect: () => setExportOpen(true)
              }
            ]
          }
        ]
      }
    ],
    [t, io]
  )
  useAppMenus(menus)

  // Timeline / history toggles live in the title bar (icon-only, next to the
  // assistant) — the floating toolbar stays lean enough for 13" screens.
  const headerActions = useMemo(
    () => (
      <>
        <Button
          variant={timelineCollapsed ? 'ghost' : 'secondary'}
          size="sm"
          onClick={() => setTimelineCollapsed(!timelineCollapsed)}
          title={timelineCollapsed ? t('editor.showTimeline') : t('editor.hideTimeline')}
        >
          {timelineCollapsed ? (
            <PanelBottom className="h-4 w-4" />
          ) : (
            <PanelBottomClose className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant={historyOpen ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setHistoryOpen((v) => !v)}
          title={t('editor.historyBtnTitle')}
        >
          <History className="h-4 w-4" />
        </Button>
      </>
    ),
    [t, timelineCollapsed, setTimelineCollapsed, historyOpen]
  )
  useHeaderActions(headerActions)

  // Keep the ref in sync so node data callbacks always invoke the latest handler.
  useEffect(() => {
    handleRunNodeRef.current = handleRunNode
  }, [handleRunNode])

  const graphValue: WorkflowGraph = graph ?? { nodes: [], edges: [] }
  const contextNode = nodeMenu
    ? (graphValue.nodes.find((n) => n.id === nodeMenu.nodeId) ?? null)
    : null

  return (
    <WorkflowGraphContext.Provider value={graphValue}>
      {/* Island layout: the canvas is an island that shrinks when the timeline
          grows (nothing ever hides the minimap); toolbar and side panels float
          INSIDE the canvas island. */}
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="island relative min-h-0 flex-1 overflow-hidden">
          <div
            className="absolute inset-0"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }
            }}
            onDrop={(e) => void handleCanvasDrop(e)}
          >
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => {
                setSelectedNodeId(null)
                setPaneMenu(null)
                setNodeMenu(null)
              }}
              onPaneContextMenu={(e) => {
                e.preventDefault()
                setNodeMenu(null)
                const { clientX, clientY } = e as React.MouseEvent
                setPaneMenu({
                  x: clientX,
                  y: clientY,
                  flow: screenToFlowPosition({ x: clientX, y: clientY })
                })
              }}
              onNodeContextMenu={(e, node) => {
                e.preventDefault()
                setPaneMenu(null)
                setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
              }}
              fitView
              minZoom={0.2}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} />
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                bgColor="#161616"
                maskColor="rgb(10 10 10 / 0.72)"
                nodeColor="#3f3f46"
                className="overflow-hidden !rounded-xl !border !border-neutral-800"
              />
            </ReactFlow>
          </div>

          <div className="absolute inset-x-3 top-3 z-20">
            <WorkflowToolbar
              videoId={videoId}
              projectId={projectId}
              graph={graphValue}
              onTidy={handleTidy}
              onFit={() => fitView({ padding: 0.2, duration: 300 })}
              onRunAllVideos={handleRunAllVideos}
              runningAllVideos={runningAll}
              videoNodeCount={videoNodeCount}
            />
          </div>

          {/* Also shown for renders launched by an agent through MCP — progress
              events arrive regardless of who started the render. */}
          {(io.renderingMp4 || io.renderProgress) && (
            <div className="island absolute bottom-3 left-1/2 z-30 flex w-80 -translate-x-1/2 flex-col gap-2 px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-neutral-200">{t('editor.rendering')}</span>
                <span className="text-neutral-400">
                  {io.renderProgress
                    ? `${t(`editor.renderStep.${io.renderProgress.step}`)} — ${io.renderProgress.percent}%`
                    : t('editor.renderStep.probe')}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${io.renderProgress?.percent ?? 0}%` }}
                />
              </div>
              <button
                onClick={io.cancelRenderMp4}
                className="self-end rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                {t('editor.renderCancel')}
              </button>
            </div>
          )}

          {(selectedNode || historyOpen) && (
            <div className="absolute top-16 right-3 bottom-3 z-30 flex flex-col items-stretch gap-3">
              {selectedNode && (
                <NodeParamsPanel
                  // Remount on node change so all fields (incl. `defaultValue`-seeded
                  // ones like Label) reset to the newly selected node's data — without
                  // this the panel reconciles in place and shows stale values when you
                  // jump between nodes (e.g. clicking clips in the timeline).
                  key={selectedNode.id}
                  node={selectedNode}
                  projectId={projectId}
                  onClose={() => setSelectedNodeId(null)}
                  onRun={() => handleRunNode(selectedNode.id)}
                  onAskAssistant={askAssistant}
                />
              )}
              {historyOpen && (
                <HistoryPanel
                  videoId={videoId}
                  onClose={() => setHistoryOpen(false)}
                  onSelectNode={(nodeId) => {
                    setSelectedNodeId(nodeId)
                    focusNode(nodeId)
                  }}
                />
              )}
            </div>
          )}
        </div>

        <TimelineV2
          graph={graphValue}
          videoId={videoId}
          onFocusNode={focusNode}
          collapsed={timelineCollapsed}
          setCollapsed={setTimelineCollapsed}
        />
      </div>

      {costPreview && <CostPreviewModal preview={costPreview} />}
      {anchorGuard && <FrameAnchorModal guard={anchorGuard} />}

      {/* Pane right-click: the add-node catalogue at the cursor, spawning at the click point. */}
      {paneMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setPaneMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setPaneMenu(null)
            }}
          />
          <div
            className="fixed z-50"
            style={{
              left: Math.min(paneMenu.x, window.innerWidth - 340),
              top: Math.min(paneMenu.y, window.innerHeight - 440)
            }}
          >
            <AddNodePanel
              onAdd={(modelId) => {
                void nodeCreation.addNode(modelId, paneMenu.flow)
                setPaneMenu(null)
              }}
              onAddDesign={(recipeId, description) => {
                void nodeCreation.addDesignNode(recipeId, description, paneMenu.flow)
                setPaneMenu(null)
              }}
              libraryAssets={nodeCreation.designAssets}
              onAddFromLibrary={(asset) => {
                void nodeCreation.addLibraryDesignNode(asset, paneMenu.flow)
                setPaneMenu(null)
              }}
              onClose={() => setPaneMenu(null)}
            />
          </div>
        </>
      )}

      {/* Node right-click: the header-icon actions, reachable without aiming. */}
      {nodeMenu && contextNode && (
        <NodeContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          node={contextNode}
          onClose={() => setNodeMenu(null)}
          onRun={() => void handleRunNode(contextNode.id)}
          onDuplicate={() => void duplicateNode(contextNode.id)}
          onReplace={(modelId) => {
            void (async () => {
              const accepted = await confirmModal({
                title: t('editor.replaceModelTitle'),
                message: t('editor.replaceModelConfirm', {
                  label: getModel(modelId)?.label ?? modelId
                })
              })
              if (accepted) await replaceModelAsync({ nodeId: contextNode.id, modelId })
            })()
          }}
          onDelete={() => {
            void (async () => {
              const accepted = await confirmModal({
                message: t('editor.deleteNodeNamedConfirm', {
                  label:
                    contextNode.label ?? getModel(contextNode.modelId)?.label ?? contextNode.modelId
                }),
                confirmLabel: t('library.delete'),
                danger: true
              })
              if (accepted) removeNode({ nodeId: contextNode.id })
            })()
          }}
        />
      )}
      {exportOpen && <ExportDialog io={io} onClose={() => setExportOpen(false)} />}
    </WorkflowGraphContext.Provider>
  )
}

/**
 * Pre-run cost gate for multi-node runs (§4.4): per-node estimate breakdown,
 * grand total vs the live kie.ai balance, and an opt-out below a remembered
 * threshold. The promise held in `preview.resolve` gates the actual run.
 */
function CostPreviewModal({ preview }: { preview: CostPreviewState }) {
  const { t } = useTranslation()
  const [skipUnder, setSkipUnder] = useState(false)

  function settle(accepted: boolean) {
    if (accepted && skipUnder && preview.total > 0) {
      localStorage.setItem(COST_SKIP_KEY, String(Math.ceil(preview.total)))
    }
    preview.resolve(accepted)
  }

  const overBalance = preview.balance !== null && preview.total > preview.balance
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => settle(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island w-full max-w-md px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-neutral-100">{t('editor.costModal.title')}</h2>
        <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
          {preview.rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate text-neutral-300">{row.label}</span>
              <span className="font-mono text-neutral-400">
                {row.credits !== null
                  ? t('editor.costModal.credits', { credits: row.credits })
                  : t('editor.costModal.unknownCost')}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-baseline justify-between border-t border-neutral-800 pt-2 text-xs">
          <span className="font-semibold text-neutral-200">{t('editor.costModal.total')}</span>
          <span className="font-mono font-semibold text-neutral-100">
            {t('editor.costModal.credits', { credits: preview.total })}
          </span>
        </div>
        {preview.balance !== null && (
          <div
            className={`mt-1 text-right text-[11px] ${overBalance ? 'text-danger' : 'text-neutral-500'}`}
          >
            {t('editor.costModal.balance', { credits: preview.balance.toLocaleString() })}
            {overBalance && ` — ${t('editor.costModal.overBalance')}`}
          </div>
        )}
        {preview.total > 0 && (
          <label className="mt-3 flex items-center gap-2 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              checked={skipUnder}
              onChange={(e) => setSkipUnder(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-neutral-600 bg-neutral-900"
            />
            {t('editor.costModal.dontAskUnder', { credits: Math.ceil(preview.total) })}
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => settle(true)} autoFocus>
            {t('editor.costModal.confirm', { count: preview.rows.length })}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Node right-click menu (§4.6): the same actions as the node header icons —
 * Run / Duplicate / Replace model / Delete — reachable from anywhere on the
 * node. Asset nodes only get Duplicate and Delete.
 */
function NodeContextMenu({
  x,
  y,
  node,
  onClose,
  onRun,
  onDuplicate,
  onReplace,
  onDelete
}: {
  x: number
  y: number
  node: GraphNode
  onClose: () => void
  onRun: () => void
  onDuplicate: () => void
  onReplace: (modelId: string) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [replaceOpen, setReplaceOpen] = useState(false)
  const model = getModel(node.modelId)
  const isAsset = node.modelId === 'studio/asset'
  const targets = model ? MODELS.filter((m) => m.kind === model.kind && m.id !== model.id) : []
  const itemClass =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800'
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-50 w-60 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl"
        style={{
          left: Math.min(x, window.innerWidth - 260),
          top: Math.min(y, window.innerHeight - 240)
        }}
      >
        <div className="truncate border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {node.label ?? model?.label ?? node.modelId}
        </div>
        {!isAsset && (
          <button
            className={itemClass}
            onClick={() => {
              onRun()
              onClose()
            }}
          >
            <Play className="h-3.5 w-3.5 text-accent" /> {t('editor.ctxRun')}
          </button>
        )}
        <button
          className={itemClass}
          onClick={() => {
            onDuplicate()
            onClose()
          }}
        >
          <Copy className="h-3.5 w-3.5 text-neutral-400" /> {t('editor.ctxDuplicate')}
        </button>
        {!isAsset && targets.length > 0 && (
          <>
            <button className={itemClass} onClick={() => setReplaceOpen((v) => !v)}>
              <Replace className="h-3.5 w-3.5 text-neutral-400" /> {t('editor.ctxReplaceModel')}
              {replaceOpen ? (
                <ChevronDown className="ml-auto h-3 w-3 text-neutral-500" />
              ) : (
                <ChevronRight className="ml-auto h-3 w-3 text-neutral-500" />
              )}
            </button>
            {replaceOpen &&
              targets.map((m) => (
                <button
                  key={m.id}
                  className={`${itemClass} pl-9 text-neutral-300`}
                  onClick={() => {
                    onReplace(m.id)
                    onClose()
                  }}
                >
                  {m.label}
                </button>
              ))}
          </>
        )}
        <button
          className={`${itemClass} hover:text-danger`}
          onClick={() => {
            onDelete()
            onClose()
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> {t('editor.ctxDelete')}
        </button>
      </div>
    </>
  )
}

/**
 * Frame-anchor guard (§4.6): a design sheet is being wired to a frame anchor.
 * Two illustrated columns make the semantics legible — anchors put the image
 * ON SCREEN, references only guide — with a one-click rewire to the target's
 * reference input when the model has one.
 */
function FrameAnchorModal({ guard }: { guard: AnchorGuardState }) {
  const { t } = useTranslation()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => guard.resolve('cancel')}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island w-full max-w-lg px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-neutral-100">
          {t('editor.anchorGuard.title', { label: guard.sourceLabel })}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          {t('editor.anchorGuard.intro', { handle: guard.anchorHandleLabel })}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
              <Anchor className="h-3.5 w-3.5" /> {t('editor.anchorGuard.anchorTitle')}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-300">
              {t('editor.anchorGuard.anchorDesc')}
            </p>
          </div>
          <div className="rounded-md border border-accent-soft/40 bg-accent-soft/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-soft">
              <ImageIcon className="h-3.5 w-3.5" /> {t('editor.anchorGuard.referenceTitle')}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-300">
              {t('editor.anchorGuard.referenceDesc')}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => guard.resolve('cancel')}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={() => guard.resolve('anchor')}>
            {t('editor.anchorGuard.connectAnchor')}
          </Button>
          {guard.referenceHandle && (
            <Button variant="primary" onClick={() => guard.resolve('reference')} autoFocus>
              {t('editor.anchorGuard.wireAsReference', { handle: guard.referenceHandle.label })}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
