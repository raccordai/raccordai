import type Anthropic from '@anthropic-ai/sdk'
import type { ResponsesOutputItem } from './chatOpenAIFormat'

/**
 * SSE streaming for the assistant (§4.10 phase 6) — pure parsing/accumulation,
 * unit-tested and in coverage.include. The chat service owns the network read;
 * everything below turns raw SSE text into the SAME final message shapes the
 * non-streaming paths produce, surfacing text deltas along the way for the
 * sidebar's incremental display.
 */

/** Splits an SSE byte stream into `data:` payload strings (multi-line aware). */
export class SseParser {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const events: string[] = []
    let index: number
    while ((index = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      const data = extractData(raw)
      if (data) events.push(data)
    }
    return events
  }

  /** Trailing event without a final blank line (stream ended). */
  flush(): string[] {
    const data = extractData(this.buffer)
    this.buffer = ''
    return data ? [data] : []
  }
}

function extractData(rawEvent: string): string | null {
  const data = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
  return data === '' ? null : data
}

// ── Anthropic Messages stream ────────────────────────────────────────────────

export interface StreamedMessage {
  content: Anthropic.ContentBlock[]
  stop_reason: string | null
  error?: { type?: string; message?: string }
}

/**
 * Accumulates Anthropic stream events (message_start / content_block_* /
 * message_delta / error) back into a complete message. Feed each parsed
 * `data:` JSON to push(); read the result with finish().
 */
export function createAnthropicAccumulator(onTextDelta?: (delta: string) => void): {
  push(event: unknown): void
  finish(): StreamedMessage
} {
  const blocks: Anthropic.ContentBlock[] = []
  const partialJson: Record<number, string> = {}
  // A stream that dies early is indistinguishable from a finished one at the
  // network level (the body just ends), so the accumulator has to notice: no
  // block at all, or a block still open when the events run out. Without this
  // the caller got a well-formed EMPTY message and the agentic loop treated it
  // as "the model has nothing more to say" — the turn stopped dead, silently.
  const openBlocks = new Set<number>()
  let events = 0
  let stopReason: string | null = null
  let error: StreamedMessage['error']

  return {
    push(raw: unknown): void {
      events += 1
      const event = raw as {
        type?: string
        index?: number
        content_block?: Anthropic.ContentBlock
        delta?: {
          type?: string
          text?: string
          partial_json?: string
          stop_reason?: string
        }
        error?: { type?: string; message?: string }
      }
      switch (event.type) {
        case 'content_block_start': {
          if (event.content_block && event.index !== undefined) {
            blocks[event.index] = { ...event.content_block }
            openBlocks.add(event.index)
            if (event.content_block.type === 'tool_use') partialJson[event.index] = ''
          }
          break
        }
        case 'content_block_delta': {
          const index = event.index ?? -1
          const block = blocks[index]
          if (!block || !event.delta) break
          if (event.delta.type === 'text_delta' && block.type === 'text') {
            block.text += event.delta.text ?? ''
            if (event.delta.text) onTextDelta?.(event.delta.text)
          } else if (event.delta.type === 'input_json_delta' && block.type === 'tool_use') {
            partialJson[index] = (partialJson[index] ?? '') + (event.delta.partial_json ?? '')
          }
          break
        }
        case 'content_block_stop': {
          const index = event.index ?? -1
          openBlocks.delete(index)
          const block = blocks[index]
          if (block?.type === 'tool_use' && partialJson[index] !== undefined) {
            try {
              block.input = partialJson[index] === '' ? {} : JSON.parse(partialJson[index]!)
            } catch {
              block.input = {}
            }
          }
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
          break
        }
        case 'error': {
          error = event.error ?? { message: 'stream error' }
          break
        }
      }
    },
    finish(): StreamedMessage {
      const content = blocks.filter((b): b is Anthropic.ContentBlock => b !== undefined)
      if (!error && content.length === 0) {
        error = {
          type: 'empty_stream',
          message: `closed the stream without sending any content (${events} event${events === 1 ? '' : 's'} received)`
        }
      } else if (!error && openBlocks.size > 0) {
        error = {
          type: 'truncated_stream',
          message: `closed the stream mid-message (${events} events, ${openBlocks.size} unterminated content block${openBlocks.size === 1 ? '' : 's'})`
        }
      }
      return {
        content,
        stop_reason: stopReason,
        ...(error ? { error } : {})
      }
    }
  }
}

// ── OpenAI Responses stream ──────────────────────────────────────────────────

/**
 * Accumulates OpenAI Responses stream events. Text deltas surface via the
 * callback; the terminal `response.completed` event carries the full output
 * array — the same shape the non-streaming path feeds to fromResponsesOutput.
 */
export function createResponsesAccumulator(onTextDelta?: (delta: string) => void): {
  push(event: unknown): void
  finish(): { output?: ResponsesOutputItem[]; error?: { message?: string } }
} {
  let output: ResponsesOutputItem[] | undefined
  let error: { message?: string } | undefined
  let events = 0

  return {
    push(raw: unknown): void {
      events += 1
      const event = raw as {
        type?: string
        delta?: string
        response?: { output?: ResponsesOutputItem[]; error?: { message?: string } }
        error?: { message?: string }
        message?: string
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        if (event.delta) onTextDelta?.(event.delta)
      } else if (event.type === 'response.completed') {
        output = event.response?.output
      } else if (event.type === 'response.failed') {
        error = event.response?.error ?? { message: 'response failed' }
      } else if (event.type === 'error') {
        error = event.error ?? { message: event.message ?? 'stream error' }
      }
    },
    finish() {
      // Same trap as the Anthropic path: no terminal response.completed means
      // the stream died, not that the model answered nothing.
      if (!error && !output) {
        error = {
          message: `closed the stream without a completed response (${events} event${events === 1 ? '' : 's'} received)`
        }
      }
      return { ...(output ? { output } : {}), ...(error ? { error } : {}) }
    }
  }
}

// ── Retry policy ─────────────────────────────────────────────────────────────

/**
 * Is this provider failure worth another attempt? A dropped/empty stream, a
 * network blip, a 429 or a 5xx are transient — the proxy hiccups and the same
 * request succeeds a second later. An auth/quota/validation refusal (4xx) is
 * not: retrying it just burns the user's time behind a spinner.
 */
export function isRetryableProviderError(message: string): boolean {
  const text = message.toLowerCase()
  if (/http (4\d\d)\b/.test(text) && !/http 429\b/.test(text)) return false
  return (
    text.includes('stream') ||
    text.includes('empty') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('stopped responding') ||
    text.includes('fetch failed') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('socket hang up') ||
    text.includes('terminated') ||
    text.includes('network') ||
    /http (429|5\d\d)\b/.test(text)
  )
}
