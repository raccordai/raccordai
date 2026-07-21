import { Pencil, Trash2, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { VideoThumb } from '@renderer/components/VideoThumb'

/**
 * One card of the project/video libraries: 16:9 thumbnail (image, muted video
 * frame, or placeholder icon), name with inline rename, meta line, and
 * hover-revealed rename/delete actions.
 */
export function LibraryCard({
  name,
  meta,
  thumbnailUrl,
  thumbnailKind,
  placeholderIcon: PlaceholderIcon,
  onOpen,
  onRename,
  onDelete,
  renameTitle,
  deleteTitle
}: {
  name: string
  meta: string
  thumbnailUrl: string | null
  thumbnailKind: 'image' | 'video' | 'audio' | null
  placeholderIcon: LucideIcon
  onOpen?: () => void
  onRename: (name: string) => void
  onDelete: () => void
  renameTitle: string
  deleteTitle: string
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  function commitRename(): void {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) onRename(trimmed)
  }

  return (
    <div
      className={`group island relative overflow-hidden transition-colors hover:border-neutral-600 ${onOpen ? 'cursor-pointer' : ''}`}
      onClick={() => {
        if (!editing) onOpen?.()
      }}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-neutral-900">
        {thumbnailUrl ? (
          thumbnailKind === 'video' ? (
            <VideoThumb
              src={thumbnailUrl}
              className="pointer-events-none h-full w-full object-cover"
            />
          ) : (
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <PlaceholderIcon className="h-8 w-8 text-neutral-700" />
          </div>
        )}
        {/* z-10: must paint above the thumbnail <video>, lifted to z-index 1 by
            the .island video backdrop-filter workaround in styles.css */}
        <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setDraft(name)
              setEditing(true)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-neutral-300 backdrop-blur hover:text-neutral-100"
            title={renameTitle}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-neutral-300 backdrop-blur hover:text-danger"
            title={deleteTitle}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-3 pt-2.5 pb-3">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full rounded border border-accent bg-neutral-900 px-1.5 py-0.5 text-sm text-neutral-100 focus:outline-none"
          />
        ) : (
          <div className="truncate text-sm font-medium text-neutral-100">{name}</div>
        )}
        <div className="mt-0.5 truncate text-xs text-neutral-500">{meta}</div>
      </div>
    </div>
  )
}
