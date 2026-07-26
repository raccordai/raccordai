import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Sparkles, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildAssistantRequest,
  describeRegion,
  formatTimecode,
  isDegenerateRegion,
  normalizeRegion,
  type Annotation,
  type Region
} from '@shared/annotations'
import { Button } from '@renderer/components/ui/Button'
import { TextArea } from '@renderer/components/ui/Input'
import { useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { graphKeys } from './data'

/**
 * Regional feedback (§6.3) — "select + fix" on a generation: circle what is
 * wrong on the frame (or mark a timecode on a clip), say why in one sentence,
 * and turn the notes into a pre-wired edit node or an assistant request.
 *
 * The gesture is the point: the user's judgment stops living in their head and
 * becomes a signal the app (and later the taste memory, §6.7) can act on.
 */
export function AnnotateModal({
  generationId,
  videoId,
  url,
  kind,
  nodeLabel,
  onClose,
  onAskAssistant
}: {
  generationId: string
  videoId: string
  url: string
  kind: 'image' | 'video'
  nodeLabel: string
  onClose: () => void
  onAskAssistant?: (text: string) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const frameRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [draft, setDraft] = useState('')
  /** Region being drawn (normalized), or the one waiting for its comment. */
  const [region, setRegion] = useState<Region | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [timecodeSec, setTimecodeSec] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const annotationsKey = ['annotations', generationId]
  const annotations = useQuery({
    queryKey: annotationsKey,
    queryFn: () => invoke('annotations:list', { generationId })
  }).data

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: annotationsKey })
  }

  /** Pointer position as a fraction of the media box. */
  function pointIn(event: React.PointerEvent): { x: number; y: number } | null {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }

  function startDraw(event: React.PointerEvent): void {
    if (kind !== 'image') return
    const point = pointIn(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setRegion({ x: point.x, y: point.y, w: 0, h: 0 })
    setDrawing(true)
  }

  function moveDraw(event: React.PointerEvent): void {
    if (!drawing) return
    const point = pointIn(event)
    setRegion((current) =>
      current && point ? { ...current, w: point.x - current.x, h: point.y - current.y } : current
    )
  }

  function endDraw(): void {
    if (!drawing) return
    setDrawing(false)
    setRegion((current) => {
      if (!current) return null
      const normalized = normalizeRegion(current)
      // A click without a drag is not a selection — drop it silently.
      return isDegenerateRegion(normalized) ? null : normalized
    })
  }

  async function addNote(): Promise<void> {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke('annotations:add', {
        generationId,
        comment: draft.trim(),
        region,
        timecodeSec
      })
      setDraft('')
      setRegion(null)
      setTimecodeSec(null)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function removeNote(annotationId: string): Promise<void> {
    await invoke('annotations:delete', { annotationId })
    refresh()
  }

  async function createEditNode(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await invoke('annotations:createEditNode', { generationId })
      void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
      toast.success(t('editor.annotate.editNodeCreated'))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const list: Annotation[] = annotations ?? []
  const drawn = region ? normalizeRegion(region) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island flex max-h-[90vh] w-full max-w-4xl flex-col gap-3 overflow-hidden px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
            <Sparkles className="h-4 w-4 text-accent" /> {t('editor.annotate.title')}
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-[11px] text-neutral-500">
          {kind === 'image' ? t('editor.annotate.hintImage') : t('editor.annotate.hintVideo')}
        </p>

        <div className="flex min-h-0 flex-1 gap-3">
          <div
            ref={frameRef}
            onPointerDown={startDraw}
            onPointerMove={moveDraw}
            onPointerUp={endDraw}
            onPointerCancel={endDraw}
            className={`relative min-h-0 flex-1 self-start overflow-hidden rounded bg-neutral-950 ${
              kind === 'image' ? 'cursor-crosshair touch-none' : ''
            }`}
          >
            {kind === 'image' ? (
              <img src={url} alt="" draggable={false} className="w-full select-none" />
            ) : (
              <video ref={videoRef} src={url} controls className="w-full" />
            )}
            {drawn && (
              <div
                className="pointer-events-none absolute border-2 border-accent bg-accent/15"
                style={{
                  left: `${drawn.x * 100}%`,
                  top: `${drawn.y * 100}%`,
                  width: `${drawn.w * 100}%`,
                  height: `${drawn.h * 100}%`
                }}
              />
            )}
          </div>

          <div className="flex w-64 flex-shrink-0 flex-col gap-2 overflow-y-auto">
            {list.length === 0 ? (
              <div className="text-[11px] text-neutral-500 italic">
                {t('editor.annotate.empty')}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {list.map((annotation) => (
                  <li
                    key={annotation.id}
                    className="flex items-start gap-1.5 rounded bg-neutral-800/60 px-2 py-1.5 text-[11px]"
                  >
                    <span className="min-w-0 flex-1">
                      {annotation.region && (
                        <span className="mr-1 rounded bg-accent/15 px-1 text-[10px] text-accent-soft">
                          {describeRegion(annotation.region)}
                        </span>
                      )}
                      {annotation.timecodeSec !== null && (
                        <span className="mr-1 rounded bg-accent/15 px-1 font-mono text-[10px] text-accent-soft">
                          {formatTimecode(annotation.timecodeSec)}
                        </span>
                      )}
                      <span className="text-neutral-200">{annotation.comment}</span>
                    </span>
                    <button
                      onClick={() => void removeNote(annotation.id)}
                      className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-danger"
                      title={t('editor.annotate.remove')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-auto space-y-1.5 pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                {kind === 'image' ? (
                  drawn ? (
                    <span className="text-accent-soft">{describeRegion(drawn)}</span>
                  ) : (
                    <span>{t('editor.annotate.wholeFrame')}</span>
                  )
                ) : (
                  <>
                    <button
                      onClick={() => setTimecodeSec(videoRef.current?.currentTime ?? 0)}
                      className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:border-accent hover:text-accent-soft"
                    >
                      {t('editor.annotate.markTime')}
                    </button>
                    {timecodeSec !== null && (
                      <span className="font-mono text-accent-soft">
                        {formatTimecode(timecodeSec)}
                      </span>
                    )}
                  </>
                )}
              </div>
              <TextArea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder={t('editor.annotate.placeholder')}
              />
              {error && <div className="text-[10px] text-danger">{error}</div>}
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-center"
                disabled={!draft.trim() || busy}
                onClick={() => void addNote()}
              >
                {t('editor.annotate.add')}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 pt-3">
          {onAskAssistant && (
            <Button
              variant="ghost"
              size="sm"
              disabled={list.length === 0}
              onClick={() => {
                onAskAssistant(buildAssistantRequest(nodeLabel, list, kind))
                onClose()
              }}
            >
              <MessageSquare className="h-3.5 w-3.5" /> {t('editor.fixWithAssistant')}
            </Button>
          )}
          {kind === 'image' && (
            <Button
              variant="primary"
              size="sm"
              disabled={list.length === 0 || busy}
              onClick={() => void createEditNode()}
            >
              <Sparkles className="h-3.5 w-3.5" /> {t('editor.annotate.createEditNode')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
