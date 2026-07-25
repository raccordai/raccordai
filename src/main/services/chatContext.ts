import type { AppContext } from '@shared/ipc/contracts'

/**
 * Renders the per-turn app-context snapshot (§4.10 phase 2) as the
 * <app-context> block prepended to the user message sent to the model. Pure —
 * unit-tested and in coverage.include. Returns null when there is nothing to
 * say (no block is injected; the message goes out exactly as the user wrote it).
 *
 * The block is persisted as-sent in the Anthropic history (deterministic
 * replays: it was true at that turn) but never shown in the transcript.
 */
export function formatAppContext(context: AppContext | undefined): string | null {
  if (!context) return null
  const lines: string[] = []
  if (context.route) lines.push(`route: ${context.route}`)
  if (context.projectId) lines.push(`projectId: ${context.projectId}`)
  if (context.videoId) lines.push(`videoId: ${context.videoId}`)
  if (context.selectedNodeId) lines.push(`selectedNodeId: ${context.selectedNodeId}`)
  if (context.selectedGenerationId) {
    lines.push(`selectedGenerationId: ${context.selectedGenerationId}`)
  }
  if (context.lastError) lines.push(`lastGenerationError: ${context.lastError}`)
  if (lines.length === 0) return null
  return `<app-context>\nWhat the user is looking at right now (snapshot injected by the app, not written by the user):\n${lines.join('\n')}\n</app-context>`
}
