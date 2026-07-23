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
import type { FocusNodePayload, GraphEdge, GraphNode } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { ModelNode, AssetNode } from './nodes/ModelNode'
import { NodeParamsPanel } from './NodeParamsPanel'
import { useCollapsed } from './timelineHooks'
import { TimelineV2 } from './TimelineV2'
import { HistoryPanel } from './HistoryPanel'
import { ChatPanel } from './ChatPanel'
import { MessageSquare } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { useAppMenus, useHeaderActions, type AppMenu } from '@renderer/components/menubar/MenuBar'
import { WorkflowToolbar } from './Toolbar'
import { RENDER_PRESETS, useWorkflowIO, type RenderPreset } from './useWorkflowIO'
import { WorkflowGraphContext, type WorkflowGraph } from './workflowContext'
import { autoLayoutPositions, resolveOverlaps, type LayoutDirection } from './autoLayout'
import { useLastFrameExtractor } from './useLastFrameExtractor'
import { graphKeys, useGraph, useIpcMutation, useProjectAssets } from './data'
import { runNode } from './generationRuntime'
import { getModel } from '@shared/models'

const NODE_TYPES = {
  modelNode: ModelNode,
  assetNode: AssetNode
}

/** "Don't ask again under X credits" — remembered locally on this machine. */
const COST_SKIP_KEY = 'raccord.costConfirmSkipUnder'

interface CostPreviewState {
  rows: { id: string; label: string; credits: number | null }[]
  total: number
  /** Current kie.ai balance, null when unreachable (no key, offline). */
  balance: number | null
  resolve: (accepted: boolean) => void
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
  const { fitView } = useReactFlow()

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
  const [chatOpen, setChatOpen] = useState(false)
  /** Draft injected into the chat input (e.g. "fix this failed prompt"). */
  const [chatPrefill, setChatPrefill] = useState<string | null>(null)
  const askAssistant = useCallback((text: string) => {
    setChatPrefill(text)
    setChatOpen(true)
  }, [])

  // Assistant toggle lives in the title bar, next to the settings gear.
  useHeaderActions(
    useMemo(
      () => (
        <Button
          variant={chatOpen ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setChatOpen((v) => !v)}
          title={t('editor.assistantTitle')}
        >
          <MessageSquare className="h-3.5 w-3.5" /> {t('editor.assistant')}
        </Button>
      ),
      [chatOpen, t]
    )
  )
  const [timelineCollapsed, setTimelineCollapsed] = useCollapsed()
  /** True while a "generate all videos" batch run is in flight. */
  const [runningAll, setRunningAll] = useState(false)
  /** Pending cost-preview modal for a multi-node run (null = none). */
  const [costPreview, setCostPreview] = useState<CostPreviewState | null>(null)

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
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle
    })) satisfies Edge[]
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
        if (designId) {
          const target = graph?.nodes.find((n) => n.id === targetId)
          const handle = target
            ? getModel(target.modelId)?.inputs.find((h) => h.key === targetHandle)
            : undefined
          if (handle?.frameAnchor) {
            const accepted = await confirmModal({
              title: t('editor.designFrameAnchorTitle'),
              message: t('editor.designFrameAnchorConfirm', {
                label: source?.label ?? source?.key ?? '',
                handle: targetHandle
              }),
              confirmLabel: t('editor.designFrameAnchorConnect')
            })
            if (!accepted) return
          }
        }
        connectEdge({
          videoId,
          sourceNodeId: sourceId,
          sourceHandle: connection.sourceHandle ?? 'output',
          targetNodeId: targetId,
          targetHandle
        })
      })()
    },
    [connectEdge, videoId, graph, projectAssets, confirmModal, t]
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
   * Smart per-node run: gathers every upstream dependency that lacks a usable
   * output, then runs the whole subgraph dependency-aware. A node starts as soon
   * as its OWN direct parents have finished — independent branches run in
   * parallel (two images feeding the same node generate concurrently, they don't
   * wait on each other). The explicit target always runs fresh; dependencies
   * reuse any in-flight/finished generation (race-safe, server-side) so a shared
   * upstream isn't generated once per consumer. Asset nodes are skipped.
   */
  const runNodes = useCallback(
    async (targetNodeIds: string[], opts?: { reuseTargets?: boolean }) => {
      if (!graph || targetNodeIds.length === 0) return
      // When `reuseTargets` is set (batch runs), targets with a successful output
      // are skipped instead of regenerated — no credits burned re-running clips
      // that are already done. The single-node run leaves it false: an explicit
      // click on one node always regenerates it.
      const reuseTargets = opts?.reuseTargets ?? false
      const targetSet = new Set<string>(targetNodeIds)
      const nodesById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]))
      const incomingByNode = new Map<string, GraphEdge[]>()
      for (const e of graph.edges) {
        const arr = incomingByNode.get(e.targetNodeId) ?? []
        arr.push(e)
        incomingByNode.set(e.targetNodeId, arr)
      }

      // Walk upstream from every target, collecting all transitive dependencies.
      const visited = new Set<string>()
      function visit(id: string) {
        if (visited.has(id)) return
        visited.add(id)
        for (const e of incomingByNode.get(id) ?? []) visit(e.sourceNodeId)
      }
      for (const id of targetNodeIds) visit(id)

      // ── Cost preview ──────────────────────────────────────────────────────
      // Mirror of the reuse rules below: which nodes will actually claim a new
      // generation. Multi-node runs get a per-node breakdown + total + balance
      // before any credit is spent; "don't ask under X" short-circuits it.
      const planned: GraphNode[] = []
      for (const id of visited) {
        const node = nodesById.get(id)
        if (!node || node.modelId === 'studio/asset') continue
        const reuse = !targetSet.has(id) || reuseTargets
        if (reuse && node.selectedGenerationId) {
          const sel = await invoke('generations:get', {
            generationId: node.selectedGenerationId
          })
          if (sel?.status === 'success') continue
        }
        planned.push(node)
      }
      if (planned.length >= 2) {
        const rows = await Promise.all(
          planned.map(async (node) => ({
            id: node.id,
            label: node.label ?? node.key,
            credits: await invoke('generations:estimateCost', { nodeId: node.id })
              .then((r) => r.credits)
              .catch(() => null)
          }))
        )
        const total = rows.reduce((sum, r) => sum + (r.credits ?? 0), 0)
        const skipUnder = Number(localStorage.getItem(COST_SKIP_KEY) ?? '0')
        if (!(skipUnder > 0 && total <= skipUnder)) {
          const balance = await invoke('kie:credits')
            .then((r) => r.credits)
            .catch(() => null)
          const accepted = await new Promise<boolean>((resolve) =>
            setCostPreview({ rows, total, balance, resolve })
          )
          setCostPreview(null)
          if (!accepted) return
        }
      }

      // Memoised per-node run: awaits the node's direct parents (in parallel),
      // then runs it once. Memoising means a shared upstream is launched a single
      // time even when several consumers depend on it; running parents via
      // Promise.all is what parallelises independent branches. A single shared
      // map across all targets means shared dependencies of two videos generate
      // once, not once per video.
      const runPromises = new Map<string, Promise<void>>()
      const runWithDeps = (id: string): Promise<void> => {
        const existing = runPromises.get(id)
        if (existing) return existing
        const node = nodesById.get(id)
        const parentIds = (incomingByNode.get(id) ?? [])
          .map((e) => e.sourceNodeId)
          .filter((pid) => visited.has(pid))
        const p = (async () => {
          await Promise.all(parentIds.map(runWithDeps))
          if (!node || node.modelId === 'studio/asset') return

          // Dependencies always reuse; targets reuse only in batch mode.
          const reuse = !targetSet.has(id) || reuseTargets
          // Already-satisfied nodes are skipped (no churned credits).
          if (reuse && node.selectedGenerationId) {
            const sel = await invoke('generations:get', {
              generationId: node.selectedGenerationId
            })
            if (sel?.status === 'success') return
          }

          const { generationId } = await runNode({
            nodeId: id,
            reuseSatisfied: reuse
          })
          await waitForGeneration(generationId)

          const finished = await invoke('generations:get', { generationId })
          if (finished?.status !== 'success') {
            throw new Error(
              `Node "${node.label ?? node.key}" did not complete successfully — stopping.`
            )
          }
        })()
        runPromises.set(id, p)
        return p
      }

      // Run every target concurrently. One failing branch is surfaced but doesn't
      // abort the others — the rest of the videos still get their shot.
      let failedCount = 0
      await Promise.all(
        targetNodeIds.map((id) =>
          runWithDeps(id).catch((err) => {
            failedCount++
            const message = err instanceof Error ? err.message : String(err)
            console.error('Run failed:', message)
            toast.error(message)
          })
        )
      )
      // One OS summary once the whole batch has settled ("4 succeeded, 1 failed").
      if (targetNodeIds.length >= 2) {
        void invoke('notifications:batchSummary', {
          succeeded: targetNodeIds.length - failedCount,
          failed: failedCount
        }).catch(() => {})
      }
    },
    [graph, toast]
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
  const io = useWorkflowIO(videoId, graph?.nodes ?? [])
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
                id: 'export-json',
                label: io.exporting ? t('editor.exporting') : t('menu.exportWorkflow'),
                onSelect: io.exportJson,
                disabled: !io.canExport || io.exporting
              },
              {
                id: 'export-fcpxml',
                label: io.exportingZip ? t('editor.fcpxmlBundling') : t('menu.exportFcpxml'),
                onSelect: io.exportFcpxmlZip,
                disabled: !io.canExportFcpxml || io.exportingZip
              },
              {
                id: 'export-media-zip',
                label: io.exportingMedia ? t('editor.fcpxmlBundling') : t('menu.exportMediaZip'),
                onSelect: io.exportMediaZip,
                disabled: !io.canExportFcpxml || io.exportingMedia
              },
              {
                id: 'export-mp4',
                label: io.renderingMp4 ? t('editor.rendering') : t('menu.exportMp4'),
                onSelect: () => io.exportMp4(),
                disabled: !io.canExportFcpxml || io.renderingMp4
              },
              // Per-destination presets — fixed output dims via the render
              // pipeline's resolution override (§4.5 follow-up).
              ...(Object.keys(RENDER_PRESETS) as RenderPreset[]).map((preset) => ({
                id: `export-mp4-${preset.replace(':', '-')}`,
                label: t('menu.exportMp4Preset', {
                  preset,
                  dims: `${RENDER_PRESETS[preset].width}×${RENDER_PRESETS[preset].height}`
                }),
                onSelect: () => io.exportMp4(preset),
                disabled: !io.canExportFcpxml || io.renderingMp4
              }))
            ]
          }
        ]
      }
    ],
    [t, io]
  )
  useAppMenus(menus)

  // Keep the ref in sync so node data callbacks always invoke the latest handler.
  useEffect(() => {
    handleRunNodeRef.current = handleRunNode
  }, [handleRunNode])

  const graphValue: WorkflowGraph = graph ?? { nodes: [], edges: [] }

  return (
    <WorkflowGraphContext.Provider value={graphValue}>
      {/* Island layout: the canvas is an island that shrinks when the timeline
          grows (nothing ever hides the minimap); toolbar and side panels float
          INSIDE the canvas island. */}
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="island relative min-h-0 flex-1 overflow-hidden">
          <div className="absolute inset-0">
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
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
              timelineCollapsed={timelineCollapsed}
              onToggleTimeline={() => setTimelineCollapsed(!timelineCollapsed)}
              historyOpen={historyOpen}
              onToggleHistory={() => setHistoryOpen((v) => !v)}
              onRunAllVideos={handleRunAllVideos}
              runningAllVideos={runningAll}
              videoNodeCount={videoNodeCount}
            />
          </div>

          {chatOpen && (
            <div className="absolute top-16 bottom-3 left-3 z-30 flex flex-col items-stretch">
              <ChatPanel
                videoId={videoId}
                projectId={projectId}
                prefill={chatPrefill}
                onPrefillConsumed={() => setChatPrefill(null)}
                onClose={() => setChatOpen(false)}
              />
            </div>
          )}

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
 * Step-by-step sequencer helper: polls the generation row and resolves as soon
 * as it reaches a terminal state (success/failed). Hard caps at 10 min.
 */
async function waitForGeneration(generationId: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    const gen = await invoke('generations:get', { generationId })
    if (gen?.status === 'success' || gen?.status === 'failed') return
    if (Date.now() - start > 10 * 60 * 1000) return
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
