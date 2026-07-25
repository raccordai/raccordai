/**
 * Trigger-token detection for inline autocompletes (the assistant's "/" action
 * menu and "@" mentions, the node prompt editor's "@" alias menu). Pure —
 * shared by every host and unit-tested.
 */

export interface MentionTrigger {
  char: string
  /** Only fires when the trigger is the very first character of the value. */
  startOnly?: boolean
}

export interface MentionToken {
  char: string
  /** Index of the trigger character in the value. */
  start: number
  /** Text typed between the trigger and the caret (the filter query). */
  query: string
}

/** Queries longer than this stop tracking — the user is just writing prose. */
const MAX_QUERY_LENGTH = 40

/**
 * Finds the trigger token the caret is currently inside, or null. A trigger
 * only counts at the start of the value or after whitespace, and the query
 * stops at the first newline (spaces are allowed — names contain them).
 */
export function detectMentionToken(
  value: string,
  caret: number,
  triggers: MentionTrigger[]
): MentionToken | null {
  const upTo = value.slice(0, caret)
  for (let i = caret - 1; i >= 0; i--) {
    const ch = upTo[i] as string
    if (ch === '\n') return null
    const trigger = triggers.find((t) => t.char === ch)
    if (!trigger) continue
    if (trigger.startOnly && i !== 0) continue
    if (i > 0 && !/\s/.test(upTo[i - 1] as string)) continue
    const query = upTo.slice(i + 1)
    if (query.length > MAX_QUERY_LENGTH) return null
    return { char: trigger.char, start: i, query }
  }
  return null
}

/**
 * Replaces the active token (trigger included, up to the caret) with `insert`
 * plus a trailing space. Returns the new value and caret position.
 */
export function applyMention(
  value: string,
  token: MentionToken,
  caret: number,
  insert: string
): { value: string; caret: number } {
  const text = insert.endsWith(' ') ? insert : `${insert} `
  const next = value.slice(0, token.start) + text + value.slice(caret)
  return { value: next, caret: token.start + text.length }
}

/** Lowercase + strip accents, so "réf" matches "Reference". */
export function normalizeMentionQuery(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}
