import { MessageSquarePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTimecode } from '@shared/annotations'
import { invoke } from '../../../lib/ipc'
import { popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'

/**
 * Quick feedback note (§6.13) on the frame under the playhead: the timecode
 * and the node identity were frozen when the popover opened — the user only
 * types the comment. Lands in the feedback bucket (FeedbackPanel + the MCP
 * feedback tools).
 */
export function FeedbackNotePopover({
  videoId,
  note,
  onClose
}: {
  videoId: string
  note: {
    x: number
    y: number
    timecodeSec: number
    nodeId: string | null
    nodeLabel: string | null
  }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [comment, setComment] = useState('')

  const save = (): void => {
    const trimmed = comment.trim()
    if (!trimmed) return
    void invoke('feedback:create', {
      videoId,
      comment: trimmed,
      timecodeSec: note.timecodeSec,
      ...(note.nodeId ? { nodeId: note.nodeId } : {}),
      ...(note.nodeLabel ? { nodeLabel: note.nodeLabel } : {})
    })
    onClose()
  }

  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(note.x, 288, window.innerWidth), top: note.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <MessageSquarePlus className="h-3 w-3 text-accent" /> {t('timeline.addNoteTitle')}
        <span className="ml-auto font-mono font-normal text-neutral-400">
          {formatTimecode(note.timecodeSec)}
          {note.nodeLabel ? ` · ${note.nodeLabel}` : ''}
        </span>
      </div>
      <textarea
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') onClose()
        }}
        placeholder={t('timeline.notePlaceholder')}
        rows={2}
        className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-neutral-500">{t('timeline.noteHint')}</span>
        <button
          onClick={save}
          disabled={!comment.trim()}
          className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          {t('timeline.noteSave')}
        </button>
      </div>
    </div>
  )
}
