import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Download,
  FolderPlus,
  Loader2,
  Maximize2,
  MessageSquare,
  Palette,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DESIGN_RECIPES } from '@shared/designs/registry'
import type { GraphNode } from '@shared/ipc/contracts'
import type { ModelDefinition } from '@shared/models'
import { defaultParamsFor, getModel, videoDefaultParams } from '@shared/models'
import { getStyle } from '@shared/styles/registry'
import { Button } from '@renderer/components/ui/Button'
import { Lightbox } from '@renderer/components/Lightbox'
import { VideoThumb } from '@renderer/components/VideoThumb'
import { Label, Select, TextArea, TextField } from '@renderer/components/ui/Input'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { incomingConnectionsFor, useWorkflowGraph } from './workflowContext'
import { downloadMedia } from '@renderer/lib/downloadMedia'
import { invoke } from '@renderer/lib/ipc'
import { graphKeys, useIpcMutation, useNodeGenerations, useProjectAssets, useVideo } from './data'
import { promoteGeneration, refineImagePrompt } from './generationRuntime'

/** Sensible extension fallback per media kind when the URL/MIME doesn't reveal one. */
const FALLBACK_EXT: Record<string, string> = { image: 'png', video: 'mp4', audio: 'mp3' }

interface Props {
  node: GraphNode
  projectId: string
  onClose: () => void
  /** Run this node (auto-runs any missing upstream dependencies first). */
  onRun: () => void
  /** Opens the assistant with a prepared draft. */
  onAskAssistant?: (text: string) => void
}

export function NodeParamsPanel({ node, projectId, onClose, onRun, onAskAssistant }: Props) {
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
      onClose={onClose}
      onDelete={handleDelete}
      onRun={onRun}
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
  onClose,
  onDelete,
  onRun,
  onAskAssistant
}: {
  node: GraphNode
  onClose: () => void
  onDelete: () => void
  onRun: () => void
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
  const generations = useNodeGenerations(node.id).data
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

  // Image to feed the prompt refiner: the active generation if it's an image, else the latest successful image.
  const refinerImageUrl = useMemo(() => {
    if (model?.kind !== 'image' || !generations) return undefined
    const selected = generations.find(
      (g) => g.id === node.selectedGenerationId && g.status === 'success' && g.url
    )
    if (selected?.url) return selected.url
    return generations.find((g) => g.status === 'success' && g.url)?.url ?? undefined
  }, [model?.kind, generations, node.selectedGenerationId])

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

  function commit(key: string, value: unknown) {
    const next = { ...params, [key]: value }
    setParams(next)
    updateParams.mutate({ nodeId: node.id, params: next })
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
                      {conns.map((c) => (
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

      {model.promptingNotes && (
        <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-[11px] leading-relaxed text-neutral-400 whitespace-pre-wrap">
          {model.promptingNotes}
        </div>
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
            {field.type === 'textarea' && (
              <TextArea
                ref={field.key === 'prompt' ? promptRef : undefined}
                value={(params[field.key] as string | undefined) ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                onBlur={(e) => commit(field.key, e.target.value)}
                placeholder={field.description}
                rows={field.key === 'prompt' ? 6 : 3}
              />
            )}
            {field.type === 'text' && (
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
                onBlur={(e) => commit(field.key, Number(e.target.value))}
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
                isSelected={node.selectedGenerationId === g.id}
                onUseThis={() => selectGen.mutate({ nodeId: node.id, generationId: g.id })}
                defaultAssetName={node.label ?? model.label}
                nodeLabel={node.label ?? model.label}
                onAskAssistant={onAskAssistant}
                onRetry={isRunning ? undefined : onRun}
              />
            ))}
          </ul>
        )}
      </div>
    </PanelShell>
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
}

function GenerationCard({
  generation: g,
  model,
  isSelected,
  onUseThis,
  defaultAssetName,
  nodeLabel,
  onAskAssistant,
  onRetry
}: {
  generation: GenRow
  model: ModelDefinition
  isSelected: boolean
  onUseThis: () => void
  defaultAssetName: string
  nodeLabel: string
  onAskAssistant?: (text: string) => void
  /** Re-runs the node — offered on failed generations (absent while one runs). */
  onRetry?: () => void
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
    </li>
  )
}
