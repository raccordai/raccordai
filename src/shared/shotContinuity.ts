/**
 * Shot-to-shot continuity — the pure half.
 *
 * Two consecutive clips generated from the same sheets still read as two
 * unrelated films when nothing tells the model what the previous shot looked
 * like: a courier weaving through traffic, then a pursuer on a scooter shot in
 * another light, from the other side of the axis, at another time of day.
 *
 * The fix has two independent halves, and this module owns the wiring half:
 * the previous CLIP wired as an @Video reference. It is a REFERENCE, not a
 * frame anchor and not `lastFrame` chaining — the clip guides grade, wardrobe,
 * set and identity without its degraded closing frame being re-interpreted as
 * the next opening frame (see the CUT doctrine in `seedance2-prompting.ts`).
 *
 * The other half is written, not wired: every shot states the frame it OPENS
 * on and the frame it CLOSES on, and consecutive shots keep the same screen
 * direction (`TRANSITION_CONTRACT` below).
 *
 * Chaining has a real cost, so the plan is explicit about it: the batch
 * serializes (shot N cannot start before N-1 has settled) and the reference
 * handle has a combined-length budget (Seedance 2: 3 files, 15 s total), which
 * is why `planContinuityChain` skips links instead of silently overrunning.
 */

/** One shot of the chain, in timeline order. */
export interface ShotForChain {
  /** Opaque node id — this module never interprets it. */
  id: string
  /** Display name, quoted in the role sentence so the prompt reads naturally. */
  label: string
  /** Declared clip length (`params.duration`), when the model has one. */
  durationSeconds?: number
  /** Sources already wired to the target reference handle, before this plan. */
  existingRefs?: { count: number; seconds: number }
}

export interface ContinuityLink {
  sourceId: string
  targetId: string
  /** The alias the new connection will answer to, e.g. `@Video1`. */
  alias: string
  /** Sentence to append to the target's prompt — the reference's ROLE. */
  role: string
}

export interface ContinuitySkip {
  sourceId: string
  targetId: string
  reason: string
}

export interface ContinuityPlan {
  links: ContinuityLink[]
  skipped: ContinuitySkip[]
}

export interface ContinuityLimits {
  /** Handle `maxCount` (Seedance 2 reference videos: 3). */
  maxCount?: number
  /** Handle `maxTotalSeconds` (Seedance 2 reference videos: 15). */
  maxTotalSeconds?: number
  /** Reference alias of the handle, defaults to the Seedance 2 video alias. */
  alias?: string
}

/**
 * The role sentence for a previous clip wired as a reference. It says both
 * halves out loud, because the model does the wrong thing with either one
 * missing: MATCH the look, do NOT continue the action (that would be a
 * continuation, and the shot stops being a cut).
 */
export function previousShotRole(alias: string, label: string): string {
  return (
    `${alias} is the PREVIOUS shot ("${label}") — match its lighting, color grade, wardrobe, set ` +
    `and character appearance exactly. Do NOT continue its action or its camera move: this shot is ` +
    `a CUT to a new camera setup.`
  )
}

/**
 * The written half of continuity, quoted verbatim in the prompting guides and
 * in both chat system prompts. Kept here so the doctrine has one source.
 */
export const TRANSITION_CONTRACT = [
  'OPENS ON: the frame this shot starts on — where the subject sits in frame, which way it is already moving, what the previous shot handed over.',
  'CLOSES ON: the frame this shot ends on — the state the next shot has to pick up.',
  'Screen direction is continuous across a cut: a subject travelling left-to-right keeps travelling left-to-right in the next shot unless the script explicitly turns it around.',
  'Two shots of the same action share the same axis: do not cross the line between them, or the two clips read as two different scenes.'
].join(' ')

/**
 * Plans one continuity link per consecutive pair: shot N-1's output into shot
 * N's reference-video handle. Pairs that would overrun the handle's budget are
 * SKIPPED with a reason rather than wired — an over-budget run is rejected by
 * the provider, and it would be rejected after the upload.
 */
export function planContinuityChain(
  shots: ShotForChain[],
  limits: ContinuityLimits = {}
): ContinuityPlan {
  const alias = limits.alias ?? '@Video'
  const links: ContinuityLink[] = []
  const skipped: ContinuitySkip[] = []

  for (let i = 1; i < shots.length; i++) {
    const source = shots[i - 1]!
    const target = shots[i]!
    const existing = target.existingRefs ?? { count: 0, seconds: 0 }
    const index = existing.count + 1
    const seconds = source.durationSeconds ?? 0

    if (limits.maxCount !== undefined && index > limits.maxCount) {
      skipped.push({
        sourceId: source.id,
        targetId: target.id,
        reason: `"${target.label}" already has ${existing.count} reference videos (max ${limits.maxCount}).`
      })
      continue
    }
    if (
      limits.maxTotalSeconds !== undefined &&
      existing.seconds + seconds > limits.maxTotalSeconds
    ) {
      skipped.push({
        sourceId: source.id,
        targetId: target.id,
        reason: `"${target.label}" would carry ${existing.seconds + seconds}s of reference video (max ${limits.maxTotalSeconds}s) — shorten the shots or leave this cut unchained.`
      })
      continue
    }

    links.push({
      sourceId: source.id,
      targetId: target.id,
      alias: `${alias}${index}`,
      role: previousShotRole(`${alias}${index}`, source.label)
    })
  }

  return { links, skipped }
}
