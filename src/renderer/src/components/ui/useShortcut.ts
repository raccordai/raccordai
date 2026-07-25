import { useEffect, useRef } from 'react'
import {
  SHORTCUTS,
  formatShortcut,
  isMacPlatform,
  isTypingTarget,
  matchesShortcut,
  type Shortcut,
  type ShortcutId
} from '@renderer/lib/shortcuts'

/** Resolved once — the renderer never moves between platforms mid-session. */
export const IS_MAC = isMacPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent)

/** "⌘O" / "Ctrl+O" for a registered action, ready to render in a menu. */
export function shortcutLabel(id: ShortcutId): string {
  return formatShortcut(SHORTCUTS[id], IS_MAC)
}

/**
 * Binds one registered shortcut for as long as the caller is mounted. The
 * handler is kept in a ref so callers don't have to memoize it — the listener
 * is attached once per (id, enabled) instead of on every render.
 *
 * Keystrokes aimed at a text field are ignored unless `allowWhileTyping`.
 */
export function useShortcut(
  id: ShortcutId,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; allowWhileTyping?: boolean } = {}
): void {
  const { enabled = true, allowWhileTyping = false } = options
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    const shortcut: Shortcut = SHORTCUTS[id]
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesShortcut(event, shortcut, IS_MAC)) return
      if (!allowWhileTyping && isTypingTarget(event.target)) return
      event.preventDefault()
      handlerRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [id, enabled, allowWhileTyping])
}
