import type Anthropic from '@anthropic-ai/sdk'

/**
 * History compaction for the assistant (§4.10 phase 5) — pure split/strip/
 * reassembly helpers, unit-tested and in coverage.include. The chat service
 * performs the single summarization model call; everything decidable without
 * I/O lives here.
 *
 * Strategy: when the serialized Anthropic history grows past the thresholds,
 * the oldest ~two-thirds are summarized into one <conversation-summary> block
 * prefixed to the kept tail (the tail stays verbatim). Base64 image blocks
 * are stripped from the summarized span — attachments that matter were
 * promoted via save_attachment_as_asset, whose tool result (kept in the span)
 * names the asset key.
 */

export const COMPACTION_MESSAGE_THRESHOLD = 60
export const COMPACTION_BYTE_THRESHOLD = 300_000

export function needsCompaction(history: Anthropic.MessageParam[]): boolean {
  if (history.length > COMPACTION_MESSAGE_THRESHOLD) return true
  return JSON.stringify(history).length > COMPACTION_BYTE_THRESHOLD
}

/**
 * A message that can safely START the kept tail: a user turn that carries no
 * tool_result (a tool_result reply must stay next to its assistant tool_use,
 * which would otherwise be lost to the summary).
 */
function canStartTail(message: Anthropic.MessageParam): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content === 'string') return true
  return !message.content.some((block) => block.type === 'tool_result')
}

/**
 * Split point closest to the two-thirds mark whose tail starts with a plain
 * user turn. Prefers splitting later (smaller summary span is never wrong);
 * falls back to earlier; null when the history has no safe split.
 */
export function splitForCompaction(
  history: Anthropic.MessageParam[]
): { head: Anthropic.MessageParam[]; tail: Anthropic.MessageParam[] } | null {
  const target = Math.floor((history.length * 2) / 3)
  for (let i = target; i < history.length; i++) {
    if (canStartTail(history[i]!)) return { head: history.slice(0, i), tail: history.slice(i) }
  }
  for (let i = Math.min(target, history.length) - 1; i > 0; i--) {
    if (canStartTail(history[i]!)) return { head: history.slice(0, i), tail: history.slice(i) }
  }
  return null
}

const IMAGE_NOTE =
  '[image attachment removed for compaction — if it was saved to the library, its asset key appears in the save_attachment_as_asset result nearby]'

/** Replaces base64 image blocks with a textual note (summaries never carry pixels). */
export function stripImageBlocks(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    if (!message.content.some((block) => block.type === 'image')) return message
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === 'image' ? { type: 'text' as const, text: IMAGE_NOTE } : block
      )
    }
  })
}

/** Compact, model-readable rendering of the span to summarize. */
export function renderForSummary(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = []
  for (const message of messages) {
    lines.push(`## ${message.role}`)
    if (typeof message.content === 'string') {
      lines.push(message.content)
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text') lines.push(block.text)
      else if (block.type === 'tool_use') {
        lines.push(`[tool_use ${block.name} ${JSON.stringify(block.input ?? {})}]`)
      } else if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
        lines.push(`[tool_result${block.is_error ? ' ERROR' : ''} ${content}]`)
      }
      // Other block kinds (thinking, images already stripped) are dropped.
    }
  }
  return lines.join('\n')
}

export const SUMMARY_SYSTEM = `You compact an assistant conversation for context reuse. Summarize the transcript you receive into a dense brief the assistant can rely on later: the user's goals and constraints, decisions made, project/video/node/asset IDS with their names (ids are load-bearing — never drop one that is still referenced), what was built or generated (with credit costs when stated), current state and what remains open. Plain text, no preamble.`

/**
 * Summary + kept tail → new history. The block is PREFIXED to the tail's
 * first user message (never inserted as its own turn — the tail must keep
 * starting with a user turn without creating two consecutive user messages).
 */
export function reassembleHistory(
  summary: string,
  tail: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const block = `<conversation-summary>\nEarlier conversation, compacted by the app:\n${summary}\n</conversation-summary>`
  const [first, ...rest] = tail
  if (!first) return [{ role: 'user', content: block }]
  const content =
    typeof first.content === 'string'
      ? `${block}\n\n${first.content}`
      : [{ type: 'text' as const, text: block }, ...first.content]
  return [{ ...first, content }, ...rest]
}
