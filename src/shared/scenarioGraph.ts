import { getRecipe, SHOT_RECIPES, type RecipeValues } from './designs/registry'
import { normalizeRoles, type Scenario, type ScenarioShot } from './scenario'

/**
 * Scenario → graph (§6.11) — the deterministic last mile.
 *
 * `planScenario` already returns, per shot, exactly the values a shot preset
 * asks for: a legal duration, the frame it opens on, the frame it closes on,
 * the screen direction, the sound. Until now nothing consumed them: the only
 * path from a shot list to a graph went through the assistant writing an
 * `import_workflow` payload by hand, which re-derives — differently every time
 * — what the scenario had already decided.
 *
 * This module is the missing translation, and it is pure: a shot's `camera`
 * line picks a preset from `SHOT_RECIPES`, the rest of the shot fills that
 * preset's fields, and everything the choice had to degrade (a preset the
 * target model cannot run, a camera line nobody could read) comes back as a
 * note. No model is called at this step — the creative decisions were all made
 * upstream, in the scenario.
 *
 * The matching is deliberately keyword-based over a normalized haystack rather
 * than clever: it has to be explainable to the user in the confirm dialog
 * ("push-in — matched \"travelling avant\""), reproducible across runs, and
 * testable. A camera line it cannot read is not a failure — it falls through to
 * the structural rules below, which are right often enough to be worth having
 * and always visible in the plan.
 */

/** Accent- and case-insensitive haystack — French camera notes are the norm. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Keyword lookup on the folded haystack, at word boundaries.
 *
 * Two lengths, one rule: an abbreviation (3 characters or fewer — "cu", "ews",
 * "pov") only matches a whole word, because a bare substring search turns
 * "focus" into a close-up and "flows" into a wide shot; anything longer matches
 * as a prefix, so "track" also reads "tracking" and "reveal" also reads
 * "reveals" without listing every inflection in two languages.
 */
function mentions(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tail = keyword.length <= 3 ? '' : '[a-z]*'
  return new RegExp(`(?:^| )${escaped}${tail}(?:$| )`).test(haystack)
}

interface KeywordRule {
  recipeId: string
  /** Folded keywords — see `mentions` for how they are matched. */
  keywords: string[]
}

/**
 * MOTION rules, most specific phrasing first. What the camera DOES is the
 * discriminating half of a preset, so these run before the framing rules: a
 * "travelling avant" is a push-in whatever the shot size, and reading the size
 * separately (see `matchShotSize`) means the two never have to compete.
 */
const MOTION_RULES: KeywordRule[] = [
  {
    recipeId: 'shot-whip-pan',
    keywords: ['whip pan', 'whippan', 'whip', 'swish', 'panoramique rapide', 'pano rapide', 'file']
  },
  {
    recipeId: 'shot-push-in',
    keywords: [
      'push in',
      'pushin',
      'dolly in',
      'crash in',
      'travelling avant',
      'trav avant',
      'zoom avant',
      'zoom in',
      'resserre',
      'rapprochement',
      'se rapproche',
      'moves in',
      'closes in',
      'tightens'
    ]
  },
  {
    recipeId: 'shot-pull-back',
    keywords: [
      'pull back',
      'pullback',
      'pull out',
      'dolly out',
      'travelling arriere',
      'trav arriere',
      'zoom arriere',
      'zoom out',
      'reveal',
      'revele',
      'devoile',
      'recule',
      'recul',
      'backs away',
      'widens',
      'elargit'
    ]
  },
  {
    recipeId: 'shot-orbit',
    keywords: [
      'orbit',
      'orbite',
      'arc around',
      'circle around',
      'circular',
      'tourne autour',
      'autour du sujet',
      'rotation autour',
      '360'
    ]
  },
  {
    recipeId: 'shot-tracking',
    keywords: [
      'tracking',
      'travelling lateral',
      'travelling',
      'traveling',
      'track',
      'follows',
      'following',
      'suit le',
      'suit la',
      'accompagne',
      'alongside',
      'lateral',
      'steadicam',
      'dolly'
    ]
  },
  {
    recipeId: 'shot-pov-handheld',
    keywords: [
      'pov',
      'point of view',
      'handheld',
      'hand held',
      'camera portee',
      'a la main',
      'epaule',
      'shoulder',
      'subjectif',
      'subjective',
      'shaky',
      'nerveuse'
    ]
  },
  {
    recipeId: 'shot-locked-off',
    keywords: [
      'locked off',
      'lock off',
      'plan fixe',
      'camera fixe',
      'static',
      'statique',
      'fixe',
      'tripod',
      'trepied',
      'immobile'
    ]
  }
]

/**
 * FRAMING rules — the fallback when the camera line says how tight the shot is
 * but not what the camera does. They resolve to the preset built for that
 * framing, which is also the one carrying the right default duration.
 */
const FRAMING_RULES: KeywordRule[] = [
  {
    recipeId: 'shot-insert',
    keywords: [
      'insert',
      'macro',
      'extreme close',
      'ecu',
      'tres gros plan',
      'cutaway',
      'detail',
      'encart'
    ]
  },
  {
    recipeId: 'shot-reaction',
    keywords: [
      'reaction',
      'close up',
      'closeup',
      'gros plan',
      'mcu',
      'cu on',
      'visage',
      'expression',
      'portrait',
      'regard'
    ]
  },
  {
    recipeId: 'shot-establishing',
    keywords: [
      'establishing',
      'establish',
      'etabli',
      'plan large',
      'plan d ensemble',
      'vue d ensemble',
      'ensemble',
      'wide',
      'large',
      'master',
      'panorama',
      'aerial',
      'drone',
      'ews',
      'ws'
    ]
  }
]

/** Shot-size vocabulary, read INDEPENDENTLY of the preset (both are useful). */
const SIZE_RULES: Array<{ sizeId: string; keywords: string[] }> = [
  {
    sizeId: 'ecu',
    keywords: ['extreme close', 'ecu', 'macro', 'tres gros plan', 'insert', 'detail']
  },
  { sizeId: 'cu', keywords: ['close up', 'closeup', 'gros plan', 'visage', 'portrait', 'cu'] },
  { sizeId: 'mcu', keywords: ['medium close', 'mcu', 'plan poitrine', 'plan rapproche'] },
  { sizeId: 'ms', keywords: ['medium shot', 'ms', 'plan moyen', 'plan taille', 'mid shot'] },
  { sizeId: 'ws', keywords: ['wide shot', 'ws', 'plan large', 'full figure', 'plan pied'] },
  {
    sizeId: 'ews',
    keywords: [
      'extreme wide',
      'ews',
      'establishing',
      'plan d ensemble',
      'vue d ensemble',
      'aerial',
      'drone',
      'panorama'
    ]
  }
]

const PACE_RULES: Array<{ pace: string; keywords: string[] }> = [
  {
    pace: 'fast',
    keywords: [
      'fast',
      'rapide',
      'urgent',
      'frantic',
      'nerveux',
      'nerveuse',
      'vif',
      'brutal',
      'snap'
    ]
  },
  {
    pace: 'slow',
    keywords: ['slow', 'lent', 'lente', 'doux', 'douce', 'posee', 'pose', 'gently', 'deliberate']
  }
]

/**
 * Presets to fall back on when the matched one cannot run on the scenario's
 * model, nearest intent first. Every chain ends on `shot-locked-off`: a rigid
 * frame is the one shot every video model delivers, so a degraded shot is still
 * a usable shot rather than a hole in the graph.
 */
const SUBSTITUTES: Record<string, string[]> = {
  'shot-orbit': ['shot-tracking', 'shot-establishing', 'shot-locked-off'],
  'shot-insert': ['shot-reaction', 'shot-locked-off'],
  'shot-whip-pan': ['shot-tracking', 'shot-locked-off'],
  'shot-pov-handheld': ['shot-tracking', 'shot-locked-off'],
  'shot-tracking': ['shot-establishing', 'shot-locked-off'],
  'shot-push-in': ['shot-establishing', 'shot-locked-off'],
  'shot-pull-back': ['shot-establishing', 'shot-locked-off'],
  'shot-reaction': ['shot-locked-off'],
  'shot-establishing': ['shot-locked-off']
}

const DEFAULT_PRESET = 'shot-locked-off'

/** The first keyword of the first rule present in the haystack. */
function firstMatch(
  rules: KeywordRule[],
  haystack: string
): { rule: KeywordRule; hit: string } | null {
  for (const rule of rules) {
    const hit = rule.keywords.find((keyword) => mentions(haystack, keyword))
    if (hit !== undefined) return { rule, hit }
  }
  return null
}

/** Does this preset run on that model? Reads the registry, never a hardcoded list. */
function runsOn(recipeId: string, modelId: string): boolean {
  return getRecipe(recipeId)?.supportedModels.includes(modelId) ?? false
}

export interface ShotRecipeMatch {
  recipeId: string
  /** Plain-language justification, shown in the confirm and returned to agents. */
  reason: string
  /** Set when the model forced a different preset than the camera line asked for. */
  substitutedFrom?: string
}

/**
 * The preset a shot is realized with. Reads the camera line first, falls back
 * to the shot's own structure (its place in the film, its length, the direction
 * the subject travels) — never returns nothing, unless the target model runs no
 * shot preset at all, in which case the caller reports the shot as skipped.
 */
export function matchShotRecipe(
  shot: Pick<ScenarioShot, 'camera' | 'seconds' | 'screenDirection'>,
  modelId: string,
  index = 0
): ShotRecipeMatch | null {
  const haystack = fold(shot.camera ?? '')
  const motion = haystack ? firstMatch(MOTION_RULES, haystack) : null
  const framing = motion === null && haystack ? firstMatch(FRAMING_RULES, haystack) : null

  let recipeId: string
  let reason: string
  if (motion) {
    recipeId = motion.rule.recipeId
    reason = `camera says "${motion.hit}"`
  } else if (framing) {
    recipeId = framing.rule.recipeId
    reason = `camera says "${framing.hit}"`
  } else if (index === 0 && shot.seconds >= 6) {
    recipeId = 'shot-establishing'
    reason = 'opening shot with room to breathe'
  } else if (shot.seconds <= 4) {
    recipeId = 'shot-insert'
    reason = `${shot.seconds}s — too short for a developed move`
  } else if (shot.screenDirection === 'left-to-right' || shot.screenDirection === 'right-to-left') {
    recipeId = 'shot-tracking'
    reason = `subject travels ${shot.screenDirection.replace(/-/g, ' ')}`
  } else if (shot.screenDirection === 'toward-camera') {
    recipeId = 'shot-push-in'
    reason = 'subject moves toward camera'
  } else if (shot.screenDirection === 'away-from-camera') {
    recipeId = 'shot-pull-back'
    reason = 'subject moves away from camera'
  } else {
    recipeId = DEFAULT_PRESET
    reason = 'no camera intent written — a rigid frame is the safe default'
  }

  if (runsOn(recipeId, modelId)) return { recipeId, reason }

  // The model cannot run it: walk the substitution chain, keeping the reason
  // that chose the original so the user sees BOTH the intent and the compromise.
  const wanted = recipeId
  for (const candidate of [...(SUBSTITUTES[wanted] ?? []), DEFAULT_PRESET]) {
    if (!runsOn(candidate, modelId)) continue
    return {
      recipeId: candidate,
      reason,
      substitutedFrom: wanted
    }
  }
  return null
}

/** The shot size named in the camera line, when it names one. */
export function matchShotSize(camera: string | undefined): string | undefined {
  const haystack = fold(camera ?? '')
  if (!haystack) return undefined
  for (const rule of SIZE_RULES) {
    if (rule.keywords.some((keyword) => mentions(haystack, keyword))) return rule.sizeId
  }
  return undefined
}

/** The pace named in the camera line — `steady` is the field default, so it is left out. */
export function matchPace(camera: string | undefined): string | undefined {
  const haystack = fold(camera ?? '')
  if (!haystack) return undefined
  for (const rule of PACE_RULES) {
    if (rule.keywords.some((keyword) => mentions(haystack, keyword))) return rule.pace
  }
  return undefined
}

/**
 * A shot's field values for a shot preset. This is the whole point of the
 * scenario step: every value here was decided upstream and is copied, not
 * re-invented. Blank fields are omitted so the preset's own defaults apply.
 */
export function shotRecipeValues(shot: ScenarioShot): RecipeValues {
  const size = matchShotSize(shot.camera)
  const pace = matchPace(shot.camera)
  // The frames land inside a sentence the preset writes ("The shot OPENS ON:
  // …."), so a value that already ends on a full stop would double it.
  const frame = (value: string): string => value.trim().replace(/\.+$/, '')
  return {
    description: shot.action.trim() || shot.title.trim(),
    ...(shot.opensOn.trim() ? { opensOn: frame(shot.opensOn) } : {}),
    ...(shot.closesOn.trim() ? { closesOn: frame(shot.closesOn) } : {}),
    ...(shot.screenDirection ? { screenDirection: shot.screenDirection } : {}),
    ...(shot.sound?.trim() ? { sound: shot.sound.trim() } : {}),
    ...(size ? { shotSize: size } : {}),
    ...(pace ? { pace } : {})
  }
}

export interface PlannedShotNode {
  /** The shot's key, reused as the node key — the graph reads like the shot list. */
  key: string
  title: string
  recipeId: string
  modelId: string
  seconds: number
  values: RecipeValues
  /** Cast roles to wire on this shot, normalized. */
  roles: string[]
  /** Why this preset was chosen. */
  reason: string
  /** Everything the choice had to degrade — always surfaced, never silent. */
  notes: string[]
}

export interface ScenarioShotPlan {
  modelId: string
  build: PlannedShotNode[]
  /** Shots whose node key already exists — a second build adds, never duplicates. */
  alreadyBuilt: Array<{ key: string; title: string }>
  skipped: Array<{ key: string; title: string; reason: string }>
}

/**
 * The shot list turned into node blueprints. Pure: the caller resolves roles to
 * castings, picks positions and writes to the database.
 *
 * `existingKeys` is what makes a rebuild safe. The scenario is the reference and
 * the graph is its realization, so re-running after adding two beats must add
 * two shots — not duplicate the five that are already generating.
 */
export function planScenarioShots(
  scenario: Scenario,
  options: { existingKeys?: string[]; modelId?: string } = {}
): ScenarioShotPlan {
  const modelId = options.modelId ?? scenario.modelId
  const existing = new Set(options.existingKeys ?? [])
  const plan: ScenarioShotPlan = { modelId, build: [], alreadyBuilt: [], skipped: [] }

  scenario.shots.forEach((shot, index) => {
    if (existing.has(shot.key)) {
      plan.alreadyBuilt.push({ key: shot.key, title: shot.title })
      return
    }
    const match = matchShotRecipe(shot, modelId, index)
    if (!match) {
      plan.skipped.push({
        key: shot.key,
        title: shot.title,
        reason: `No shot preset runs on ${modelId} — write this shot's node by hand, or plan the scenario on a model the presets support (${supportedModels().join(', ')}).`
      })
      return
    }
    const notes: string[] = []
    if (match.substitutedFrom !== undefined) {
      notes.push(
        `${match.substitutedFrom} does not run on ${modelId} — realized as ${match.recipeId} instead.`
      )
    }
    if (!shot.closesOn.trim()) {
      notes.push('No closing frame written — the cut to the next shot is left to chance.')
    }
    plan.build.push({
      key: shot.key,
      title: shot.title,
      recipeId: match.recipeId,
      modelId,
      seconds: shot.seconds,
      values: shotRecipeValues(shot),
      roles: normalizeRoles(shot.roles),
      reason: match.reason,
      notes
    })
  })

  return plan
}

/** Every model at least one shot preset can run on — used in the skip message. */
function supportedModels(): string[] {
  return [...new Set(SHOT_RECIPES.flatMap((recipe) => recipe.supportedModels))].sort()
}
