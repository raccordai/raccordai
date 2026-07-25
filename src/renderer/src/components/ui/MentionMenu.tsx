import { useEffect, useState } from 'react'
import {
  applyMention,
  detectMentionToken,
  normalizeMentionQuery,
  type MentionToken,
  type MentionTrigger
} from '@renderer/lib/mentionToken'

// Inline autocomplete shared by the assistant input ("/" actions, "@"
// projects/references) and the node prompt editor ("@" input aliases): the
// host tracks value+caret, the hook detects the token/filters/handles keys,
// the component renders the popover (positioned by the host).

export interface MentionItem {
  id: string
  /** Primary line, also what the filter matches (with `description`). */
  label: string
  /** Text that replaces the trigger token when picked. */
  insert: string
  description?: string
  /** Section header shown above the first item of each section. */
  section?: string
  icon?: React.ReactNode
}

export function useMentionMenu({
  value,
  caret,
  triggers,
  itemsFor
}: {
  value: string
  caret: number
  triggers: MentionTrigger[]
  /** Full candidate list for a trigger — the hook applies the query filter. */
  itemsFor: (token: MentionToken) => MentionItem[]
}) {
  const [active, setActive] = useState(0)
  /** Set when the user pressed Escape on this very token. */
  const [dismissed, setDismissed] = useState<string | null>(null)

  const token = detectMentionToken(value, caret, triggers)
  const tokenKey = token ? `${token.char}:${token.start}` : null
  const query = normalizeMentionQuery(token?.query.trim() ?? '')
  const items = token
    ? itemsFor(token).filter(
        (item) =>
          query === '' ||
          normalizeMentionQuery(`${item.label} ${item.description ?? ''}`).includes(query)
      )
    : []
  const open = token !== null && items.length > 0 && dismissed !== tokenKey

  // Reset the highlight when the token or the hit list changes shape.
  useEffect(() => {
    setActive(0)
  }, [tokenKey, items.length])

  /** Returns the replacement to apply, or null when the menu is closed. */
  function select(item: MentionItem): { value: string; caret: number } | null {
    if (!token) return null
    return applyMention(value, token, caret, item.insert)
  }

  /** Host keydown hook — returns true when the event was consumed. */
  function onKeyDown(
    e: React.KeyboardEvent,
    apply: (r: { value: string; caret: number }) => void
  ): boolean {
    if (!open) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(items.length - 1, a + 1))
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const item = items[active]
      if (!item) return false
      e.preventDefault()
      const result = select(item)
      if (result) apply(result)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDismissed(tokenKey)
      return true
    }
    return false
  }

  return { open, items, active, setActive, select, onKeyDown }
}

/** The popover list — the host wraps it in an absolutely-positioned container. */
export function MentionMenu({
  items,
  active,
  onHover,
  onPick
}: {
  items: MentionItem[]
  active: number
  onHover: (index: number) => void
  onPick: (item: MentionItem) => void
}): React.JSX.Element {
  return (
    <div className="max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
      {items.map((item, i) => (
        <div key={item.id}>
          {item.section !== undefined && item.section !== items[i - 1]?.section && (
            <div
              className={`px-3 pb-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase ${
                i > 0 ? 'mt-1 border-t border-neutral-800 pt-1.5' : 'pt-1'
              }`}
            >
              {item.section}
            </div>
          )}
          <button
            // Mousedown so the pick lands before the textarea's blur.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item)
            }}
            onMouseEnter={() => onHover(i)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
              i === active ? 'bg-neutral-800' : ''
            }`}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-neutral-100">{item.label}</span>
              {item.description && (
                <span className="block truncate text-[10px] leading-snug text-neutral-500">
                  {item.description}
                </span>
              )}
            </span>
          </button>
        </div>
      ))}
    </div>
  )
}
