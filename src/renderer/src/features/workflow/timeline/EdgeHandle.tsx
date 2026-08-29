import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Edge-resize grip on a timeline block. `data-resize-handle` lets the block's
 * HTML5 drag (reorder) recognise and refuse a drag that started on a grip.
 */
export function EdgeHandle({
  side,
  onPointerDown,
  title
}: {
  side: 'left' | 'right'
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  title: string
}) {
  return (
    <div
      data-resize-handle
      onPointerDown={onPointerDown}
      title={title}
      className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-accent/60 opacity-0 group-hover:opacity-100 hover:bg-accent ${
        side === 'left' ? 'left-0 rounded-l-md' : 'right-0 rounded-r-md'
      }`}
    />
  )
}
