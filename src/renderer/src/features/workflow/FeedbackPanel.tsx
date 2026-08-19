import { Check, CheckCircle2, Circle, Copy, MessageSquareText, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '@shared/ipc/contracts'
import { formatTimecode } from '@shared/annotations'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import { useFeedback } from './data'

/** One note, formatted as a to-do line ready to paste anywhere. */
function feedbackLine(item: FeedbackItem): string {
  const anchor = [
    item.timecodeSec !== null ? formatTimecode(item.timecodeSec) : null,
    item.nodeLabel
  ]
    .filter(Boolean)
    .join(' · ')
  return `- [${item.status === 'done' ? 'x' : ' '}] ${anchor ? `[${anchor}] ` : ''}${item.comment}`
}

/**
 * The feedback bucket (§6.13): the notes taken while watching the timeline,
 * worked through here (mark done / delete) or by an agent via the MCP
 * feedback tools. "Copy" exports the whole list as a markdown to-do.
 */
export function FeedbackPanel({
  videoId,
  onClose,
  onFocusNode
}: {
  videoId: string
  onClose: () => void
  onFocusNode?: (nodeId: string) => void
}) {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const items = useFeedback(videoId).data
  const [copied, setCopied] = useState(false)
  const openCount = (items ?? []).filter((i) => i.status === 'open').length

  function copyAll(): void {
    if (!items || items.length === 0) return
    void navigator.clipboard.writeText(items.map(feedbackLine).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function remove(item: FeedbackItem): Promise<void> {
    const accepted = await confirmModal({
      message: t('editor.feedback.deleteConfirm'),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (accepted) await invoke('feedback:delete', { id: item.id })
  }

  return (
    <aside className="island flex w-96 flex-col overflow-hidden px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <MessageSquareText className="h-4 w-4 text-accent" /> {t('editor.feedback.title')}
          {items !== undefined && items.length > 0 && (
            <span className="font-normal text-neutral-500">
              {openCount}/{items.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={copyAll}
            disabled={!items || items.length === 0}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            title={t('editor.feedback.copyAll')}
          >
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items === undefined ? (
          <div className="text-xs text-neutral-500">{t('editor.historyPanel.loading')}</div>
        ) : items.length === 0 ? (
          <div className="text-xs italic text-neutral-500">{t('editor.feedback.empty')}</div>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5"
              >
                <div className="flex items-start gap-2">
                  <button
                    onClick={() =>
                      void invoke('feedback:update', {
                        id: item.id,
                        patch: { status: item.status === 'done' ? 'open' : 'done' }
                      })
                    }
                    className="mt-0.5 flex-shrink-0 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-success"
                    title={
                      item.status === 'done'
                        ? t('editor.feedback.markOpen')
                        : t('editor.feedback.markDone')
                    }
                  >
                    {item.status === 'done' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Circle className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    {(item.timecodeSec !== null || item.nodeLabel) && (
                      <div className="text-[10px] text-neutral-500">
                        {item.timecodeSec !== null && (
                          <span className="font-mono">{formatTimecode(item.timecodeSec)}</span>
                        )}
                        {item.timecodeSec !== null && item.nodeLabel && ' · '}
                        {item.nodeLabel &&
                          (item.nodeId && onFocusNode ? (
                            <button
                              onClick={() => onFocusNode(item.nodeId as string)}
                              className="text-accent-soft hover:underline"
                            >
                              {item.nodeLabel}
                            </button>
                          ) : (
                            item.nodeLabel
                          ))}
                      </div>
                    )}
                    <div
                      className={`whitespace-pre-wrap break-words text-xs ${
                        item.status === 'done'
                          ? 'text-neutral-500 line-through'
                          : 'text-neutral-200'
                      }`}
                    >
                      {item.comment}
                    </div>
                  </div>
                  <button
                    onClick={() => void remove(item)}
                    className="flex-shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
                    title={t('editor.feedback.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
