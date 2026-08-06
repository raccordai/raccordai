import type { AppContext, Niche, NicheRoadmapItem, VoicePersona } from '@shared/ipc/contracts'

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
  if (context.nicheId) lines.push(`nicheId: ${context.nicheId}`)
  if (context.lastError) lines.push(`lastGenerationError: ${context.lastError}`)
  if (lines.length === 0) return null
  return `<app-context>\nWhat the user is looking at right now (snapshot injected by the app, not written by the user):\n${lines.join('\n')}\n</app-context>`
}

/**
 * The NICHE CONTEXT block appended to the per-video system prompt when the
 * video was created from a niche roadmap item (§7b) — the lossless bridge:
 * angle, evidence, packaging, production profile and channel voices reach the
 * assistant without anyone having to remember to repeat them. Pure — chat.ts
 * fetches the data, this renders it.
 */
export function formatRoadmapContext(context: {
  niche: Niche
  item: NicheRoadmapItem
  voicePersonas: VoicePersona[]
}): string {
  const { niche, item, voicePersonas } = context
  const lines: string[] = [
    `Niche: ${niche.name}`,
    ...(niche.description ? [`Positioning brief: ${niche.description}`] : []),
    `Production profile: ${[
      niche.styleId ? `style ${niche.styleId}` : null,
      item.videoType === 'short'
        ? 'aspect 9:16 (short)'
        : niche.aspectRatio
          ? `aspect ${niche.aspectRatio}`
          : null,
      niche.targetSeconds
        ? `target length ${niche.targetSeconds}s — pass it to write_scenario`
        : null
    ]
      .filter(Boolean)
      .join(', ')}`,
    `Roadmap item: "${item.title}" (${item.videoType}, status ${item.status})`,
    ...(item.titleVariants?.length ? [`Title variants: ${item.titleVariants.join(' | ')}`] : []),
    ...(item.angle ? [`Angle: ${item.angle}`] : []),
    ...(item.evidence ? [`Evidence (the tracked videos proving demand): ${item.evidence}`] : []),
    ...(item.description ? [`YouTube description draft: ${item.description}`] : []),
    ...(item.thumbnailBrief ? [`Thumbnail brief: ${item.thumbnailBrief}`] : []),
    ...(voicePersonas.length > 0
      ? [
          `Channel voices (reuse them for narration/dialogue): ${voicePersonas
            .map((p) => `${p.name} = ${p.voiceId}${p.description ? ` (${p.description})` : ''}`)
            .join('; ')}`
        ]
      : [])
  ]
  return `NICHE CONTEXT — this video was created from a niche roadmap item; respect it without being asked (ground the scenario in the angle and evidence, keep the thumbnail on-brief, reuse the channel voices):\n${lines.join('\n')}`
}
