import { clampParamToField, getModel, type ParamField } from './models'
import { ANTI_GRID_GUARD } from './models/seedance2-prompting'

/**
 * Scenario (§6.7) — the step BEFORE the production plan.
 *
 * The assistant used to go straight from a brief to a graph, so the model's
 * constraints only bit at the very end: a script with 2-3 s beats produced
 * clips the API refuses, seven 4 s shots quietly turned a 20 s script into a
 * 28 s film, and each shot prompt was written in isolation — which is exactly
 * how you get a courier in traffic followed by a scooter shot from the other
 * side of the axis.
 *
 * A scenario fixes that at the only moment it is still cheap: it takes the
 * beats of a script and returns SHOTS that are legal by construction (durations
 * merged, split and snapped to what the model accepts), reconciled with the
 * requested length, and CHAINED — every shot knows the frame it opens on and
 * the frame it closes on, and its `promptScaffold` is the paragraph the shot's
 * prompt is written on top of.
 *
 * Pure and unit-tested: the same plan feeds the assistant, the scenario panel
 * and (later) whatever writes the graph.
 */

export const SCENARIO_VERSION = 1

/** Which way the subject travels — continuity across a cut depends on it. */
export const SCREEN_DIRECTIONS = [
  'left-to-right',
  'right-to-left',
  'toward-camera',
  'away-from-camera',
  'static'
] as const
export type ScreenDirection = (typeof SCREEN_DIRECTIONS)[number]

/** One beat of the script, as written from the brief. Durations may be illegal. */
export interface ScenarioBeat {
  /** Short title, e.g. "Le départ". */
  title: string
  /** What happens — the raw material of the shot prompt. */
  action: string
  /** Duration the script asks for, in seconds (any value; normalized below). */
  seconds: number
  /** Camera intent ("tight handheld insert", "low-angle tracking"). */
  camera?: string
  /** Dialogue and sound design for this beat. */
  sound?: string
  /** The frame the beat opens on. Derived from the previous beat when omitted. */
  opensOn?: string
  /** The frame the beat closes on — what the NEXT shot opens on. */
  closesOn?: string
  screenDirection?: ScreenDirection
  /**
   * Cast roles appearing in this beat, by name (`castings.name`, §6.10).
   *
   * WHO is in a shot is the one thing a graph builder cannot derive from the
   * script — a character sheet wired on every shot of the film is wrong as
   * often as it is right. Naming the roles here is what lets §6.11 build the
   * graph without asking a model again at the last mile. Unknown names are
   * reported, never fatal: the scenario may legitimately be written before the
   * sheets are published.
   */
  roles?: string[]
  /** True when the shot will be driven by a storyboard/shot board reference. */
  boardDriven?: boolean
  /**
   * Fold this beat into the next one (into the previous one when it is last),
   * whatever the policy. The surgical override: two beats that are really one
   * camera setup, or a 1 s insert that must not become a 4 s shot.
   */
  mergeWithNext?: boolean
}

/**
 * What to do with a beat the model cannot deliver as its own clip.
 *  - `stretch` (default): the beat stays its own shot, run at the model's
 *    floor. Keeps the director's cut list intact; the added seconds are
 *    reported and reconciled against the brief.
 *  - `merge`: the beat is folded into its neighbour. Keeps the film's total
 *    length intact; changes the cut list, so it is never the silent default —
 *    two beats merged into one clip must read as ONE camera setup.
 */
export type ShortBeatPolicy = 'stretch' | 'merge'

/** One legal shot: a beat (or several merged, or a slice of one) the model accepts. */
export interface ScenarioShot {
  /** Stable key, usable as-is as the node key in a workflow import. */
  key: string
  title: string
  action: string
  /** Legal duration for the scenario's model. */
  seconds: number
  /** What the script asked for, before merge/split/snap. */
  requestedSeconds: number
  camera?: string
  sound?: string
  opensOn: string
  closesOn: string
  screenDirection?: ScreenDirection
  /** Cast roles appearing in this shot, normalized (trimmed, deduplicated). */
  roles?: string[]
  /** Titles of the beats folded into this shot (only when more than one). */
  mergedFrom?: string[]
  /** The continuity paragraph the shot's prompt is written on top of. */
  promptScaffold: string
}

export interface Scenario {
  version: typeof SCENARIO_VERSION
  /** The user's brief, verbatim — what the scenario has to deliver. */
  brief: string
  /** Video model the durations were made legal for. */
  modelId: string
  /** Total the brief asked for, when it named one. */
  targetSeconds?: number
  shots: ScenarioShot[]
  /** Sum of the shots' legal durations. */
  totalSeconds: number
  /** What the normalization had to change, and what is still missing. */
  warnings: string[]
}

export interface PlanScenarioInput {
  brief: string
  modelId: string
  beats: ScenarioBeat[]
  targetSeconds?: number
  /** How to make sub-floor beats legal. Defaults to `stretch`. */
  shortBeatPolicy?: ShortBeatPolicy
}

/** The model's duration field, or null when it has none (audio models). */
function durationFieldOf(modelId: string): ParamField | null {
  return (
    getModel(modelId)?.paramFields.find((f) => f.key === 'duration' && f.type === 'number') ?? null
  )
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Role names, cleaned once: trimmed, blanks dropped, deduplicated
 * case-insensitively — the same rule `createCasting` normalizes a role name
 * with, so a beat naming "Léa" and a beat naming "léa" reach the graph builder
 * as the same person instead of two.
 */
export function normalizeRoles(roles: string[] | undefined): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of roles ?? []) {
    const name = raw.trim().replace(/\s+/g, ' ')
    if (name === '') continue
    const folded = name.toLocaleLowerCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    kept.push(name)
  }
  return kept
}

/** Beats folded into one shot: titles joined, actions chained in order. */
function combine(beats: ScenarioBeat[]): ScenarioBeat & { sources: ScenarioBeat[] } {
  const first = beats[0]!
  if (beats.length === 1) return { ...first, sources: beats }
  const last = beats[beats.length - 1]!
  return {
    ...first,
    title: first.title,
    action: beats
      .map((b) => b.action.trim())
      .filter(Boolean)
      .join(' Then, '),
    seconds: beats.reduce((sum, b) => sum + b.seconds, 0),
    camera:
      beats
        .map((b) => b.camera?.trim())
        .filter(Boolean)
        .join(' → ') || undefined,
    sound:
      beats
        .map((b) => b.sound?.trim())
        .filter(Boolean)
        .join(' ') || undefined,
    // Everyone who appears in any of the folded beats appears in the shot.
    roles: normalizeRoles(beats.flatMap((b) => b.roles ?? [])),
    // The merged shot opens where the first beat did and closes where the last did.
    ...(first.opensOn ? { opensOn: first.opensOn } : {}),
    ...(last.closesOn ? { closesOn: last.closesOn } : {}),
    ...(last.screenDirection ? { screenDirection: last.screenDirection } : {}),
    sources: beats
  }
}

/**
 * Beats → shots the model accepts. A beat under the floor is never written as
 * an illegal clip: it is either run at the floor (`stretch`) or folded into its
 * neighbour (`merge`), and either way the change is reported. A beat over the
 * ceiling is SPLIT into equal legal parts, and every result is snapped to the
 * field's step.
 */
function normalizeDurations(
  beats: ScenarioBeat[],
  field: ParamField | null,
  policy: ShortBeatPolicy,
  warnings: string[]
): Array<ScenarioBeat & { sources: ScenarioBeat[]; part?: { index: number; of: number } }> {
  if (beats.length === 0) return []
  const min = field?.min ?? 0
  const max = field?.max ?? Number.POSITIVE_INFINITY

  // 1. Group beats: the explicit `mergeWithNext` overrides always, the floor
  //    accumulation only under the `merge` policy.
  const merged: Array<ScenarioBeat & { sources: ScenarioBeat[] }> = []
  let pending: ScenarioBeat[] = []
  for (const beat of beats) {
    pending.push(beat)
    if (beat.mergeWithNext === true) continue
    const seconds = pending.reduce((sum, b) => sum + b.seconds, 0)
    if (policy === 'merge' && seconds < min) continue
    merged.push(combine(pending))
    pending = []
  }
  if (pending.length > 0) {
    // A trailing group (an explicit merge on the last beat, or a remainder
    // under the floor) folds into the shot before it.
    const previous = merged.pop()
    merged.push(combine(previous ? [...previous.sources, ...pending] : pending))
  }
  for (const shot of merged) {
    if (shot.sources.length < 2) continue
    const detail = shot.sources.map((b) => `"${b.title}" (${round1(b.seconds)}s)`).join(' + ')
    warnings.push(
      `${detail} merged into one ${round1(shot.seconds)}s shot. Rewrite its action so it reads as ONE camera setup, not a list of beats.`
    )
  }

  // 2. Split anything above the ceiling into equal legal parts.
  const split: Array<
    ScenarioBeat & { sources: ScenarioBeat[]; part?: { index: number; of: number } }
  > = []
  for (const shot of merged) {
    if (shot.seconds <= max) {
      split.push(shot)
      continue
    }
    const parts = Math.ceil(shot.seconds / max)
    const each = shot.seconds / parts
    warnings.push(
      `"${shot.title}" asks for ${round1(shot.seconds)}s, above the ${max}s ceiling — split into ${parts} shots of ~${round1(each)}s. Give each part its own action and its own camera.`
    )
    for (let i = 0; i < parts; i++) {
      split.push({
        ...shot,
        seconds: each,
        // Only the first part keeps the entry, only the last one the exit.
        ...(i === 0 ? {} : { opensOn: undefined }),
        ...(i === parts - 1 ? {} : { closesOn: undefined }),
        part: { index: i + 1, of: parts }
      })
    }
  }

  // 3. Snap to the field (floor, ceiling and step share one definition).
  return split.map((shot) => {
    if (!field) return shot
    const legal = clampParamToField(shot.seconds, field)
    if (legal !== shot.seconds && !shot.part) {
      const delta = round1(legal - shot.seconds)
      warnings.push(
        `"${shot.title}" asks for ${round1(shot.seconds)}s — this model delivers ${legal}s (${delta > 0 ? '+' : ''}${delta}s; accepts ${field.min}-${field.max}${field.step && field.step > 1 ? `, step ${field.step}` : ''}). Merge it with a neighbour instead if the film's length must hold.`
      )
    }
    return { ...shot, seconds: legal }
  })
}

/** The entry sentence: explicit, or handed over by the previous shot. */
function openingOf(
  shot: { opensOn?: string; title: string },
  previous: ScenarioShot | undefined
): string {
  if (shot.opensOn?.trim()) return shot.opensOn.trim()
  if (!previous) return `The film opens here: ${shot.title}.`
  if (previous.closesOn.trim()) {
    return `Picks up the frame "${previous.closesOn.trim()}" that "${previous.title}" closed on — same light, same grade, the subject carrying the same momentum.`
  }
  return `A cut from "${previous.title}" — a new camera setup on the same action, same light and same grade.`
}

/** Continuity lines the shot's prompt is written on top of. */
function scaffoldFor(shot: ScenarioShot, isFirst: boolean, boardDriven: boolean): string {
  const lines = [
    isFirst ? null : 'New camera setup: this is a cut, not a continuation of the previous shot.',
    `OPENS ON: ${shot.opensOn}`,
    shot.closesOn ? `CLOSES ON: ${shot.closesOn}` : null,
    shot.screenDirection && shot.screenDirection !== 'static'
      ? `Screen direction: the subject travels ${shot.screenDirection.replace(/-/g, ' ')} — keep it continuous across the cut.`
      : null,
    boardDriven ? ANTI_GRID_GUARD : null
  ]
  return lines.filter(Boolean).join(' ')
}

/**
 * Turns the beats of a script into a shot list that is legal, reconciled with
 * the requested length, and chained shot to shot. Everything it had to change
 * — and everything still missing — comes back in `warnings`, so the assistant
 * reports it to the user instead of discovering it at run time.
 */
export function planScenario(input: PlanScenarioInput): Scenario {
  const warnings: string[] = []
  const field = durationFieldOf(input.modelId)
  if (!getModel(input.modelId)) {
    warnings.push(
      `Unknown model "${input.modelId}" — durations were left as written. Pick a video model from list_models.`
    )
  }

  const policy: ShortBeatPolicy = input.shortBeatPolicy ?? 'stretch'
  const normalized = normalizeDurations(input.beats, field, policy, warnings)
  const shots: ScenarioShot[] = []

  normalized.forEach((beat, index) => {
    const previous = shots[index - 1]
    const suffix = beat.part ? ` (${beat.part.index}/${beat.part.of})` : ''
    const shot: ScenarioShot = {
      key: `shot-${String(index + 1).padStart(2, '0')}`,
      title: `${beat.title}${suffix}`,
      action: beat.action.trim(),
      seconds: beat.seconds,
      requestedSeconds: round1(
        beat.sources.reduce((sum, b) => sum + b.seconds, 0) / (beat.part?.of ?? 1)
      ),
      ...(beat.camera?.trim() ? { camera: beat.camera.trim() } : {}),
      ...(beat.sound?.trim() ? { sound: beat.sound.trim() } : {}),
      opensOn: openingOf(beat, previous),
      closesOn: beat.closesOn?.trim() ?? '',
      ...(beat.screenDirection ? { screenDirection: beat.screenDirection } : {}),
      ...(normalizeRoles(beat.roles).length > 0 ? { roles: normalizeRoles(beat.roles) } : {}),
      ...(beat.sources.length > 1 ? { mergedFrom: beat.sources.map((b) => b.title) } : {}),
      promptScaffold: ''
    }
    shot.promptScaffold = scaffoldFor(shot, index === 0, beat.boardDriven === true)
    shots.push(shot)
  })

  // A missing exit frame is the transition defect itself: the next shot has
  // nothing to open on, and the two clips end up unrelated.
  for (const [index, shot] of shots.entries()) {
    if (shot.closesOn.trim() === '' && index < shots.length - 1) {
      warnings.push(
        `"${shot.title}" does not say what frame it CLOSES ON — "${shots[index + 1]!.title}" has nothing to open on. Write it, or the cut is left to chance.`
      )
    }
    if (shot.action.trim() === '') warnings.push(`"${shot.title}" has no action written.`)
  }

  // A reversal across a cut reads as a different scene — flag it, never fix it
  // silently: some reversals are deliberate (a reverse angle, a U-turn).
  for (let i = 1; i < shots.length; i++) {
    const previous = shots[i - 1]!
    const current = shots[i]!
    const moving = (d?: ScreenDirection) => d !== undefined && d !== 'static'
    if (!moving(previous.screenDirection) || !moving(current.screenDirection)) continue
    const reversed =
      (previous.screenDirection === 'left-to-right' &&
        current.screenDirection === 'right-to-left') ||
      (previous.screenDirection === 'right-to-left' &&
        current.screenDirection === 'left-to-right') ||
      (previous.screenDirection === 'toward-camera' &&
        current.screenDirection === 'away-from-camera') ||
      (previous.screenDirection === 'away-from-camera' &&
        current.screenDirection === 'toward-camera')
    if (reversed) {
      warnings.push(
        `"${previous.title}" travels ${previous.screenDirection!.replace(/-/g, ' ')} and "${current.title}" travels ${current.screenDirection!.replace(/-/g, ' ')} — a reversal across a cut reads as a different scene. Confirm it is deliberate, or keep the direction.`
      )
    }
  }

  const totalSeconds = round1(shots.reduce((sum, shot) => sum + shot.seconds, 0))
  if (input.targetSeconds !== undefined && totalSeconds !== input.targetSeconds) {
    const delta = round1(totalSeconds - input.targetSeconds)
    warnings.push(
      `The shot list totals ${totalSeconds}s for a ${input.targetSeconds}s brief (${delta > 0 ? '+' : ''}${delta}s). Cut or merge a beat, or tell the user the film is ${totalSeconds}s — do not leave the gap unsaid.`
    )
  }

  return {
    version: SCENARIO_VERSION,
    brief: input.brief,
    modelId: input.modelId,
    ...(input.targetSeconds !== undefined ? { targetSeconds: input.targetSeconds } : {}),
    shots,
    totalSeconds,
    warnings
  }
}
