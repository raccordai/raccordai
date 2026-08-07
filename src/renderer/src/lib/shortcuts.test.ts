import { describe, expect, it } from 'vitest'
import {
  SHORTCUTS,
  formatShortcut,
  isMacPlatform,
  isTypingTarget,
  matchesShortcut,
  type KeyEventLike,
  type Shortcut
} from './shortcuts'

function press(key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods }
}

describe('matchesShortcut', () => {
  it('matches ⌘ on macOS and Ctrl elsewhere', () => {
    const shortcut: Shortcut = { key: 'o', mod: true }
    expect(matchesShortcut(press('o', { metaKey: true }), shortcut, true)).toBe(true)
    expect(matchesShortcut(press('o', { ctrlKey: true }), shortcut, false)).toBe(true)
    // …and not the other way round.
    expect(matchesShortcut(press('o', { ctrlKey: true }), shortcut, true)).toBe(false)
    expect(matchesShortcut(press('o', { metaKey: true }), shortcut, false)).toBe(false)
  })

  it('is case-insensitive on the key', () => {
    expect(matchesShortcut(press('O', { metaKey: true }), { key: 'o', mod: true }, true)).toBe(true)
  })

  it('requires an exact modifier match, so ⇧⌘Z does not also fire ⌘Z', () => {
    const undo: Shortcut = { key: 'z', mod: true }
    const redo: Shortcut = { key: 'z', mod: true, shift: true }
    const event = press('z', { metaKey: true, shiftKey: true })

    expect(matchesShortcut(event, undo, true)).toBe(false)
    expect(matchesShortcut(event, redo, true)).toBe(true)
  })

  it('rejects a bare key when the shortcut wants a modifier, and vice versa', () => {
    expect(matchesShortcut(press('o'), { key: 'o', mod: true }, true)).toBe(false)
    expect(matchesShortcut(press(' ', { metaKey: true }), { key: ' ' }, true)).toBe(false)
    expect(matchesShortcut(press(' '), { key: ' ' }, true)).toBe(true)
  })

  it('rejects a stray Alt', () => {
    expect(
      matchesShortcut(press('o', { metaKey: true, altKey: true }), { key: 'o', mod: true }, true)
    ).toBe(false)
  })

  it('does not match a different key', () => {
    expect(matchesShortcut(press('p', { metaKey: true }), { key: 'o', mod: true }, true)).toBe(
      false
    )
  })

  it('ignores the synthetic keydowns Chromium fires without a key (datalist/autofill picks)', () => {
    const event = press('x')
    // Real events from a datalist pick carry `key: undefined` despite the type.
    ;(event as { key?: string }).key = undefined
    expect(matchesShortcut(event, { key: 'o', mod: true }, true)).toBe(false)
    expect(matchesShortcut(event, { key: 's' }, true)).toBe(false)
  })
})

describe('formatShortcut', () => {
  it('renders Apple symbols in the canonical order, no separator', () => {
    expect(formatShortcut({ key: 'o', mod: true }, true)).toBe('⌘O')
    expect(formatShortcut({ key: 'n', mod: true, shift: true }, true)).toBe('⇧⌘N')
    expect(formatShortcut({ key: 'z', mod: true, shift: true, alt: true }, true)).toBe('⌥⇧⌘Z')
  })

  it('renders the Windows/Linux form with +', () => {
    expect(formatShortcut({ key: 'o', mod: true }, false)).toBe('Ctrl+O')
    expect(formatShortcut({ key: 'n', mod: true, shift: true }, false)).toBe('Ctrl+Shift+N')
  })

  it('names the keys that would read badly as raw event.key values', () => {
    expect(formatShortcut({ key: ' ' }, true)).toBe('Space')
    expect(formatShortcut({ key: 'Enter' }, true)).toBe('↵')
    expect(formatShortcut({ key: 'Escape' }, false)).toBe('Esc')
    expect(formatShortcut({ key: 'ArrowUp' }, true)).toBe('↑')
  })
})

describe('isTypingTarget', () => {
  it('covers the fields a shortcut must not steal keystrokes from', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName: tag } as unknown as EventTarget)).toBe(true)
    }
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)
    ).toBe(true)
  })

  it('lets shortcuts through everywhere else', () => {
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    // window/document have no tagName and must not throw.
    expect(isTypingTarget({} as EventTarget)).toBe(false)
  })
})

describe('isMacPlatform', () => {
  it('detects macOS from the user agent', () => {
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
    expect(isMacPlatform('')).toBe(false)
  })
})

describe('SHORTCUTS registry', () => {
  it('binds no keystroke twice', () => {
    const seen = new Map<string, string>()
    // `as const` narrows each entry to its own literal shape, so the union has
    // no common optional members — widen back to Shortcut to read them.
    for (const [id, shortcut] of Object.entries(SHORTCUTS) as [string, Shortcut][]) {
      const combo = [
        shortcut.mod ? 'mod' : '',
        shortcut.shift ? 'shift' : '',
        shortcut.alt ? 'alt' : '',
        shortcut.key.toLowerCase()
      ].join('+')
      expect(seen.has(combo), `${id} collides with ${seen.get(combo)} on ${combo}`).toBe(false)
      seen.set(combo, id)
    }
  })

  it('keeps new-project and new-chat on distinct keystrokes', () => {
    // They live on different screens but the assistant is global, so ⌘N must
    // not fire both.
    const event = press('n', { metaKey: true })
    expect(matchesShortcut(event, SHORTCUTS.newProject, true)).toBe(true)
    expect(matchesShortcut(event, SHORTCUTS.newChat, true)).toBe(false)
  })
})
