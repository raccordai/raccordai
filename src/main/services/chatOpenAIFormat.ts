import type Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic Messages ⇄ OpenAI Responses translation, so the assistant's
 * agentic loop (history, tools, transcript — all stored in Anthropic format)
 * can run on kie.ai's OpenAI-style proxies (GPT 5.6 Sol, GPT Codex) without
 * forking the loop. Pure functions — no network, no Electron.
 */

/** Anthropic tool definitions → Responses `tools` (function tools). */
export function toResponsesTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }))
}

/**
 * Anthropic message history → Responses `input` items. Thinking blocks are
 * dropped (provider-specific); tool_use/tool_result become
 * function_call/function_call_output pairs matched by call_id.
 */
export function toResponsesInput(messages: Anthropic.MessageParam[]): unknown[] {
  const items: unknown[] = []
  for (const message of messages) {
    // Sessions only ever hold user/assistant turns (system travels separately).
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    if (typeof message.content === 'string') {
      items.push(textItem(role, message.content))
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') {
        items.push(textItem(role, block.text))
      } else if (block.type === 'image' && block.source.type === 'base64') {
        items.push({
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: `data:${block.source.media_type};base64,${block.source.data}`
            }
          ]
        })
      } else if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        })
      } else if (block.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: toolResultOutput(block.content)
        })
      }
    }
  }
  return items
}

/**
 * Tool results may carry Anthropic vision blocks (get_generation_media). The
 * Responses API's function_call_output is text-only, so each image degrades to
 * an "[image]" note instead of a JSON.stringify of its base64 payload — which
 * would blow the context on every following turn.
 */
function toolResultOutput(content: Anthropic.ToolResultBlockParam['content'] | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}

function textItem(role: 'user' | 'assistant', text: string): unknown {
  return {
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
  }
}

export interface ResponsesOutputItem {
  type?: string
  content?: Array<{ type?: string; text?: string }>
  call_id?: string
  name?: string
  arguments?: string
}

/**
 * Responses `output` items → Anthropic content blocks + stop_reason, i.e. the
 * exact shape the agentic loop consumes from the Claude proxy.
 */
export function fromResponsesOutput(output: ResponsesOutputItem[] | undefined): {
  content: Anthropic.ContentBlock[]
  stop_reason: 'tool_use' | 'end_turn'
} {
  const content: Anthropic.ContentBlock[] = []
  for (const item of output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) {
          content.push({ type: 'text', text: c.text, citations: null } as Anthropic.ContentBlock)
        }
      }
    } else if (item.type === 'function_call' && item.call_id && item.name) {
      let input: unknown
      try {
        input = JSON.parse(item.arguments || '{}')
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input
      } as Anthropic.ContentBlock)
    }
  }
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  }
}
