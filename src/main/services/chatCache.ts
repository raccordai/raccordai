import type Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic prompt-cache breakpoints for the assistant loop (Claude proxy path
 * only — the OpenAI-Responses translator has no equivalent field). Three
 * breakpoints: tools (via the last tool), system, and the last block of the
 * last message. The provider reuses the longest previously-cached prefix, so
 * each iteration of the agentic loop pays only for what the previous one
 * appended instead of re-reading ~60 tool schemas + the SYSTEM prompt + the
 * whole history every time.
 *
 * Everything here is non-destructive: the session history is persisted and
 * replayed, so cache markers must never leak into it.
 */

const EPHEMERAL = { type: 'ephemeral' } as const

/** Block types the API accepts `cache_control` on (thinking blocks are not). */
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document'])

/** The system prompt as a single cached text block. */
export function cacheableSystem(system: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }]
}

/** Marks the last tool — one breakpoint covers the whole definitions array. */
export function cacheableTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  const last = tools.at(-1)
  if (!last) return tools
  return [...tools.slice(0, -1), { ...last, cache_control: EPHEMERAL }]
}

/**
 * Marks the last content block of the last message, so the next call in the
 * loop starts from a cached conversation instead of a cold one. A string
 * message becomes an equivalent single text block; a last block that cannot
 * carry the marker (thinking) leaves the messages untouched.
 */
export function cacheableMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const lastMessage = messages.at(-1)
  if (!lastMessage) return messages
  if (typeof lastMessage.content === 'string') {
    return [
      ...messages.slice(0, -1),
      {
        ...lastMessage,
        content: [{ type: 'text', text: lastMessage.content, cache_control: EPHEMERAL }]
      }
    ]
  }
  const lastBlock = lastMessage.content.at(-1)
  if (!lastBlock || !CACHEABLE_BLOCK_TYPES.has(lastBlock.type)) return messages
  return [
    ...messages.slice(0, -1),
    {
      ...lastMessage,
      content: [
        ...lastMessage.content.slice(0, -1),
        { ...lastBlock, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam
      ]
    }
  ]
}
