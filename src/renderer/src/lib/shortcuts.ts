/**
 * Keyboard shortcuts — the single definition of every binding in the app, plus
 * the pure helpers that match and render them.
 *
 * Before this, bindings lived in eight separate `addEventListener` blocks with
 * no shared vocabulary, three copies of the same "is the user typing?" guard,
 * and nothing to show the user which key does what. Menu entries now carry
 * their binding (`MenuEntry.shortcut`) and render it on the right.
 *
 * `mod` is ⌘ on macOS and Ctrl everywhere else — the platform is passed in so
 * these stay pure and testable.
 */

export interface Shortcut {
  /** `event.key`, compared case-insensitively ('o', 'Enter', ' ', 'ArrowUp'). */
  key: string
  /** ⌘ on macOS, Ctrl elsewhere. */
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

/**
 * Every bound action. Keep conflicting pairs on different scopes: ⌘N creates a
 * project (home route only) while ⇧⌘N opens a chat (global), so they never
 * compete for the same keystroke on the same screen.
 */
export const SHORTCUTS = {
  /** Global */
  toggleAssistant: { key: 'j', mod: true },
  newChat: { key: 'n', mod: true, shift: true },
  openSettings: { key: ',', mod: true },
  /** Home */
  newProject: { key: 'n', mod: true },
  /** Workflow editor */
  undo: { key: 'z', mod: true },
  redo: { key: 'z', mod: true, shift: true },
  copyNodes: { key: 'c', mod: true },
  pasteNodes: { key: 'v', mod: true },
  importWorkflow: { key: 'o', mod: true },
  exportWorkflow: { key: 'e', mod: true },
  tidy: { key: 'l', mod: true },
  toggleHistory: { key: 'y', mod: true },
  toggleTimeline: { key: 't', mod: true },
  playPause: { key: ' ' }
} as const satisfies Record<string, Shortcut>

export type ShortcutId = keyof typeof SHORTCUTS

/** The subset of a KeyboardEvent that matching needs (keeps tests trivial). */
export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Does this event fire the shortcut? Modifiers must match EXACTLY — a shortcut
 * without `shift` is not triggered by adding Shift, otherwise ⇧⌘Z (redo) would
 * also fire ⌘Z (undo).
 */
export function matchesShortcut(event: KeyEventLike, shortcut: Shortcut, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  // The non-mod modifier must be off too: on macOS Ctrl+O must not fire ⌘O.
  const otherMod = isMac ? event.ctrlKey : event.metaKey
  return (
    mod === Boolean(shortcut.mod) &&
    !otherMod &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.altKey === Boolean(shortcut.alt)
  )
}

/** Symbols for the keys whose `event.key` name would read badly in a menu. */
const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  delete: '⌦'
}

/** "⌘O" on macOS, "Ctrl+O" elsewhere — for display next to a menu entry. */
export function formatShortcut(shortcut: Shortcut, isMac: boolean): string {
  const label = KEY_LABELS[shortcut.key.toLowerCase()] ?? shortcut.key.toUpperCase()
  const parts: string[] = []
  if (isMac) {
    // Apple's canonical order: ⌃ ⌥ ⇧ ⌘, no separator.
    if (shortcut.alt) parts.push('⌥')
    if (shortcut.shift) parts.push('⇧')
    if (shortcut.mod) parts.push('⌘')
    return `${parts.join('')}${label}`
  }
  if (shortcut.mod) parts.push('Ctrl')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.alt) parts.push('Alt')
  parts.push(label)
  return parts.join('+')
}

/**
 * Is the user typing? Shortcuts must not steal keystrokes from a text field —
 * this guard was copy-pasted in three components with slightly different rules.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  const tag = element.tagName.toUpperCase()
  // `isContentEditable` is absent on non-elements, so coerce — the declared
  // return type is boolean and callers negate it.
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
  )
}

/** True on macOS — decides ⌘ vs Ctrl and the label format. */
export function isMacPlatform(userAgent: string): boolean {
  return /mac/i.test(userAgent)
}
