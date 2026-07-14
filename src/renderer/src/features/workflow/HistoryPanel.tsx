import { AlertCircle, CheckCircle2, History, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getModel } from '@shared/models'
import { relativeTime } from '@renderer/lib/relativeTime'
import { useGenerationHistory } from './data'

interface Props {
  videoId: string
  onClose: () => void
  /** Focus + select the node a generation belongs to (jump to it on the canvas). */
  onSelectNode: (nodeId: string) => void
}

export function HistoryPanel({ videoId, onClose, onSelectNode }: Props) {
  const { t } = useTranslation()
  const history = useGenerationHistory(videoId).data

  return (
    <aside className="island flex min-h-0 w-96 flex-1 flex-shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <History className="h-4 w-4 text-accent" /> {t('editor.historyPanel.title')}
          {history && (
            <span className="text-xs font-normal text-neutral-500">({history.length})</span>
          )}
        </h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800"
          title={t('editor.historyPanel.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {history === undefined ? (
          <div className="p-2 text-xs text-neutral-500">{t('editor.historyPanel.loading')}</div>
        ) : history.length === 0 ? (
          <div className="p-2 text-xs italic text-neutral-500">
            {t('editor.historyPanel.empty')}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {history.map((g) => {
              const model = getModel(g.modelId)
              const isVideo = g.resultMimeType?.startsWith('video') || model?.kind === 'video'
              return (
                <li key={g.id}>
                  <button
                    onClick={() => onSelectNode(g.nodeId)}
                    className={`flex w-full items-center gap-2 rounded-md border p-1.5 text-left transition hover:bg-neutral-900 ${
                      g.isSelected ? 'border-accent/60 bg-accent/5' : 'border-neutral-800'
                    }`}
                    title={t('editor.historyPanel.jumpToNode')}
                  >
                    {/* Thumbnail */}
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-neutral-900">
                      {g.status === 'success' && g.url ? (
                        isVideo ? (
                          <video
                            src={g.url}
                            muted
                            preload="metadata"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <img src={g.url} alt="" className="h-full w-full object-cover" />
                        )
                      ) : g.status === 'running' || g.status === 'pending' ? (
                        <Loader2 className="h-4 w-4 animate-spin text-warning" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-danger" />
                      )}
                    </div>

                    {/* Meta */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
                          {g.nodeExists
                            ? g.nodeLabel
                            : `${g.nodeLabel} (${t('editor.historyPanel.deleted')})`}
                        </span>
                        {g.isSelected && (
                          <span className="flex-shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] text-accent-soft">
                            {t('editor.historyPanel.active')}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[10px] text-neutral-500">
                        {model?.label ?? g.modelId}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-600">
                        <StatusBadge status={g.status} />
                        <span>· {relativeTime(t, g.createdAt)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}

function StatusBadge({ status }: { status: 'pending' | 'running' | 'success' | 'failed' }) {
  const { t } = useTranslation()
  if (status === 'success')
    return (
      <span className="flex items-center gap-0.5 text-success">
        <CheckCircle2 className="h-3 w-3" /> {t('editor.historyPanel.statusOk')}
      </span>
    )
  if (status === 'failed')
    return (
      <span className="flex items-center gap-0.5 text-danger">
        <AlertCircle className="h-3 w-3" /> {t('editor.historyPanel.statusFailed')}
      </span>
    )
  return (
    <span className="flex items-center gap-0.5 text-warning">
      <Loader2 className="h-3 w-3 animate-spin" /> {t('editor.historyPanel.statusRunning')}
    </span>
  )
}
