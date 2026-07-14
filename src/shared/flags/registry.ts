import type { ReleaseChannel } from '../ipc/contracts'

export interface FlagDefinition {
  description: string
  /** Default state per release channel. Overrides (dev panel / SQLite) win over these. */
  defaults: Record<ReleaseChannel, boolean>
}

/**
 * Every feature flag ships in the binary with these defaults.
 * "Shadow" features: compiled in, off on stable, flippable per user via override.
 */
export const flagRegistry = {
  'local-api': {
    description: 'Local HTTP server (Hono) — foundation of the MCP server',
    defaults: { dev: true, beta: false, stable: false }
  },
  'assistant-chat': {
    description: 'Assistant (chat) panel in the editor — early-phase skeleton',
    defaults: { dev: true, beta: false, stable: false }
  },
  'timeline-v2': {
    description: 'Continuous NLE-style timeline (end-to-end playback, global scrubbing)',
    // Graduated to beta: stable playback/scrubbing in dev since phase 3.
    defaults: { dev: true, beta: true, stable: false }
  },
  'creative-templates': {
    description:
      'Style templates (video art direction) and workflow blueprints ("new video from template")',
    defaults: { dev: true, beta: false, stable: false }
  }
} as const satisfies Record<string, FlagDefinition>

export type FlagKey = keyof typeof flagRegistry

export const flagKeys = Object.keys(flagRegistry) as FlagKey[]

export function isFlagKey(key: string): key is FlagKey {
  return key in flagRegistry
}
