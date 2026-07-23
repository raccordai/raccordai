import { Handle, Position, type Node as RFNode, type NodeProps } from '@xyflow/react'
import {
  Loader2,
  Play,
  AlertCircle,
  Anchor,
  CheckCircle2,
  Clock,
  RefreshCw,
  Replace,
  Trash2,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { VideoThumb } from '@renderer/components/VideoThumb'
import { MODELS, getModel, type ModelDefinition } from '@shared/models'
import { incomingConnectionsFor, useWorkflowGraph } from '../workflowContext'
import {
  useAsset,
  useIpcMutation,
  useNodeGenerations,
  useQueueState,
  graphKeys,
  runStateFor,
  type RunState
} from '../data'
import { refreshStatus, cancelGeneration } from '../generationRuntime'

/** Matches MAX_GENERATION_RETRIES in runEngine.ts — display only. */
const MAX_RETRIES = 3

/** Badge/status label for an in-flight generation ("Queued (#2)", "Retry 1/3"…). */
function useRunStateLabel(): (state: RunState) => string {
  const { t } = useTranslation()
  return (state: RunState) =>
    state.kind === 'queued'
      ? t('editor.queueBadge.queued', { position: state.position })
      : state.kind === 'retrying'
        ? t('editor.queueBadge.retrying', { attempt: state.attempt, max: MAX_RETRIES })
        : t('editor.queueBadge.generating')
}

export type ModelNodeData = {
  node: GraphNode
  onOpenPanel?: () => void
  /** Smart run: auto-runs missing upstream dependencies in topo order, then this node. */
  onRun?: () => void
}

export type ModelRFNode = RFNode<ModelNodeData, 'modelNode'>

/**
 * Header dropdown to swap this node's model for another of the same kind
 * (e.g. Grok Imagine → Seedance when one provider is flaky). The server
 * remaps connections and clears stale outputs — see nodes.replaceModel.
 */
function ReplaceModelMenu({ node, model }: { node: GraphNode; model: ModelDefinition }) {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const [open, setOpen] = useState(false)
  const replaceModel = useIpcMutation('nodes:replaceModel', [
    graphKeys.graph(node.videoId),
    ['generations']
  ])
  const targets = useMemo(
    () => MODELS.filter((m) => m.kind === model.kind && m.id !== model.id),
    [model.kind, model.id]
  )
  if (targets.length === 0) return null

  async function choose(e: MouseEvent, modelId: string) {
    e.stopPropagation()
    setOpen(false)
    const accepted = await confirmModal({
      title: t('editor.replaceModelTitle'),
      message: t('editor.replaceModelConfirm', { label: getModel(modelId)?.label ?? modelId })
    })
    if (accepted) {
      await replaceModel.mutateAsync({ nodeId: node.id, modelId })
    }
  }

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 opacity-0 transition hover:bg-accent/10 hover:text-accent group-hover:opacity-100"
        title="Replace model (swap provider, e.g. Grok → Seedance)"
      >
        <Replace className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          {/* click-away catcher */}
          <div
            className="fixed inset-0 z-30"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
            }}
          />
          <div className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
            <div className="border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Replace with
            </div>
            <div className="py-1">
              {targets.map((m) => (
                <button
                  key={m.id}
                  onClick={(e) => choose(e, m.id)}
                  className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-neutral-800"
                >
                  <span className="text-sm text-neutral-200">{m.label}</span>
                  <span className="font-mono text-[10px] text-neutral-600">{m.id}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function ModelNode({ data, selected }: NodeProps<ModelRFNode>) {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const runStateLabel = useRunStateLabel()
  const node = data.node
  const model = useMemo(() => getModel(node.modelId), [node.modelId])
  const removeNode = useIpcMutation('nodes:remove', [graphKeys.graph(node.videoId)])
  const [refreshing, setRefreshing] = useState(false)
  const graph = useWorkflowGraph()
  const connections = useMemo(() => incomingConnectionsFor(node.id, graph), [node.id, graph])
  // Always subscribe — we need to know about `running` generations even before
  // the node has any selected output (i.e. on its very first run).
  const generations = useNodeGenerations(node.id).data
  const queue = useQueueState().data

  const latest = generations?.[0]
  const inFlight = generations?.find((g) => g.status === 'running' || g.status === 'pending')
  const runState = runStateFor(inFlight, queue)
  const isInFlight = runState !== null

  // Group connections by handle for display alongside each input row.
  const connectionsByHandle = useMemo(() => {
    const map = new Map<string, typeof connections>()
    for (const c of connections) {
      const list = map.get(c.edge.targetHandle) ?? []
      list.push(c)
      map.set(c.edge.targetHandle, list)
    }
    return map
  }, [connections])

  function handleRun(e: MouseEvent) {
    e.stopPropagation()
    data.onRun?.()
  }

  async function handleRefresh(e: MouseEvent) {
    e.stopPropagation()
    setRefreshing(true)
    try {
      await refreshStatus({ nodeId: node.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function handleCancel(e: MouseEvent) {
    e.stopPropagation()
    try {
      await cancelGeneration({ nodeId: node.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation()
    const accepted = await confirmModal({
      message: t('editor.deleteNodeNamedConfirm', {
        label: node.label ?? model?.label ?? node.modelId
      }),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (accepted) {
      await removeNode.mutateAsync({ nodeId: node.id })
    }
  }

  if (!model) {
    return (
      <div className="rounded-lg border border-danger bg-danger/10 p-3 text-xs text-danger">
        Unknown model: <code>{node.modelId}</code>
      </div>
    )
  }

  const kindColor =
    model.kind === 'video'
      ? 'border-accent/40'
      : model.kind === 'audio'
        ? 'border-highlight-soft/40'
        : 'border-accent-soft/40'
  const kindLabel = model.kind.toUpperCase()
  const kindLabelColor =
    model.kind === 'video'
      ? 'text-accent'
      : model.kind === 'audio'
        ? 'text-highlight-soft'
        : 'text-accent-soft'

  const currentGen = data.node.selectedGenerationId
    ? generations?.find((g) => g.id === data.node.selectedGenerationId)
    : latest

  const borderClass = runState
    ? runState.kind === 'queued'
      ? 'border-accent-soft/60'
      : 'generating-border border-warning/60 shadow-warning/20'
    : selected
      ? 'border-accent'
      : kindColor

  return (
    <div
      onClick={() => data.onOpenPanel?.()}
      className={`group relative w-72 cursor-pointer rounded-lg border bg-neutral-900/95 shadow-xl backdrop-blur ${borderClass}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold tracking-widest ${kindLabelColor}`}>
              {kindLabel}
            </span>
            {runState && (
              <span
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${
                  runState.kind === 'queued'
                    ? 'bg-accent-soft/15 text-accent-soft ring-accent-soft/40'
                    : 'bg-warning/20 text-warning ring-warning/40'
                }`}
              >
                {runState.kind === 'queued' ? (
                  <Clock className="h-2.5 w-2.5" />
                ) : (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                )}{' '}
                {runStateLabel(runState)}
              </span>
            )}
          </div>
          <div className="truncate text-sm font-semibold text-neutral-100">
            {node.label ?? model.label}
          </div>
          <div className="truncate font-mono text-[10px] text-neutral-500" title={model.id}>
            {model.id}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {runState && (
            <>
              {runState.kind === 'generating' && (
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition hover:bg-warning/10 hover:text-warning disabled:opacity-50"
                  title="Check status now (queries kie.ai directly, in case the callback was dropped)"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
              )}
              <button
                onClick={handleCancel}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-800 hover:text-danger"
                title="Cancel this generation"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <ReplaceModelMenu node={node} model={model} />
          <button
            onClick={handleDelete}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-danger group-hover:opacity-100"
            title="Delete node"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRun}
            disabled={isInFlight}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-neutral-900 shadow hover:bg-accent-hover disabled:opacity-50"
            title="Run node (auto-runs any missing upstream dependencies first)"
          >
            {isInFlight ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Input rows — each carries its own Handle so the connector aligns with the label */}
      <div className="py-1 text-[11px] text-neutral-400">
        {model.inputs.length === 0 && (
          <div className="px-3 py-1 italic text-neutral-600">No inputs</div>
        )}
        {model.inputs.map((input) => {
          const conns = connectionsByHandle.get(input.key) ?? []
          const over = input.maxCount !== undefined && conns.length > input.maxCount
          return (
            <div key={input.key} className="relative px-3 py-1.5" style={{ position: 'relative' }}>
              <Handle
                type="target"
                position={Position.Left}
                id={input.key}
                style={{
                  left: -7,
                  top: 14,
                  // Frame anchors are permanently distinguished (§4.6): warning
                  // token — the connected image literally appears on screen.
                  ...(input.frameAnchor ? { background: '#ffd58a' } : {})
                }}
                title={
                  input.frameAnchor
                    ? `${input.label} (${input.key}) — ${t('editor.frameAnchorHandleTitle')}`
                    : `${input.label} (${input.key})`
                }
              />
              <div className="flex items-center justify-between">
                <span className="flex min-w-0 items-center gap-1 truncate">
                  {input.frameAnchor && (
                    <Anchor
                      className="h-2.5 w-2.5 flex-shrink-0 text-warning"
                      aria-label={t('editor.frameAnchorHandleTitle')}
                    />
                  )}
                  ◀ {input.label}
                  {input.required && <span className="text-danger"> *</span>}
                </span>
                {input.maxCount !== undefined && (
                  <span className={`text-[10px] ${over ? 'text-danger' : 'text-neutral-600'}`}>
                    {conns.length}/{input.maxCount}
                  </span>
                )}
              </div>
              {conns.length > 0 && input.referenceAlias && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {conns.map((c) => (
                    <span
                      key={c.edge.id}
                      className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent-soft"
                      title={`${c.alias} ← ${c.source?.label ?? c.source?.key ?? 'unknown'}`}
                    >
                      <span className="font-mono">{c.alias}</span>
                      <span className="ml-1 text-neutral-500">
                        ← {c.source?.label ?? c.source?.key ?? '?'}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Latest generation preview */}
      <div className="border-t border-neutral-800 px-3 py-2">
        {!currentGen && (
          <div className="text-xs text-neutral-600 italic">No output yet — click ▶ to run.</div>
        )}
        {(currentGen?.status === 'running' || currentGen?.status === 'pending') && runState && (
          <div
            className={`flex items-center gap-2 text-xs ${
              runState.kind === 'queued' ? 'text-accent-soft' : 'text-warning'
            }`}
          >
            {runState.kind === 'queued' ? (
              <Clock className="h-3 w-3" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}{' '}
            {runStateLabel(runState)}
          </div>
        )}
        {currentGen?.status === 'failed' && (
          <div className="flex items-center gap-2 text-xs text-danger">
            <AlertCircle className="h-3 w-3" /> Failed
            {currentGen.errorMessage && (
              <span className="truncate text-neutral-500" title={currentGen.errorMessage}>
                ({currentGen.errorMessage})
              </span>
            )}
          </div>
        )}
        {currentGen?.status === 'success' && currentGen.url && (
          <div className="relative overflow-hidden rounded">
            {model.kind === 'image' ? (
              <img src={currentGen.url} alt="" className="w-full" />
            ) : model.kind === 'audio' ? (
              <audio
                src={currentGen.url}
                controls
                className="w-full"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <VideoThumb src={currentGen.url} className="w-full" />
            )}
            <div className="absolute right-1 top-1 rounded bg-black/70 p-1">
              <CheckCircle2 className="h-3 w-3 text-success" />
            </div>
          </div>
        )}
        {node.intent && (
          <div className="mt-2 rounded border border-accent/20 bg-accent/5 px-2 py-1 text-[10px] leading-snug text-neutral-400">
            <span className="font-semibold text-accent-soft">Intention&nbsp;:</span> {node.intent}
          </div>
        )}
      </div>

      {/* Output rows — each carries its own Handle so the connector aligns with the label */}
      <div className="border-t border-neutral-800 py-1 text-[11px] text-neutral-400">
        {model.outputs.map((out) => {
          // For lastFrame: surface whether the extraction has happened yet so the user
          // knows if an outgoing edge will resolve.
          const isLastFrame = out.key === 'lastFrame'
          const lastFrameReady = isLastFrame ? !!currentGen && !!currentGen.lastFrameUrl : true
          const dotColor =
            out.kind === 'video'
              ? 'text-accent'
              : out.kind === 'audio'
                ? 'text-highlight-soft'
                : 'text-accent-soft'
          return (
            <div key={out.key} className="relative px-3 py-1.5" style={{ position: 'relative' }}>
              <Handle
                type="source"
                position={Position.Right}
                id={out.key}
                style={{
                  right: -7,
                  top: 14,
                  // Matches the media-kind text colors: image=sky, audio=pink, video=lavender.
                  background:
                    out.kind === 'image' ? '#afdeff' : out.kind === 'audio' ? '#ffbcd6' : '#b7b6ff'
                }}
                title={`${out.label} (${out.key})`}
              />
              <div className="flex items-center justify-end gap-1.5">
                {isLastFrame && currentGen?.status === 'success' && !lastFrameReady && (
                  <span
                    className="flex items-center gap-1 rounded bg-warning/15 px-1 py-0.5 text-[9px] text-warning"
                    title="Last frame is being extracted in the browser — wait a moment before running downstream nodes."
                  >
                    <Loader2 className="h-2.5 w-2.5 animate-spin" /> extracting
                  </span>
                )}
                <span className="truncate">{out.label}</span>
                <span className={dotColor}>▶</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Asset node ───────────────────────────────────────────────────────────
export type AssetNodeData = {
  node: GraphNode
  onOpenPanel?: () => void
}

export type AssetRFNode = RFNode<AssetNodeData, 'assetNode'>

export function AssetNode({ data, selected }: NodeProps<AssetRFNode>) {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const assetId = (data.node.params as { assetId?: string } | null | undefined)?.assetId
  const asset = useAsset(assetId ?? null).data
  const assetMeta = asset ?? undefined
  const removeNode = useIpcMutation('nodes:remove', [graphKeys.graph(data.node.videoId)])

  async function handleDelete(e: MouseEvent) {
    e.stopPropagation()
    const accepted = await confirmModal({
      message: t('editor.deleteAssetNodeConfirm', {
        label: data.node.label ?? assetMeta?.name ?? 'Asset'
      }),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (accepted) {
      await removeNode.mutateAsync({ nodeId: data.node.id })
    }
  }

  return (
    <div
      onClick={() => data.onOpenPanel?.()}
      className={`group w-56 cursor-pointer rounded-lg border bg-neutral-900/95 shadow-xl ${
        selected ? 'border-accent' : 'border-success/40'
      }`}
    >
      <div className="flex items-start justify-between border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold tracking-widest text-success">ASSET</div>
          <div className="truncate text-sm font-semibold text-neutral-100">
            {data.node.label ?? assetMeta?.name ?? 'Pick an asset…'}
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition hover:bg-neutral-800 hover:text-danger group-hover:opacity-100"
          title="Delete node"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="aspect-video bg-neutral-950">
        {assetMeta?.url && assetMeta.kind === 'image' && (
          <img src={assetMeta.url} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
        {assetMeta?.url && assetMeta.kind === 'video' && (
          <VideoThumb src={assetMeta.url} className="h-full w-full object-cover" />
        )}
        {!assetMeta && (
          <div className="flex h-full items-center justify-center text-xs text-neutral-600">
            Open panel to select
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="output" />
    </div>
  )
}
