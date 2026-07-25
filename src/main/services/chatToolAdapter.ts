import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTool } from '../mcp/registry'

/**
 * Chat-side adapter over the agent-tool registry (§4.10 phase 3). Pure —
 * unit-tested and in coverage.include; the MCP server publishes the registry
 * unchanged, only the embedded assistant goes through here.
 *
 * Two responsibilities:
 *  - `toAnthropicTools`: shape registry entries for a chat session. A
 *    video-bound session drops the explicit videoId/projectId params (the
 *    executor injects the session's own ids); the global (home) session keeps
 *    them required. Destructive tools additionally gain a `confirm` flag.
 *  - `approvalGate`: the deterministic destructive-approval protocol — a
 *    destructive call without `confirm: true` must NOT execute; the chat
 *    renders an action card instead and the model re-calls with confirm once
 *    the user approves.
 */

interface JsonObjectSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/** Description of the confirm flag added to destructive tools (chat only). */
const CONFIRM_PROPERTY = {
  type: 'boolean',
  description:
    'Destructive action — omit on the first call (the user gets an approval card); set true ONLY after the user approved.'
}

/**
 * Same flag for spending tools. Always declared, never conditioned on the
 * current setting: the session's tool list is built once at module load, so a
 * schema that depended on the setting would need an app restart to change.
 * `approvalGate` is what actually decides, per call.
 */
const SPENDING_CONFIRM_PROPERTY = {
  type: 'boolean',
  description:
    'Costs credits — when the app requires approval, omit on the first call (the user gets a card showing the estimated cost) and set true ONLY after they approved.'
}

function withoutProperty(schema: JsonObjectSchema, property: string): JsonObjectSchema {
  const { [property]: _dropped, ...properties } = schema.properties ?? {}
  return {
    ...schema,
    properties,
    required: (schema.required ?? []).filter((key) => key !== property)
  }
}

/**
 * Registry tools → Anthropic tool definitions for one chat session.
 * `bound` = the session is attached to one video (per-video threads): its
 * video/project ids are implicit. The global thread keeps explicit ids.
 */
export function toAnthropicTools(tools: AgentTool[], bound: boolean): Anthropic.Tool[] {
  return tools.map((tool) => {
    let schema = { ...(tool.inputSchema as JsonObjectSchema) }
    if (bound) {
      if (tool.scope === 'video') schema = withoutProperty(schema, 'videoId')
      if (tool.scope === 'project') schema = withoutProperty(schema, 'projectId')
    }
    if (tool.risk === 'destructive' || tool.risk === 'spending') {
      schema = {
        ...schema,
        properties: {
          ...(schema.properties ?? {}),
          confirm: tool.risk === 'destructive' ? CONFIRM_PROPERTY : SPENDING_CONFIRM_PROPERTY
        }
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema as Anthropic.Tool['input_schema']
    }
  })
}

/**
 * Injects the session's ids into a tool call from a video-bound session —
 * explicit ids passed by the model win (the registry stays usable on other
 * videos of the project, e.g. after open_video).
 */
export function injectBindingIds(
  tool: Pick<AgentTool, 'scope'>,
  args: Record<string, unknown>,
  binding: { videoId: string; projectId: string } | null
): Record<string, unknown> {
  if (!binding) return args
  const injected = { ...args }
  if (tool.scope === 'video' && !injected['videoId']) injected['videoId'] = binding.videoId
  if (tool.scope === 'project' && !injected['projectId']) injected['projectId'] = binding.projectId
  return injected
}

/** What the caller currently requires approval for (read per call, never cached). */
export interface ApprovalPolicy {
  /** true when the user asked to approve every run that costs credits. */
  requireSpendingApproval: boolean
}

/**
 * Approval protocol. Returns `approved: false` when the call must NOT execute
 * (an action card is shown instead); otherwise the args with the chat-only
 * `confirm` flag stripped, so the registry never sees it.
 *
 * Destructive tools are always gated. Spending tools are gated only when the
 * policy says so — the `assistantRunApproval` setting, so the user decides
 * whether the assistant may launch generations on its own.
 */
export function approvalGate(
  tool: Pick<AgentTool, 'risk'>,
  args: Record<string, unknown>,
  policy: ApprovalPolicy = { requireSpendingApproval: false }
): { approved: boolean; args: Record<string, unknown> } {
  const gated =
    tool.risk === 'destructive' || (tool.risk === 'spending' && policy.requireSpendingApproval)
  // The flag is stripped even when the tool isn't gated: a model that sends it
  // anyway must not leak it into the registry's validated args.
  const { confirm, ...rest } = args
  if (!gated) return { approved: true, args: rest }
  return { approved: confirm === true, args: rest }
}

/** Tool result sent back to the model when approval is required. */
export const APPROVAL_REQUIRED_RESULT =
  'APPROVAL REQUIRED — nothing was executed. The user sees an action card with Approve / Request changes. End your turn and WAIT; if they approve, re-call this tool with the same arguments plus "confirm": true.'
