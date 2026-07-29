/**
 * Casting (§6.10) — the pure half.
 *
 * The library already records WHAT a sheet is (`assets.design_id` /
 * `design_subject`): "a character sheet, of a girl with pink hair". What it has
 * never recorded is WHO that is for the film — "Léa IS that sheet, and she is
 * the same Léa in every shot she appears in". That named, persistent identity
 * is the casting, and this module owns the half of it with no I/O: the role
 * sentence a cast reference writes into a prompt, and the plan deciding which
 * shots can carry it.
 *
 * This is `shotContinuity` for IDENTITY instead of continuity, on purpose:
 * same reference-handle budget, same skip-instead-of-overrun rule, same "a
 * reference nobody addresses in the prompt only guides by accident".
 *
 * What differs is what the sentence says. Continuity's role sentence points
 * BACKWARD at one shot ("match its grade, do not continue its action");
 * casting's names the identity and asks for it to be invariant ACROSS shots.
 * Hence the name in caps, repeated: a model told "@Image1 is the character
 * sheet" keeps a look, a model told "@Image1 is LÉA" keeps a person — and the
 * sheet is what the film means by Léa, not one shot's interpretation of her.
 */

/** One shot considered for a role, in any order — casting has no chaining. */
export interface ShotForCasting {
  /** Opaque node id — this module never interprets it. */
  id: string
  /** Display name, quoted in skip reasons so the report names the shot. */
  label: string
  /** Connections already on the target reference handle, before this plan. */
  existingRefs?: { count: number }
  /**
   * The 1-based position this role is ALREADY wired at. Re-casting a role (a
   * second pass over a longer selection, an agent retry) must report the alias
   * the shot already answers to rather than wire a duplicate and append a
   * second role sentence.
   */
  alreadyCastAt?: number
}

/** The identity being cast — everything the sentence needs, already resolved. */
export interface CastingRole {
  /** The name the film calls this role, e.g. "Léa". */
  name: string
  /** `assets.design_subject` — what the sheet depicts, quoted once. */
  subject?: string
  /** `assets.design_id` — picks the invariance clause (a prop is not "in character"). */
  designId?: string
  /** Free-form direction carried by the casting ("always wears the red scarf"). */
  notes?: string
}

export interface CastingLink {
  shotId: string
  /** The alias the new connection will answer to, e.g. `@Image1`. */
  alias: string
  /** Sentence to append to the shot's prompt — the role's identity contract. */
  role: string
}

export interface CastingSkip {
  shotId: string
  reason: string
}

export interface CastingPlan {
  links: CastingLink[]
  skipped: CastingSkip[]
  /** Shots that already carry this role, reported with their existing alias. */
  alreadyCast: Array<{ shotId: string; alias: string }>
}

export interface CastingLimits {
  /** Handle `maxCount` (Seedance 2 reference images: 9). */
  maxCount?: number
  /** Reference alias of the handle, defaults to the Seedance 2 image alias. */
  alias?: string
}

/**
 * What "the same" means for this kind of sheet. A character has a face and a
 * build; a décor has architecture; a prop has materials and wear. Saying the
 * wrong one is worse than saying nothing — "keep the same face" on a pack-shot
 * invites the model to put a person in the frame.
 */
function invarianceClause(designId: string | undefined): string {
  switch (designId) {
    case 'character':
    case 'expressions':
      return 'the same face, hair, build and proportions as the sheet'
    case 'wardrobe':
      return 'the same character as the sheet, wearing the outfit this shot calls for'
    case 'decor':
      return 'the same location, architecture, colors and light as the sheet'
    case 'prop':
    case 'packshot':
      return 'the same object as the sheet — shape, materials, markings and wear'
    default:
      return 'the same design, colors and details as the sheet'
  }
}

/**
 * The role sentence for a cast identity. It states three things the model gets
 * wrong when any of them is missing: WHO this is (named, so the identity has a
 * handle in the prompt), that it must be invariant across the whole film and
 * not just this shot, and that the sheet is a reference — the single most
 * expensive mistake in the app is a design sheet rendered on screen.
 */
export function castingRoleSentence(alias: string, role: CastingRole): string {
  const name = role.name.trim()
  const upper = name.toLocaleUpperCase('fr-FR')
  const subject = role.subject?.trim()
  const notes = role.notes?.trim()
  return (
    `${alias} is ${upper}${subject ? ` (${subject})` : ''} — ${invarianceClause(role.designId)}, ` +
    `in this shot and in every other shot ${upper} appears in. ` +
    `The sheet is a REFERENCE: it must never appear on screen as a frame or a panel.` +
    (notes ? ` ${notes.endsWith('.') ? notes : `${notes}.`}` : '')
  )
}

/**
 * Plans one reference link per shot: the role's sheet onto each shot's
 * reference-image handle, with the sentence that declares it. Shots whose
 * handle is already full are SKIPPED with a reason rather than wired — an
 * over-budget run is rejected by the provider, and only after the upload.
 *
 * Order does not matter here (unlike a continuity chain): each shot's budget is
 * its own, and casting the same role twice on the same shot is a no-op, not a
 * second reference.
 */
export function planCasting(
  shots: ShotForCasting[],
  role: CastingRole,
  limits: CastingLimits = {}
): CastingPlan {
  const alias = limits.alias ?? '@Image'
  const plan: CastingPlan = { links: [], skipped: [], alreadyCast: [] }

  for (const shot of shots) {
    if (shot.alreadyCastAt !== undefined) {
      plan.alreadyCast.push({ shotId: shot.id, alias: `${alias}${shot.alreadyCastAt}` })
      continue
    }
    const existing = shot.existingRefs?.count ?? 0
    const index = existing + 1
    if (limits.maxCount !== undefined && index > limits.maxCount) {
      plan.skipped.push({
        shotId: shot.id,
        reason: `"${shot.label}" already carries ${existing} reference images (max ${limits.maxCount}) — free a slot on that shot, or leave ${role.name.trim()} off it.`
      })
      continue
    }
    const aliasN = `${alias}${index}`
    plan.links.push({ shotId: shot.id, alias: aliasN, role: castingRoleSentence(aliasN, role) })
  }

  return plan
}
