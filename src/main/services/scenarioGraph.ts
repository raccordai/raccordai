import { eq } from 'drizzle-orm'
import { planScenarioShots, type PlannedShotNode } from '@shared/scenarioGraph'
import { getDb } from '../db/client'
import { nodes } from '../db/schema'
import * as graph from './graph'
import { withGraphHistoryGroup } from './graphHistory'
import { castRole, listCastings, type Casting } from './casting'
import { createRecipeNode } from './recipes'
import { getVideo, getVideoScenario } from './videos'

/**
 * Scenario → graph (§6.11) — the I/O half of `@shared/scenarioGraph`.
 *
 * The scenario is the reference and the graph is its realization, but until now
 * the trip between them went through a language model writing an
 * `import_workflow` payload by hand: the durations `planScenario` had made
 * legal were retyped, the camera intent was re-invented as prose, and the same
 * shot list produced a different graph every time it was built.
 *
 * This builds it instead. Each shot becomes a shot-preset node — through
 * `createRecipeNode`, the single creation path, so the preset's camera grammar,
 * its per-model params and its markers travel with it — carrying the shot's own
 * legal duration, its opening and closing frames and its screen direction. The
 * roles the scenario named are then cast onto exactly the shots that name them.
 * Everything lands in ONE undo step: the user built a film, they undo a film.
 *
 * Shaped like `casting.ts` and `continuity.ts` on purpose: plan before mutating,
 * derive nothing that the registries already declare, and skip with a reason
 * instead of overrunning — one unrealizable shot never costs the other six.
 *
 * What it deliberately does NOT do: wire shots to each other. Between shots you
 * CUT — consistency comes from the references shared by all of them, which is
 * exactly what the casting pass wires. Chaining is a separate, opt-in gesture
 * (`link_shots`).
 */

/** Vertical pitch between two shots: the layout grid's row = the shot's order. */
const ROW_PITCH = 320

export interface PlannedRole {
  name: string
  /** The project's role of that name, or null when nothing is cast under it yet. */
  castingId: string | null
}

export interface ScenarioGraphPlanEntry {
  /** The shot's key, reused as the node key. */
  key: string
  title: string
  recipeId: string
  modelId: string
  seconds: number
  /** Why this preset was chosen — the camera words that matched, or the rule. */
  reason: string
  notes: string[]
  roles: PlannedRole[]
}

export interface ScenarioGraphPlan {
  videoId: string
  modelId: string
  /** Shots in the scenario, whatever happens to them below. */
  shotCount: number
  build: ScenarioGraphPlanEntry[]
  /** Shots whose node already exists — a rebuild adds, it never duplicates. */
  alreadyBuilt: Array<{ key: string; title: string }>
  skipped: Array<{ key: string; title: string; reason: string }>
  /** Role names the scenario uses that the project's cast does not know. */
  unknownRoles: string[]
}

export interface BuildGraphFromScenarioResult {
  videoId: string
  created: Array<{ nodeId: string; key: string; recipeId: string }>
  alreadyBuilt: Array<{ key: string; title: string }>
  skipped: Array<{ key: string; title: string; reason: string }>
  /** One entry per role actually cast, with what its pass wired and skipped. */
  cast: Array<{
    castingId: string
    name: string
    nodeIds: string[]
    skipped: Array<{ nodeId: string; reason: string }>
  }>
  unknownRoles: string[]
}

/** Case-insensitive lookup of the project's cast, by role name. */
function castByName(projectId: string): Map<string, Casting> {
  const map = new Map<string, Casting>()
  for (const casting of listCastings(projectId)) map.set(casting.name.toLocaleLowerCase(), casting)
  return map
}

/** Everything both the dry run and the build need, resolved once. */
function resolve(videoId: string, shotKeys?: string[]) {
  const video = getVideo(videoId)
  if (!video) throw new Error(`Unknown videoId "${videoId}".`)
  const scenario = getVideoScenario(videoId)
  if (!scenario) {
    throw new Error(
      `Video "${video.name}" has no scenario yet — write_scenario turns the brief into the shot list this builds from.`
    )
  }
  if (scenario.shots.length === 0) throw new Error('That scenario has no shots.')

  const existingKeys = getDb()
    .select({ key: nodes.key })
    .from(nodes)
    .where(eq(nodes.videoId, videoId))
    .all()
    .map((row) => row.key)

  const plan = planScenarioShots(scenario, { existingKeys })

  // An explicit selection narrows the build; the shots left out are not
  // "skipped" (nothing went wrong), they are simply not part of this gesture.
  const wanted = shotKeys && shotKeys.length > 0 ? new Set(shotKeys) : null
  if (wanted) {
    const known = new Set(scenario.shots.map((shot) => shot.key))
    for (const key of wanted) {
      if (!known.has(key)) throw new Error(`Scenario has no shot "${key}".`)
    }
    plan.build = plan.build.filter((entry) => wanted.has(entry.key))
    plan.alreadyBuilt = plan.alreadyBuilt.filter((entry) => wanted.has(entry.key))
    plan.skipped = plan.skipped.filter((entry) => wanted.has(entry.key))
  }

  const cast = castByName(video.projectId)
  const unknownRoles = [
    ...new Set(
      plan.build
        .flatMap((entry) => entry.roles)
        .filter((name) => !cast.has(name.toLocaleLowerCase()))
    )
  ]

  return { video, scenario, plan, cast, unknownRoles }
}

function toPlanEntry(entry: PlannedShotNode, cast: Map<string, Casting>): ScenarioGraphPlanEntry {
  return {
    key: entry.key,
    title: entry.title,
    recipeId: entry.recipeId,
    modelId: entry.modelId,
    seconds: entry.seconds,
    reason: entry.reason,
    notes: entry.notes,
    roles: entry.roles.map((name) => ({
      name,
      castingId: cast.get(name.toLocaleLowerCase())?.id ?? null
    }))
  }
}

/**
 * What `buildGraphFromScenario` would create, without touching anything — the
 * editor shows it before spending an undo step, and the assistant reports it
 * before asking. Free: no model call, no credit.
 */
export function planScenarioGraph(args: {
  videoId: string
  shotKeys?: string[]
}): ScenarioGraphPlan {
  const { scenario, plan, cast, unknownRoles } = resolve(args.videoId, args.shotKeys)
  return {
    videoId: args.videoId,
    modelId: plan.modelId,
    shotCount: scenario.shots.length,
    build: plan.build.map((entry) => toPlanEntry(entry, cast)),
    alreadyBuilt: plan.alreadyBuilt,
    skipped: plan.skipped,
    unknownRoles
  }
}

/**
 * Realizes the scenario: one shot-preset node per shot, laid out in shot order,
 * with the scenario's roles cast onto the shots that name them — ONE undo step.
 */
export function buildGraphFromScenario(args: {
  videoId: string
  /** Defaults to every shot the scenario has that is not built yet. */
  shotKeys?: string[]
}): BuildGraphFromScenarioResult {
  const { plan, cast, unknownRoles } = resolve(args.videoId, args.shotKeys)

  const result: BuildGraphFromScenarioResult = {
    videoId: args.videoId,
    created: [],
    alreadyBuilt: plan.alreadyBuilt,
    skipped: plan.skipped,
    cast: [],
    unknownRoles
  }
  // Nothing to build: no history entry, so a second click costs no undo step.
  if (plan.build.length === 0) return result

  // The shots take one column, one row each, in shot order — the arrangement
  // the shared layout considers tidy, so "Tidy" is a no-op afterwards.
  const origin = graph.nextFreePosition(args.videoId)

  withGraphHistoryGroup(args.videoId, () => {
    const nodeIdsByRole = new Map<string, string[]>()

    plan.build.forEach((entry, index) => {
      const created = createRecipeNode({
        videoId: args.videoId,
        recipeId: entry.recipeId,
        modelId: entry.modelId,
        values: entry.values,
        key: entry.key,
        label: entry.title,
        durationSeconds: entry.seconds,
        position: { x: origin.x, y: origin.y + index * ROW_PITCH }
      })
      result.created.push({ nodeId: created.nodeId, key: entry.key, recipeId: entry.recipeId })
      for (const name of entry.roles) {
        const casting = cast.get(name.toLocaleLowerCase())
        if (!casting) continue
        nodeIdsByRole.set(casting.id, [...(nodeIdsByRole.get(casting.id) ?? []), created.nodeId])
      }
    })

    // Casting runs INSIDE the group, so the sheets, their wiring and the role
    // sentences are part of the same gesture as the shots they belong to.
    for (const [castingId, nodeIds] of nodeIdsByRole) {
      const applied = castRole({ videoId: args.videoId, castingId, nodeIds })
      result.cast.push({
        castingId,
        name: applied.name,
        nodeIds: [...applied.cast, ...applied.alreadyCast].map((entry) => entry.nodeId),
        skipped: applied.skipped
      })
    }
  })

  return result
}
