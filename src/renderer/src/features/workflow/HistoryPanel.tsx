import { AlertCircle, CheckCircle2, History, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getModel, type MediaKind } from '@shared/models'
import { relativeTime } from '@renderer/lib/relativeTime'
import { VideoThumb } from '@renderer/components/VideoThumb'
import { useGenerationHistory } from './data'

interface Props {
  videoId: string
  onClose: () => void
  /** Focus + select the node a generation belongs to (jump to it on the canvas). */
  onSelectNode: (nodeId: string) => void
}

type KindFilter = 'all' | MediaKind
const KIND_FILTERS: KindFilter[] = ['all', 'video', 'image', 'audio']
const FILTER_LABEL_KEYS = {
  all: 'editor.historyPanel.filter.all',
  video: 'editor.historyPanel.filter.video',
  image: 'editor.historyPanel.filter.image',
  audio: 'editor.historyPanel.filter.audio'
} as const

/**
 * The media kind of a history row: the model registry knows, and rows whose
 * model was removed (or replaced without an alias) fall back to the stored
 * result mime type — image being the safest default for a still-unknown row.
 */
function historyKindOf(row: { modelId: string; resultMimeType?: string | null }): MediaKind {
  const kind = getModel(row.modelId)?.kind
  if (kind === 'video' || kind === 'image' || kind === 'audio') return kind
  if (row.resultMimeType?.startsWith('video')) return 'video'
  if (row.resultMimeType?.startsWith('audio')) return 'audio'
  return 'image'
}

export function HistoryPanel({ videoId, onClose, onSelectNode }: Props) {
  const { t } = useTranslation()
  const history = useGenerationHistory(videoId).data
  const [filter, setFilter] = useState<KindFilter>('all')
  const filtered = useMemo(
    () => (filter === 'all' ? history : history?.filter((g) => historyKindOf(g) === filter)),
    [history, filter]
  )

  return (
    <aside className="island flex min-h-0 w-96 flex-1 flex-shrink-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <History className="h-4 w-4 text-accent" /> {t('editor.historyPanel.title')}
          {history && filtered && (
            <span className="text-xs font-normal text-neutral-500">
              ({filter === 'all' ? history.length : `${filtered.length}/${history.length}`})
            </span>
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

      {history && history.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-neutral-800 px-3 py-2">
          {KIND_FILTERS.map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                filter === key
                  ? 'bg-accent font-medium text-neutral-900'
                  : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t(FILTER_LABEL_KEYS[key])}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {history === undefined || filtered === undefined ? (
          <div className="p-2 text-xs text-neutral-500">{t('editor.historyPanel.loading')}</div>
        ) : history.length === 0 ? (
          <div className="p-2 text-xs italic text-neutral-500">
            {t('editor.historyPanel.empty')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-2 text-xs italic text-neutral-500">
            {t('editor.historyPanel.noMatch')}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {filtered.map((g) => {
              const model = getModel(g.modelId)
              const isVideo = historyKindOf(g) === 'video'
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
                          <VideoThumb src={g.url} className="h-full w-full object-cover" />
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
