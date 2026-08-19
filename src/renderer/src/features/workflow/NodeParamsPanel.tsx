import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Download,
  FolderPlus,
  Loader2,
  Maximize2,
  MessageSquare,
  Palette,
  Play,
  RefreshCw,
  Sparkles,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DESIGN_RECIPES } from '@shared/designs/registry'
import { MAX_VARIANTS } from '@shared/config'
import type { GraphNode } from '@shared/ipc/contracts'
import type { ModelDefinition } from '@shared/models'
import { clampParamToField, defaultParamsFor, getModel, videoDefaultParams } from '@shared/models'
import { getStyle } from '@shared/styles/registry'
import { lintNode, type LintFix } from '@shared/promptLint'
import { formatTranscript, type SpeechTranscript } from '@shared/speech'
import { Button } from '@renderer/components/ui/Button'
import { Lightbox } from '@renderer/components/Lightbox'
import { MentionMenu, useMentionMenu, type MentionItem } from '@renderer/components/ui/MentionMenu'
import { VideoThumb } from '@renderer/components/VideoThumb'
import { Label, Select, TextArea, TextField } from '@renderer/components/ui/Input'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { AnnotateModal } from './AnnotateModal'
import { incomingConnectionsFor, useWorkflowGraph } from './workflowContext'
import { downloadMedia } from '@renderer/lib/downloadMedia'
import { invoke } from '@renderer/lib/ipc'
import { graphKeys, useIpcMutation, useNodeGenerations, useProjectAssets, useVideo } from './data'
import { promoteGeneration, refineImagePrompt } from './generationRuntime'

/** Sensible extension fallback per media kind when the URL/MIME doesn't reveal one. */
const FALLBACK_EXT: Record<string, string> = { image: 'png', video: 'mp4', audio: 'mp3' }

/** §6.6 — the variant counts offered next to Generate (1 is the plain button). */
const VARIANT_CHOICES = Array.from({ length: MAX_VARIANTS - 1 }, (_, i) => i + 2)

interface Props {
  node: GraphNode
  projectId: string
  onClose: () => void
  /** Run this node (auto-runs any missing upstream dependencies first). */
  onRun: () => void
  /** §6.6 — run this node N times in parallel and compare the candidates. */
  onRunVariants?: (count: number) => void
  /** Opens the assistant with a prepared draft. */
  onAskAssistant?: (text: string) => void
}

export function NodeParamsPanel({
  node,
  projectId,
  onClose,
  onRun,
  onRunVariants,
  onAskAssistant
}: Props) {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const removeNode = useIpcMutation('nodes:remove', [graphKeys.graph(node.videoId)])

  async function handleDelete() {
    const accepted = await confirmModal({
      message: t('editor.deleteNodeConfirm'),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (!accepted) return
    await removeNode.mutateAsync({ nodeId: node.id })
    onClose()
  }

  if (node.modelId === 'studio/asset') {
    return (
      <AssetNodeEditor
        node={node}
        projectId={projectId}
        onClose={onClose}
        onDelete={handleDelete}
      />
    )
  }
  return (
    <ModelNodeEditor
      node={node}
      projectId={projectId}
      onClose={onClose}
      onDelete={handleDelete}
      onRun={onRun}
      onRunVariants={onRunVariants}
      onAskAssistant={onAskAssistant}
    />
  )
}

// ─── Asset node editor ────────────────────────────────────────────────────
function AssetNodeEditor({
  node,
  projectId,
  onClose,
  onDelete
}: {
  node: GraphNode
  projectId: string
  onClose: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const assets = useProjectAssets(projectId).data
  const updateParams = useIpcMutation('nodes:updateParams', [graphKeys.graph(node.videoId)])
  const updateLabel = useIpcMutation('nodes:updateLabel', [graphKeys.graph(node.videoId)])
  const queryClient = useQueryClient()
  const currentAssetId = (node.params as { assetId?: string } | null | undefined)?.assetId
  const currentAsset = assets?.find((a) => a.id === currentAssetId)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  // 'all' | design category | 'media' — chips only show when the library has design sheets.
  const [filter, setFilter] = useState('all')
  const designFilters = DESIGN_RECIPES.map((r) => r.id).filter((id) =>
    (assets ?? []).some((a) => a.designId === id)
  )
  const visibleAssets = (assets ?? []).filter((a) =>
    filter === 'all' ? true : filter === 'media' ? a.designId === null : a.designId === filter
  )

  async function handleDownload() {
    if (!currentAsset?.url) return
    setDownloadError(null)
    setDownloading(true)
    try {
      await downloadMedia(currentAsset.url, {
        name: currentAsset.name,
        createdAt: currentAsset.createdAt,
        fallbackExt: FALLBACK_EXT[currentAsset.kind] ?? 'bin'
      })
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }

  async function handleImport() {
    if (importing) return
    setImportError(null)
    setImporting(true)
    try {
      await invoke('assets:importFromDialog', { projectId })
      void queryClient.invalidateQueries({ queryKey: graphKeys.assetsForProject(projectId) })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <PanelShell title="Asset" onClose={onClose} onDelete={onDelete}>
      <Label>Label</Label>
      <TextField
        defaultValue={node.label ?? ''}
        placeholder="Optional label"
        onBlur={(e) => updateLabel.mutate({ nodeId: node.id, label: e.target.value })}
      />

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <Label>Pick an asset</Label>
          <button
            onClick={handleImport}
            disabled={importing}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-50"
            title="Import media files from your computer into this project"
          >
            {importing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FolderPlus className="h-3 w-3" />
            )}
            Import files…
          </button>
        </div>
        {importError && <div className="mb-1 text-[10px] text-danger">{importError}</div>}
        {designFilters.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {['all', ...designFilters, 'media'].map((key) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                  filter === key
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
        {assets === undefined ? (
          <div className="text-xs text-neutral-500">Loading…</div>
        ) : assets.length === 0 ? (
          <div className="rounded border border-dashed border-neutral-700 p-3 text-xs text-neutral-500">
            No assets in this project yet. Upload some in the Assets page.
          </div>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {visibleAssets.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() =>
                    updateParams.mutate({ nodeId: node.id, params: { assetId: a.id } })
                  }
                  className={`group relative block aspect-square w-full overflow-hidden rounded border-2 ${
                    currentAssetId === a.id
                      ? 'border-accent'
                      : 'border-neutral-800 hover:border-neutral-600'
                  }`}
                  title={a.name}
                >
                  {a.kind === 'image' && a.url && (
                    <img src={a.url} loading="lazy" className="h-full w-full object-cover" alt="" />
                  )}
                  {a.kind === 'video' && a.url && (
                    <VideoThumb src={a.url} className="h-full w-full object-cover" />
                  )}
                  {a.kind === 'audio' && (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                      🔊
                    </div>
                  )}
                  {a.designId && (
                    <div
                      className="absolute left-1 top-1 rounded bg-highlight/90 p-0.5"
                      title={t(`designs.${a.designId}.name` as never)}
                    >
                      <Palette className="h-3 w-3 text-neutral-900" />
                    </div>
                  )}
                  {currentAssetId === a.id && (
                    <div className="absolute right-1 top-1 rounded-full bg-accent p-0.5">
                      <Check className="h-3 w-3 text-white" />
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {currentAsset?.url && (
        <div className="mt-4">
          <Button
            variant="ghost"
            onClick={handleDownload}
            disabled={downloading}
            className="w-full justify-center"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download "{currentAsset.name}"
          </Button>
          {downloadError && <div className="mt-1 text-[10px] text-danger">{downloadError}</div>}
        </div>
      )}
    </PanelShell>
  )
}

// ─── Model node editor ────────────────────────────────────────────────────
function ModelNodeEditor({
  node,
  projectId,
  onClose,
  onDelete,
  onRun,
  onRunVariants,
  onAskAssistant
}: {
  node: GraphNode
  projectId: string
  onClose: () => void
  onDelete: () => void
  onRun: () => void
  onRunVariants?: (count: number) => void
  onAskAssistant?: (text: string) => void
}) {
  const { t } = useTranslation()
  const model = useMemo(() => getModel(node.modelId), [node.modelId])
  const updateParams = useIpcMutation('nodes:updateParams', [graphKeys.graph(node.videoId)])
  const updateLabel = useIpcMutation('nodes:updateLabel', [graphKeys.graph(node.videoId)])
  const updateIntent = useIpcMutation('nodes:updateIntent', [graphKeys.graph(node.videoId)])
  const selectGen = useIpcMutation('generations:select', [
    graphKeys.graph(node.videoId),
    ['generations']
  ])
  const reorderEdgesMut = useIpcMutation('edges:reorder', [
    graphKeys.graph(node.videoId),
    ['history']
  ])
  const rewireEdgeMut = useIpcMutation('edges:rewire', [graphKeys.graph(node.videoId), ['history']])
  const generations = useNodeGenerations(node.id).data
  /** Generations picked for the compare grid (§6.6: 2 to MAX_VARIANTS candidates). */
  const [compareIds, setCompareIds] = useState<string[]>([])
  /** The grid opens on demand — picking a 2nd candidate no longer forces it open,
   *  since a variants run is usually arbitrated 3 or 4 at a time. */
  const [compareOpen, setCompareOpen] = useState(false)
  const graph = useWorkflowGraph()
  const connections = useMemo(() => incomingConnectionsFor(node.id, graph), [node.id, graph])
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const video = useVideo(node.videoId).data

  // local mutable params copy so the user can edit freely; commit on blur/change
  const [params, setParams] = useState<Record<string, unknown>>(
    (node.params as Record<string, unknown> | null | undefined) ?? {}
  )

  useEffect(() => {
    setParams((node.params as Record<string, unknown> | null | undefined) ?? {})
  }, [node.id, node.params])

  const aliasesByHandle = useMemo(() => {
    const map = new Map<string, typeof connections>()
    for (const c of connections) {
      const arr = map.get(c.edge.targetHandle) ?? []
      arr.push(c)
      map.set(c.edge.targetHandle, arr)
    }
    return map
  }, [connections])

  // Indicative credit cost for the CURRENT params — refetched whenever the
  // node row changes (updatedAt bumps on every params commit).
  const costEstimate = useQuery({
    queryKey: ['generations', 'estimate', node.id, node.updatedAt],
    queryFn: () => invoke('generations:estimateCost', { nodeId: node.id })
  })

  // Voice personas (§8): the channel's named voices, offered on the speech
  // params (voiceId picker, dialogue voice-map inserts). Only fetched when the
  // model actually declares one of those fields.
  const isSpeechModel = model?.paramFields.some((f) => f.key === 'voiceId' || f.key === 'voiceMap')
  const voicePersonas = useQuery({
    queryKey: ['voicePersonas'],
    queryFn: () => invoke('voicePersonas:list', {}),
    enabled: isSpeechModel === true
  })

  // "@" in the prompt opens the connected-input aliases (@Image1, @Video1…) —
  // same autocomplete as the assistant input, fed by the alias registry above.
  const [promptCaret, setPromptCaret] = useState(0)
  const promptValue = (params.prompt as string | undefined) ?? ''
  const aliasItems = useMemo<MentionItem[]>(
    () =>
      connections
        .filter((c) => c.alias)
        .map((c) => ({
          id: c.edge.id,
          label: c.alias as string,
          description: c.source?.label ?? c.source?.key,
          insert: c.alias as string,
          section: t('editor.mentionInputs')
        })),
    [connections, t]
  )
  const promptMention = useMentionMenu({
    value: promptValue,
    caret: promptCaret,
    triggers: [{ char: '@' }],
    itemsFor: () => aliasItems
  })

  // Image to feed the prompt refiner: the active generation if it's an image, else the latest successful image.
  const refinerImageUrl = useMemo(() => {
    if (model?.kind !== 'image' || !generations) return undefined
    const selected = generations.find(
      (g) => g.id === node.selectedGenerationId && g.status === 'success' && g.url
    )
    if (selected?.url) return selected.url
    return generations.find((g) => g.status === 'success' && g.url)?.url ?? undefined
  }, [model?.kind, generations, node.selectedGenerationId])

  // Prompt lint (§6.5): pure, computed locally from the graph the panel already
  // holds — no round trip, so it re-runs live as the user types params.
  const projectAssets = useProjectAssets(projectId).data
  const styleId = video?.styleId ?? null
  const lintFindings = useMemo(() => {
    const designIdOf = (source: GraphNode | undefined): string | undefined => {
      const sourceParams = (source?.params ?? {}) as { designId?: unknown; assetId?: unknown }
      if (typeof sourceParams.designId === 'string') return sourceParams.designId
      if (typeof sourceParams.assetId === 'string') {
        return projectAssets?.find((a) => a.id === sourceParams.assetId)?.designId ?? undefined
      }
      return undefined
    }
    const durationOf = (source: GraphNode | undefined): number | undefined => {
      const value = (source?.params as { duration?: unknown } | undefined)?.duration
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }
    return lintNode({
      modelId: node.modelId,
      params,
      // The doctrine rules lint the payload, which for a styled video node is
      // the sandwich the video's art direction wraps around this prompt.
      ...(styleId ? { styleId } : {}),
      connections: connections.map((c) => ({
        edgeId: c.edge.id,
        handleKey: c.edge.targetHandle,
        ...(c.alias ? { alias: c.alias } : {}),
        ...(c.source ? { sourceLabel: c.source.label ?? c.source.key } : {}),
        ...(designIdOf(c.source) ? { designId: designIdOf(c.source) } : {}),
        ...(durationOf(c.source) !== undefined
          ? { sourceDurationSeconds: durationOf(c.source) }
          : {})
      }))
    })
  }, [node.modelId, params, connections, projectAssets, styleId])

  if (!model) {
    return (
      <PanelShell title="Unknown model" onClose={onClose} onDelete={onDelete}>
        <div className="text-sm text-danger">
          Model <code>{node.modelId}</code> is not registered.
        </div>
      </PanelShell>
    )
  }

  function setField(key: string, value: unknown) {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  /** Swap a connection with its neighbour — renumbers the @ aliases (§4.6). */
  function moveConnection(handleKey: string, index: number, delta: -1 | 1) {
    const conns = aliasesByHandle.get(handleKey) ?? []
    const ids = conns.map((c) => c.edge.id)
    const j = index + delta
    if (j < 0 || j >= ids.length) return
    const moved = ids[index]
    const neighbour = ids[j]
    if (moved === undefined || neighbour === undefined) return
    ids[index] = neighbour
    ids[j] = moved
    reorderEdgesMut.mutate({
      videoId: node.videoId,
      targetNodeId: node.id,
      targetHandle: handleKey,
      edgeIds: ids
    })
  }

  function commit(key: string, value: unknown) {
    const next = { ...params, [key]: value }
    setParams(next)
    updateParams.mutate({ nodeId: node.id, params: next })
  }

  /** Applies a lint fix (§6.5) — one journaled mutation, no dialog. */
  function applyLintFix(fix: LintFix): void {
    if (fix.kind === 'appendPrompt') {
      const current = (params.prompt as string | undefined) ?? ''
      commit('prompt', current.trim() ? `${current.trim()} ${fix.text}` : fix.text)
      return
    }
    if (fix.kind === 'setParam') {
      commit(fix.key, fix.value)
      return
    }
    rewireEdgeMut.mutate({ edgeId: fix.edgeId, targetHandle: fix.targetHandle })
  }

  function insertIntoPrompt(token: string) {
    const el = promptRef.current
    if (!el) return
    const current = (params.prompt as string | undefined) ?? ''
    const start = el.selectionStart ?? current.length
    const end = el.selectionEnd ?? current.length
    const insert = token.endsWith(' ') ? token : `${token} `
    const next = current.slice(0, start) + insert + current.slice(end)
    commit('prompt', next)
    // Restore caret position after the inserted token
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + insert.length
      el.setSelectionRange(pos, pos)
    })
  }

  function applyPromptMention(result: { value: string; caret: number }): void {
    setField('prompt', result.value)
    setPromptCaret(result.caret)
    requestAnimationFrame(() => {
      const el = promptRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(result.caret, result.caret)
    })
  }

  // Show face-restriction notice for any model whose description/notes mention it.
  const showFaceWarning = (model.promptingNotes ?? '').toLowerCase().includes('human face')

  // The style the run engine will append to the prompt (applyVideoStyle marker).
  const appliedStyle =
    model.kind !== 'audio' && params.applyVideoStyle === true && video?.styleId
      ? getStyle(video.styleId)
      : undefined

  const isRunning = !!generations?.some((g) => g.status === 'running' || g.status === 'pending')

  const estimatedCredits = costEstimate.data?.credits ?? null
  const runButton = (
    <div className="space-y-1">
      <Button
        variant="primary"
        onClick={onRun}
        disabled={isRunning}
        className="w-full justify-center"
        title="Generate this node (runs any missing upstream dependencies first)"
      >
        {isRunning ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Generating…
          </>
        ) : (
          <>
            <Play className="h-4 w-4" /> Generate
          </>
        )}
      </Button>
      {estimatedCredits !== null && !isRunning && (
        <div className="text-center text-[10px] text-neutral-500">
          {t('editor.estimatedCost', { credits: estimatedCredits })}
        </div>
      )}
      {/* Variants ×N (§6.6): parallel exploration in one gesture — N queue
          slots, N candidates to arbitrate in the grid compare below. */}
      {onRunVariants && (
        <div className="flex items-center justify-center gap-1.5 pt-0.5">
          <span className="text-[10px] text-neutral-500">{t('editor.variants.label')}</span>
          {VARIANT_CHOICES.map((count) => (
            <button
              key={count}
              onClick={() => onRunVariants(count)}
              disabled={isRunning}
              className="rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300 hover:border-accent hover:text-accent-soft disabled:opacity-40"
              title={
                estimatedCredits !== null
                  ? t('editor.variants.runCost', {
                      n: count,
                      credits: Math.round(estimatedCredits * count)
                    })
                  : t('editor.variants.run', { n: count })
              }
            >
              ×{count}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <PanelShell title={model.label} onClose={onClose} onDelete={onDelete} footer={runButton}>
      <div className="mb-3 text-xs text-neutral-500">{model.description}</div>

      <Label>Label</Label>
      <TextField
        defaultValue={node.label ?? ''}
        placeholder={model.label}
        onBlur={(e) => updateLabel.mutate({ nodeId: node.id, label: e.target.value })}
      />

      <div className="mt-3">
        <Label>Intent — expected result</Label>
        <TextArea
          key={node.id}
          defaultValue={node.intent ?? ''}
          placeholder="Describe the intended result: subject, action, framing, mood. Used to check the generated clip and adjust the prompt — not sent to the model."
          rows={3}
          onBlur={(e) => updateIntent.mutate({ nodeId: node.id, intent: e.target.value })}
        />
      </div>

      {/* Incoming connections (aliases) */}
      {model.inputs.length > 0 && (
        <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
          <div className="mb-2 text-xs font-semibold text-neutral-300">Connected inputs</div>
          <div className="space-y-2">
            {model.inputs.map((input) => {
              const conns = aliasesByHandle.get(input.key) ?? []
              const over = input.maxCount !== undefined && conns.length > input.maxCount
              return (
                <div key={input.key}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-neutral-400">
                      {input.label}
                      {input.required && <span className="text-danger"> *</span>}
                    </span>
                    {input.maxCount !== undefined && (
                      <span className={over ? 'text-danger' : 'text-neutral-600'}>
                        {conns.length}/{input.maxCount}
                      </span>
                    )}
                  </div>
                  {conns.length === 0 ? (
                    <div className="mt-0.5 text-[10px] italic text-neutral-600">
                      Not connected. Wire a node's output into this input on the canvas.
                    </div>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {conns.map((c, ci) => (
                        <li
                          key={c.edge.id}
                          className="flex items-center justify-between gap-2 rounded bg-neutral-800/60 px-2 py-1 text-[11px]"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {c.alias && (
                              <span className="mr-1.5 rounded bg-accent/15 px-1 py-0.5 font-mono text-[10px] text-accent-soft">
                                {c.alias}
                              </span>
                            )}
                            <span className="text-neutral-400">←</span>{' '}
                            <span className="text-neutral-200">
                              {c.source?.label ?? c.source?.key ?? 'unknown'}
                            </span>
                          </span>
                          {conns.length > 1 && (
                            <span className="flex flex-shrink-0 items-center">
                              <button
                                onClick={() => moveConnection(input.key, ci, -1)}
                                disabled={ci === 0 || reorderEdgesMut.isPending}
                                className="rounded p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-30"
                                title={t('editor.reorderUp')}
                              >
                                <ChevronUp className="h-3 w-3" />
                              </button>
                              <button
                                onClick={() => moveConnection(input.key, ci, 1)}
                                disabled={ci === conns.length - 1 || reorderEdgesMut.isPending}
                                className="rounded p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-30"
                                title={t('editor.reorderDown')}
                              >
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            </span>
                          )}
                          {c.alias && (
                            <button
                              onClick={() => insertIntoPrompt(c.alias!)}
                              className="rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-accent-hover"
                              title={`Insert ${c.alias} into the prompt`}
                            >
                              Insert
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Prompt lint (§6.5) — what the prompting doctrine would say about this
          node, before a credit is spent. Each finding carries its own fix. */}
      {lintFindings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {lintFindings.map((finding) => (
            <div
              key={`${finding.rule}:${finding.subject ?? ''}`}
              className={`flex gap-2 rounded-md border p-2.5 text-[11px] leading-relaxed ${
                finding.severity === 'error'
                  ? 'border-danger/40 bg-danger/5 text-danger'
                  : 'border-warning/40 bg-warning/5 text-warning'
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div>{finding.message}</div>
                {finding.fix && (
                  <button
                    onClick={() => applyLintFix(finding.fix!)}
                    className="mt-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-700"
                  >
                    {t(`editor.lint.fix.${finding.fix.kind}` as never)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Model tips (prompting, anchors vs references…). Collapsed by default —
          like the guide below, it is reference material, not chrome. */}
      {model.promptingNotes && (
        <details className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-neutral-300">
            <BookOpen className="mr-1 inline h-3 w-3 text-accent-soft" />
            {t('editor.promptingNotes')}
          </summary>
          <p className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap text-neutral-400">
            {model.promptingNotes}
          </p>
        </details>
      )}

      {/* The model's full prompting guide. It used to be agent-only (the MCP
          `prompting:<id>` topic), so the one actor who needs guidance — the
          person writing in the box above — was the only one who could not read
          it. Collapsed by default: it is reference, not chrome. */}
      {model.promptGuide && (
        <details className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-neutral-300">
            <BookOpen className="mr-1 inline h-3 w-3 text-accent-soft" />
            {t('editor.promptGuide')}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-400">
            {model.promptGuide}
          </p>
        </details>
      )}

      {showFaceWarning && (
        <div className="mt-3 flex gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            <b>No realistic human faces</b> in uploaded references for this model. The platform will
            block the upload.
          </span>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {model.paramFields.map((field) => (
          <div key={field.key}>
            <Label>{field.label}</Label>
            {field.type === 'textarea' && field.key === 'prompt' && (
              <div className="relative">
                <TextArea
                  ref={promptRef}
                  value={promptValue}
                  onChange={(e) => {
                    setField('prompt', e.target.value)
                    setPromptCaret(e.target.selectionStart ?? e.target.value.length)
                  }}
                  onSelect={(e) => setPromptCaret(e.currentTarget.selectionStart ?? 0)}
                  onBlur={(e) => commit('prompt', e.target.value)}
                  onKeyDown={(e) => promptMention.onKeyDown(e, applyPromptMention)}
                  placeholder={field.description}
                  rows={6}
                />
                {promptMention.open && (
                  <div className="absolute inset-x-0 top-full z-30 mt-1">
                    <MentionMenu
                      items={promptMention.items}
                      active={promptMention.active}
                      onHover={promptMention.setActive}
                      onPick={(item) => {
                        const result = promptMention.select(item)
                        if (result) applyPromptMention(result)
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            {field.type === 'textarea' && field.key !== 'prompt' && (
              <>
                <TextArea
                  value={(params[field.key] as string | undefined) ?? ''}
                  onChange={(e) => setField(field.key, e.target.value)}
                  onBlur={(e) => commit(field.key, e.target.value)}
                  placeholder={field.description}
                  rows={3}
                />
                {field.key === 'voiceMap' && (voicePersonas.data?.length ?? 0) > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {voicePersonas.data?.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        title={t('editor.speech.insertPersonaHint')}
                        className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 hover:border-accent hover:text-neutral-100"
                        onClick={() => {
                          const current = (
                            (params[field.key] as string | undefined) ?? ''
                          ).trimEnd()
                          const line = `${p.name} = ${p.voiceId}`
                          if (current.includes(p.voiceId)) return
                          commit(field.key, current === '' ? line : `${current}\n${line}`)
                        }}
                      >
                        + {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {field.type === 'text' && field.key === 'voiceId' && (
              <div className="flex flex-col gap-1.5">
                <TextField
                  value={(params[field.key] as string | undefined) ?? ''}
                  onChange={(e) => setField(field.key, e.target.value)}
                  onBlur={(e) => commit(field.key, e.target.value)}
                  placeholder={t('editor.speech.voiceIdPlaceholder')}
                />
                {(voicePersonas.data?.length ?? 0) > 0 && (
                  <Select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) commit(field.key, e.target.value)
                    }}
                  >
                    <option value="">{t('editor.speech.usePersona')}</option>
                    {voicePersonas.data?.map((p) => (
                      <option key={p.id} value={p.voiceId}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}
            {field.type === 'text' && field.key !== 'voiceId' && (
              <TextField
                value={(params[field.key] as string | undefined) ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                onBlur={(e) => commit(field.key, e.target.value)}
              />
            )}
            {field.type === 'number' && (
              <TextField
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={(params[field.key] as number | undefined) ?? ''}
                onChange={(e) => setField(field.key, Number(e.target.value))}
                // The min/max attributes only guard the steppers — a typed value
                // reaches us raw, and the model's bounds are an API contract
                // (a 3 s Seedance clip is rejected). Clamp on commit.
                onBlur={(e) => commit(field.key, clampParamToField(Number(e.target.value), field))}
              />
            )}
            {field.type === 'select' && (
              <Select
                value={(params[field.key] as string | undefined) ?? ''}
                onChange={(e) => commit(field.key, e.target.value)}
              >
                {field.options?.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            )}
            {field.type === 'boolean' && (
              <label className="flex items-center gap-2 text-sm text-neutral-200">
                <input
                  type="checkbox"
                  checked={!!params[field.key]}
                  onChange={(e) => commit(field.key, e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-600 bg-neutral-900"
                />
                {field.description ?? field.label}
              </label>
            )}
            {field.description && field.type !== 'boolean' && (
              <div className="mt-0.5 text-[10px] text-neutral-500">{field.description}</div>
            )}
          </div>
        ))}
      </div>

      {/* Style-at-payload preview: the business prompt stays in the textarea,
          the bible suffix is appended by the run engine — shown here read-only. */}
      {appliedStyle && (
        <details className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-semibold text-neutral-300">
            <Palette className="mr-1 inline h-3 w-3 text-accent-soft" />
            {t('editor.styleAppliedAtRun', {
              style: t(`styles.${appliedStyle.id}.name` as never)
            })}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-400">
            {appliedStyle.styleBible}
          </p>
        </details>
      )}

      {refinerImageUrl && (
        <PromptRefiner
          imageUrl={refinerImageUrl}
          currentPrompt={(params.prompt as string | undefined) ?? ''}
          onApply={(p) => commit('prompt', p)}
        />
      )}

      <div className="mt-4 flex justify-end">
        <Button
          variant="ghost"
          onClick={() => {
            // Same seed as node creation: model defaults + video defaults + style flag.
            const defs = {
              ...defaultParamsFor(node.modelId),
              ...videoDefaultParams(node.modelId, video ?? null),
              ...(model.kind !== 'audio' ? { applyVideoStyle: true } : {})
            }
            setParams(defs)
            updateParams.mutate({ nodeId: node.id, params: defs })
          }}
        >
          Reset to defaults
        </Button>
      </div>

      {/* Generation history */}
      <div className="mt-6 border-t border-neutral-800 pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          History
        </h3>
        {(generations?.filter((g) => g.status === 'success' && g.url).length ?? 0) >= 2 && (
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-[10px] leading-snug text-neutral-500">
              {compareIds.length === 1 ? t('editor.compare.pickSecond') : t('editor.compare.hint')}
            </p>
            {compareIds.length >= 2 && (
              <Button
                variant="secondary"
                size="sm"
                className="flex-shrink-0"
                onClick={() => setCompareOpen(true)}
              >
                <Columns2 className="h-3.5 w-3.5" />
                {t('editor.compare.open', { n: compareIds.length })}
              </Button>
            )}
          </div>
        )}
        {node.intent && (
          <div className="mb-2 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-[11px] text-neutral-300">
            <span className="font-semibold text-accent-soft">Expected:</span> {node.intent}
          </div>
        )}
        {generations === undefined ? (
          <div className="text-xs text-neutral-500">Loading…</div>
        ) : generations.length === 0 ? (
          <div className="text-xs text-neutral-500 italic">No runs yet.</div>
        ) : (
          <ul className="space-y-2">
            {generations.map((g) => (
              <GenerationCard
                key={g.id}
                generation={g}
                model={model}
                videoId={node.videoId}
                isSelected={node.selectedGenerationId === g.id}
                onUseThis={() => selectGen.mutate({ nodeId: node.id, generationId: g.id })}
                defaultAssetName={node.label ?? model.label}
                nodeLabel={node.label ?? model.label}
                onAskAssistant={onAskAssistant}
                onRetry={isRunning ? undefined : onRun}
                compared={compareIds.includes(g.id)}
                onToggleCompare={
                  g.status === 'success' && g.url && model.kind !== 'audio'
                    ? () =>
                        setCompareIds((prev) =>
                          prev.includes(g.id)
                            ? prev.filter((id) => id !== g.id)
                            : // Sliding window: picking beyond the cap drops the oldest.
                              [...prev.slice(-(MAX_VARIANTS - 1)), g.id]
                        )
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>

      {compareOpen &&
        (() => {
          const picked = compareIds.flatMap((id) => {
            const gen = generations?.find((g) => g.id === id)
            return gen ? [gen] : []
          })
          if (picked.length < 2) return null
          const close = (): void => {
            setCompareOpen(false)
            setCompareIds([])
          }
          return (
            <CompareModal
              gens={picked}
              kind={model.kind === 'video' ? 'video' : 'image'}
              activeId={node.selectedGenerationId}
              onUse={(id) => {
                selectGen.mutate({ nodeId: node.id, generationId: id })
                close()
              }}
              onClose={close}
            />
          )
        })()}
    </PanelShell>
  )
}

/**
 * Compare grid (§4.6, generalized to N candidates by §6.6) — the core
 * iteration gesture: 2 to MAX_VARIANTS candidates side by side with synced
 * playback (videos) or synced zoom/pan (images), and "Use this" on each pane.
 * Two panes lay out in a row; three or more wrap into a 2-column grid.
 */
function CompareModal({
  gens,
  kind,
  activeId,
  onUse,
  onClose
}: {
  gens: GenRow[]
  kind: 'image' | 'video'
  activeId: string | null
  onUse: (id: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  // One ref slot per pane, indexed like `gens` (arrays, not fixed hooks: the
  // pane count varies with how many candidates the user picked).
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  const scrollRefs = useRef<(HTMLDivElement | null)[]>([])
  const syncingScroll = useRef(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [zoom, setZoom] = useState(1)

  /** The pane every other one follows for playback and scrubbing. */
  const leader = (): HTMLVideoElement | null => videoRefs.current[0] ?? null
  const players = (): HTMLVideoElement[] =>
    videoRefs.current.filter((el): el is HTMLVideoElement => el !== null)

  function togglePlay() {
    const els = players()
    if (els.length === 0) return
    if (playing) {
      for (const el of els) el.pause()
      setPlaying(false)
    } else {
      const time = leader()?.currentTime ?? 0
      for (const el of els) {
        el.currentTime = Number.isFinite(el.duration) ? Math.min(time, el.duration) : time
        void el.play()
      }
      setPlaying(true)
    }
  }

  /** Scrub every video to the same fraction of the leader's duration (capped). */
  function scrub(fraction: number) {
    const lead = leader()
    if (!lead || !Number.isFinite(lead.duration)) return
    const time = fraction * lead.duration
    for (const el of players()) {
      el.currentTime = Number.isFinite(el.duration) ? Math.min(time, el.duration) : time
    }
    setProgress(fraction)
  }

  /** Mirror one pane's scroll onto every other (synced pan while zoomed). */
  function syncScroll(from: number) {
    if (syncingScroll.current) return
    const src = scrollRefs.current[from]
    if (!src) return
    syncingScroll.current = true
    scrollRefs.current.forEach((dst, i) => {
      if (!dst || i === from) return
      dst.scrollLeft = src.scrollLeft
      dst.scrollTop = src.scrollTop
    })
    syncingScroll.current = false
  }

  const sides = gens.map((gen, index) => ({ gen, index }))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island flex max-h-[90vh] w-full max-w-5xl flex-col gap-3 overflow-hidden px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
            <Columns2 className="h-4 w-4 text-accent" />{' '}
            {t('editor.compare.title', { n: gens.length })}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 2 candidates → one row; 3+ → a 2-column grid so each pane stays big. */}
        <div
          className={`grid min-h-0 flex-1 gap-3 ${gens.length === 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}
        >
          {sides.map(({ gen, index }) => (
            <div key={gen.id} className="flex min-w-0 min-h-0 flex-col gap-2">
              <div className="flex items-baseline gap-1.5 text-[10px] text-neutral-500">
                <span className="rounded bg-neutral-800 px-1 font-mono text-neutral-300">
                  {index + 1}
                </span>
                {new Date(gen.createdAt).toLocaleString()}
              </div>
              {kind === 'video' ? (
                <video
                  ref={(el) => {
                    videoRefs.current[index] = el
                  }}
                  src={gen.url ?? undefined}
                  muted
                  playsInline
                  onTimeUpdate={
                    index === 0
                      ? (e) => {
                          const el = e.currentTarget
                          if (Number.isFinite(el.duration) && el.duration > 0) {
                            setProgress(el.currentTime / el.duration)
                          }
                        }
                      : undefined
                  }
                  onEnded={() => setPlaying(false)}
                  className="min-h-0 w-full flex-1 rounded bg-neutral-950 object-contain"
                />
              ) : (
                <div
                  ref={(el) => {
                    scrollRefs.current[index] = el
                  }}
                  onScroll={() => syncScroll(index)}
                  className="min-h-0 flex-1 overflow-auto rounded bg-neutral-950"
                >
                  <img
                    src={gen.url ?? undefined}
                    alt=""
                    style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
                  />
                </div>
              )}
              {activeId === gen.id ? (
                <span className="self-center rounded bg-accent/15 px-2 py-1 text-[11px] text-accent-soft">
                  {t('editor.compare.active')}
                </span>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  className="self-center"
                  onClick={() => onUse(gen.id)}
                >
                  <Check className="h-3.5 w-3.5" /> {t('editor.compare.useThis')}
                </Button>
              )}
            </div>
          ))}
        </div>

        {kind === 'video' ? (
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={togglePlay}>
              {playing ? t('editor.compare.pause') : t('editor.compare.play')}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={progress}
              onChange={(e) => scrub(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: 'var(--color-accent)' }}
              title={t('editor.compare.scrub')}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-neutral-500">{t('editor.compare.zoom')}</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span className="w-10 text-right font-mono text-[11px] text-neutral-400">
              {zoom.toFixed(1)}×
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Prompt refiner (Claude Opus 4.8 via kie.ai) ───────────────────────────
function PromptRefiner({
  imageUrl,
  currentPrompt,
  onApply
}: {
  imageUrl: string
  currentPrompt: string
  onApply: (prompt: string) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  async function handleRefine() {
    if (!instruction.trim() || loading) return
    setError(null)
    setSuggestion(null)
    setApplied(false)
    setLoading(true)
    try {
      const { prompt } = await refineImagePrompt({
        currentPrompt,
        imageUrl,
        instruction: instruction.trim()
      })
      setSuggestion(prompt)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-4 rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-accent-soft">
        <Sparkles className="h-3.5 w-3.5" /> Adjust prompt with Claude
      </div>
      <p className="mb-2 text-[10px] leading-relaxed text-neutral-500">
        Describe what to fix or change in the generated image. Claude Opus 4.8 looks at the active
        image + the current prompt and proposes a revised prompt.
      </p>
      <TextArea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="e.g. warmer sunset light, fix the right hand (6 fingers), tighter framing on the face."
        rows={3}
      />
      <Button
        variant="primary"
        onClick={handleRefine}
        disabled={loading || !instruction.trim()}
        className="mt-2 w-full justify-center"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Analyzing…
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" /> Suggest adjusted prompt
          </>
        )}
      </Button>

      {error && <div className="mt-2 text-[10px] text-danger">{error}</div>}

      {suggestion && (
        <div className="mt-3">
          <Label>Suggested prompt</Label>
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] leading-relaxed text-neutral-200">
            {suggestion}
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSuggestion(null)}>
              Dismiss
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onApply(suggestion)
                setApplied(true)
              }}
            >
              {applied ? <Check className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              {applied ? 'Applied' : 'Apply'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function PanelShell({
  title,
  onClose,
  onDelete,
  footer,
  children
}: {
  title: string
  onClose: () => void
  onDelete?: () => void
  /** Pinned at the bottom of the panel, outside the scroll area — always reachable. */
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <aside className="island flex min-h-0 w-96 flex-1 flex-shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button
              onClick={onDelete}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
              title="Delete node"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800"
            title="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
      {(footer || onDelete) && (
        <div className="space-y-2 border-t border-neutral-800 p-3">
          {footer}
          {onDelete && (
            <Button variant="danger" onClick={onDelete} className="w-full justify-center">
              <Trash2 className="h-4 w-4" /> Delete node
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}

// ─── GenerationCard ──────────────────────────────────────────────────────
type GenRow = {
  id: string
  status: 'pending' | 'running' | 'success' | 'failed'
  url?: string | null
  createdAt: number
  errorMessage?: string | null
  /** §6.1 — the run was substituted to the model's draft equivalent. */
  draft?: boolean
  /** §6.2 — vision-QC outcome ('error' = the QC call itself failed). */
  qcVerdict?: 'pass' | 'warn' | 'error' | null
  qcNotes?: string | null
  /** §8 — speech runs store what was spoken, with timestamps. */
  transcript?: SpeechTranscript | null
}

function GenerationCard({
  generation: g,
  model,
  videoId,
  isSelected,
  onUseThis,
  defaultAssetName,
  nodeLabel,
  onAskAssistant,
  onRetry,
  compared,
  onToggleCompare
}: {
  generation: GenRow
  model: ModelDefinition
  videoId: string
  isSelected: boolean
  onUseThis: () => void
  defaultAssetName: string
  nodeLabel: string
  onAskAssistant?: (text: string) => void
  /** Re-runs the node — offered on failed generations (absent while one runs). */
  onRetry?: () => void
  /** True while this generation is picked for the A/B compare (§4.6). */
  compared?: boolean
  /** Toggles this generation in the A/B compare pair (undefined = not comparable). */
  onToggleCompare?: () => void
}) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState(defaultAssetName)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  /** §6.3 — the "select + fix" modal for this output. */
  const [annotating, setAnnotating] = useState(false)

  async function handleDownload() {
    if (!g.url) return
    setError(null)
    setDownloading(true)
    try {
      await downloadMedia(g.url, {
        name: defaultAssetName,
        createdAt: g.createdAt,
        fallbackExt: FALLBACK_EXT[model.kind] ?? 'bin'
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }

  async function handlePromote(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await promoteGeneration({
        generationId: g.id,
        name: name.trim() || defaultAssetName,
        description: description.trim() || undefined
      })
      setSaved(true)
      setFormOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <li
      className={`overflow-hidden rounded border ${
        isSelected ? 'border-accent' : 'border-neutral-800'
      }`}
    >
      <div className="bg-neutral-950">
        {g.status === 'success' && g.url ? (
          model.kind === 'video' ? (
            <video src={g.url} muted loop controls className="w-full" />
          ) : model.kind === 'audio' ? (
            <div className="p-2">
              <audio src={g.url} controls className="w-full" />
              {g.transcript && (
                <details className="mt-1.5 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1">
                  <summary className="cursor-pointer select-none text-[10px] font-semibold text-neutral-400">
                    {t('editor.speech.transcript')}
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-[10px] leading-relaxed text-neutral-300">
                    {formatTranscript(g.transcript)}
                  </pre>
                </details>
              )}
            </div>
          ) : (
            <img
              src={g.url}
              alt=""
              className="w-full cursor-zoom-in"
              title={t('editor.enlarge')}
              onClick={() => setZoomed(true)}
            />
          )
        ) : g.status === 'running' ? (
          <div className="flex items-center gap-2 p-3 text-xs text-warning">
            <Loader2 className="h-3 w-3 animate-spin" /> Generating…
          </div>
        ) : g.status === 'failed' ? (
          <div className="p-3">
            <div className="text-xs text-danger">Failed: {g.errorMessage ?? 'unknown error'}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent-soft hover:bg-accent/20"
                >
                  <RefreshCw className="h-3 w-3" /> {t('editor.retry')}
                </button>
              )}
              {onAskAssistant && (
                <button
                  onClick={() =>
                    onAskAssistant(
                      t('chat.fixPromptPrefill', {
                        label: nodeLabel,
                        error: g.errorMessage ?? 'unknown error'
                      })
                    )
                  }
                  className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent-soft hover:bg-accent/20"
                >
                  <MessageSquare className="h-3 w-3" /> {t('editor.fixWithAssistant')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="p-3 text-xs text-neutral-500">Pending…</div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[10px] text-neutral-500">
        <span>{new Date(g.createdAt).toLocaleString()}</span>
        <div className="flex items-center gap-1">
          {g.draft && (
            <span
              className="rounded bg-accent-soft/15 px-1.5 py-0.5 text-accent-soft"
              title={t('editor.draft.badgeTitle')}
            >
              {t('editor.draft.badge')}
            </span>
          )}
          {g.qcVerdict === 'pass' && (
            <span
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-success"
              title={t('editor.qc.passTitle')}
            >
              <ShieldCheck className="h-3 w-3" /> {t('editor.qc.pass')}
            </span>
          )}
          {g.qcVerdict === 'warn' && (
            <span
              className="flex items-center gap-0.5 rounded bg-warning/10 px-1.5 py-0.5 text-warning"
              title={g.qcNotes ?? t('editor.qc.warnTitle')}
            >
              <ShieldAlert className="h-3 w-3" /> {t('editor.qc.warn')}
            </span>
          )}
          {g.qcVerdict === 'error' && (
            <span
              className="rounded px-1.5 py-0.5 text-neutral-500"
              title={t('editor.qc.errorTitle', { notes: g.qcNotes ?? '' })}
            >
              {t('editor.qc.error')}
            </span>
          )}
          {g.status === 'success' && onAskAssistant && (
            <button
              onClick={() => onAskAssistant(t('chat.adjustPromptPrefill', { label: nodeLabel }))}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-soft hover:bg-accent/10"
              title={t('editor.adjustWithAssistant')}
            >
              <MessageSquare className="h-3 w-3" />
            </button>
          )}
          {g.status === 'success' && g.url && model.kind !== 'audio' && (
            <button
              onClick={() => setZoomed(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('editor.enlarge')}
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
          {/* §6.3 — note a region (image) or a timecode (clip) on this output. */}
          {g.status === 'success' && g.url && model.kind !== 'audio' && (
            <button
              onClick={() => setAnnotating(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('editor.annotate.open')}
            >
              <Sparkles className="h-3 w-3" />
            </button>
          )}
          {onToggleCompare && (
            <button
              onClick={onToggleCompare}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${
                compared
                  ? 'bg-accent/15 text-accent-soft'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
              title={t('editor.compare.toggle')}
            >
              <Columns2 className="h-3 w-3" />
            </button>
          )}
          {g.status === 'success' && g.url && (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-50"
              title="Download this output to your computer"
            >
              {downloading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              Download
            </button>
          )}
          {g.status === 'success' && (
            <button
              onClick={() => {
                setSaved(false)
                setName(defaultAssetName)
                setDescription('')
                setError(null)
                setFormOpen((v) => !v)
              }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-success hover:bg-success/10"
              title="Save this output to the project's asset library"
            >
              <FolderPlus className="h-3 w-3" />
              {saved ? 'Saved' : 'Save as asset'}
            </button>
          )}
          {g.status === 'success' && !isSelected && (
            <button
              onClick={onUseThis}
              className="rounded px-1.5 py-0.5 text-accent hover:bg-accent/10"
            >
              Use this
            </button>
          )}
          {isSelected && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent-soft">Active</span>
          )}
        </div>
      </div>

      {/* §6.2 — the QC linter's report, with the fix gesture carrying the notes. */}
      {g.qcVerdict === 'warn' && g.qcNotes && (
        <div className="border-t border-warning/20 bg-warning/5 px-2 py-1.5">
          <div className="text-[10px] leading-snug text-warning">{g.qcNotes}</div>
          {onAskAssistant && (
            <button
              onClick={() =>
                onAskAssistant(t('chat.qcFixPrefill', { label: nodeLabel, notes: g.qcNotes ?? '' }))
              }
              className="mt-1.5 flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent-soft hover:bg-accent/20"
            >
              <MessageSquare className="h-3 w-3" /> {t('editor.fixWithAssistant')}
            </button>
          )}
        </div>
      )}

      {error && !formOpen && <div className="px-2 pb-1 text-[10px] text-danger">{error}</div>}

      {formOpen && (
        <form
          onSubmit={handlePromote}
          className="space-y-2 border-t border-neutral-800 bg-neutral-900/40 p-2"
        >
          <div>
            <Label>Asset name</Label>
            <TextField
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultAssetName}
            />
          </div>
          <div>
            <Label>Description (for LLMs)</Label>
            <TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Main character — young female pilot in red flight suit, brown ponytail."
              rows={2}
            />
          </div>
          {error && <div className="text-[10px] text-danger">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <FolderPlus className="h-3 w-3" />
              )}
              Save to assets
            </Button>
          </div>
        </form>
      )}

      {zoomed && g.url && (
        <Lightbox
          url={g.url}
          kind={model.kind === 'video' ? 'video' : 'image'}
          onClose={() => setZoomed(false)}
        />
      )}

      {annotating && g.url && (
        <AnnotateModal
          generationId={g.id}
          videoId={videoId}
          url={g.url}
          kind={model.kind === 'video' ? 'video' : 'image'}
          nodeLabel={nodeLabel}
          onClose={() => setAnnotating(false)}
          onAskAssistant={onAskAssistant}
        />
      )}
    </li>
  )
}
