import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckpointDiff } from '@shared/checkpointDiff'
import { Button } from '@renderer/components/ui/Button'
import { TextField } from '@renderer/components/ui/Input'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { useInvalidateWorkflow } from './data'

/**
 * Named checkpoints (§6.4) — the safety net that authorizes boldness: capture
 * the graph before a risky rework, see exactly what a restore would change,
 * and roll back in one journaled step (a single undo walks back out of it).
 */
export function CheckpointsPanel({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const queryClient = useQueryClient()
  const invalidateWorkflow = useInvalidateWorkflow(videoId)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  /** Checkpoint being reviewed before a restore (null = none). */
  const [pending, setPending] = useState<{
    id: string
    diff: CheckpointDiff & { name: string }
  } | null>(null)

  const listKey = ['checkpoints', videoId]
  const checkpoints = useQuery({
    queryKey: listKey,
    queryFn: () => invoke('checkpoints:list', { videoId })
  }).data
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: listKey })
  }

  async function create(): Promise<void> {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      await invoke('checkpoints:create', { videoId, name: name.trim() })
      setName('')
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function review(checkpointId: string): Promise<void> {
    const diff = await invoke('checkpoints:diff', { checkpointId })
    setPending({ id: checkpointId, diff })
  }

  async function restore(): Promise<void> {
    if (!pending) return
    setBusy(true)
    try {
      const result = await invoke('checkpoints:restore', { checkpointId: pending.id })
      // Everything the graph feeds: canvas, generations, undo/redo state.
      invalidateWorkflow()
      toast.success(t('editor.checkpoints.restored', { count: result.selectionsRestored }))
      if (result.selectionsMissing > 0) {
        toast.info(t('editor.checkpoints.restoredMissing', { count: result.selectionsMissing }))
      }
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  async function remove(checkpointId: string, checkpointName: string): Promise<void> {
    const accepted = await confirmModal({
      message: t('editor.checkpoints.deleteConfirm', { name: checkpointName }),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (!accepted) return
    await invoke('checkpoints:delete', { checkpointId })
    refresh()
  }

  return (
    <aside className="island flex w-80 flex-col overflow-hidden px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <Flag className="h-4 w-4 text-accent" /> {t('editor.checkpoints.title')}
        </h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-1.5">
        <TextField
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
          placeholder={t('editor.checkpoints.namePlaceholder')}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!name.trim() || busy}
          onClick={() => void create()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('editor.checkpoints.create')}
        </Button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {checkpoints === undefined ? (
          <div className="text-xs text-neutral-500">{t('editor.historyPanel.loading')}</div>
        ) : checkpoints.length === 0 ? (
          <div className="text-xs text-neutral-500 italic">{t('editor.checkpoints.empty')}</div>
        ) : (
          <ul className="space-y-1.5">
            {checkpoints.map((checkpoint) => (
              <li
                key={checkpoint.id}
                className="rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-neutral-200">{checkpoint.name}</div>
                    <div className="text-[10px] text-neutral-500">
                      {new Date(checkpoint.createdAt).toLocaleString()} ·{' '}
                      {t('editor.checkpoints.nodeCount', { count: checkpoint.nodeCount })}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center">
                    <button
                      onClick={() => void review(checkpoint.id)}
                      className="rounded p-1 text-accent hover:bg-accent/10"
                      title={t('editor.checkpoints.restore')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void remove(checkpoint.id, checkpoint.name)}
                      className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
                      title={t('editor.checkpoints.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending && (
        <RestoreConfirm
          diff={pending.diff}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void restore()}
        />
      )}
    </aside>
  )
}

/** The diff a restore implies, stated in what it does to the current graph. */
function RestoreConfirm({
  diff,
  busy,
  onCancel,
  onConfirm
}: {
  diff: CheckpointDiff & { name: string }
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const lines: Array<{ key: string; text: string; danger?: boolean }> = []
  // "added" on the diff means present NOW but not in the checkpoint: restoring
  // deletes them. Phrase every line as what the restore will do, not as a diff.
  if (diff.added.length > 0) {
    lines.push({
      key: 'removed',
      text: t('editor.checkpoints.removed', { count: diff.added.length }),
      danger: true
    })
  }
  if (diff.removed.length > 0) {
    lines.push({
      key: 'added',
      text: t('editor.checkpoints.added', { count: diff.removed.length })
    })
  }
  if (diff.changed.length > 0) {
    lines.push({
      key: 'changed',
      text: t('editor.checkpoints.changed', { count: diff.changed.length })
    })
  }
  const edgeCount = diff.edgesAdded.length + diff.edgesRemoved.length
  if (edgeCount > 0) {
    lines.push({ key: 'edges', text: t('editor.checkpoints.edges', { count: edgeCount }) })
  }
  if (diff.selectionChanged.length > 0) {
    lines.push({
      key: 'selections',
      text: t('editor.checkpoints.selections', { count: diff.selectionChanged.length })
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island w-full max-w-md px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-neutral-100">
          {t('editor.checkpoints.diffTitle', { name: diff.name })}
        </h2>
        {diff.identical ? (
          <p className="mt-3 text-xs text-neutral-400">{t('editor.checkpoints.identical')}</p>
        ) : (
          <ul className="mt-3 space-y-1 text-xs">
            {lines.map((line) => (
              <li key={line.key} className={line.danger ? 'text-danger' : 'text-neutral-300'}>
                • {line.text}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || diff.identical} onClick={onConfirm} autoFocus>
            {t('editor.checkpoints.restoreConfirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
