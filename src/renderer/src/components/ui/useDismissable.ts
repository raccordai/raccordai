import { useEffect, type RefObject } from 'react'

/**
 * Standard dismissal for every menu, dropdown and popover: a pointerdown
 * outside the container closes it, so does Escape. Re-clicking the trigger is
 * the caller's job (`setOpen((v) => !v)`) — the trigger lives inside `ref`, so
 * this hook deliberately ignores clicks on it and lets the toggle win.
 *
 * Before this, two components hand-rolled these 15 lines and the rest used
 * `onBlur` + `setTimeout(150)`, which only fires when the click lands on
 * something focusable, or a `fixed inset-0` catcher div, which blocks the click
 * from reaching whatever it was aimed at.
 *
 * `pointerdown` rather than `click`: it fires before focus moves, so a popover
 * closes even when the press lands on a non-focusable element.
 */
export function useDismissable(
  open: boolean,
  close: () => void,
  ref: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent): void {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // Stop the Escape from also closing whatever is behind (a modal that
        // opened this popover, say) — innermost dismissable wins.
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    // Capture phase: React's own onKeyDown handlers (search inputs inside the
    // popover) would otherwise consume Escape before it reaches the document.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close, ref])
}
