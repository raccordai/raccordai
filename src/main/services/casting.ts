import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { getModel, type InputHandle } from '@shared/models'
import {
  planCasting,
  type CastingPlan,
  type CastingRole,
  type ShotForCasting
} from '@shared/casting'
import { getDb } from '../db/client'
import { assets, castings, edges, nodes } from '../db/schema'
import * as graph from './graph'
import { withGraphHistoryGroup } from './graphHistory'
import { getVideo } from './videos'

/**
 * Casting (§6.10) — the I/O half of `@shared/casting`.
 *
 * Owns the project's named identities (`castings`) and the one gesture that
 * makes them worth naming: casting a role onto a video's shots wires its sheet
 * as a reference on each of them AND writes the role's sentence into each
 * prompt, as ONE undo step. The user cast a role, they undo a role.
 *
 * This is `continuity.ts` for identity instead of continuity, and the shape is
 * deliberately the same: derive the handle from the model registry rather than
 * hardcoding a key, plan before mutating, and report what could not be wired in
 * `skipped` so one impossible shot never costs the rest of the cast.
 *
 * One difference matters. Continuity wires a different source into every target
 * (shot N-1 into shot N), so it creates nothing; a role has ONE sheet feeding
 * every shot, so the video needs a single `studio/asset` node to fan out from.
 * It is created on first cast and REUSED afterwards — including when it was
 * created by something else (a recipe's source node pointing at the same
 * asset), which is also what makes "already cast" detectable rather than a
 * duplicate wiring.
 */

type CastingRow = typeof castings.$inferSelect

/** A role, with the sheet's own markers resolved so callers never re-query. */
export interface Casting {
  id: string
  projectId: string
  name: string
  assetId: string
  notes: string | null
  createdAt: number
  updatedAt: number
  /** Display name of the sheet this role IS. */
  assetName: string
  /** `assets.design_id` — null when the role was pointed at a plain media asset. */
  designId: string | null
  designSubject: string | null
}

/** The model's reference handle for images: multiple, aliased, not an anchor. */
function referenceImageHandle(modelId: string): InputHandle | undefined {
  return getModel(modelId)?.inputs.find(
    (h) => !h.frameAnchor && h.accepts.includes('image') && (h.multiple ?? false)
  )
}

function toCasting(
  row: CastingRow,
  sheet: { assetName: string; designId: string | null; designSubject: string | null }
): Casting {
  return { ...row, ...sheet }
}

/** The row + its sheet in one query — every read path needs both. */
function selectCastings() {
  return getDb()
    .select({
      casting: castings,
      assetName: assets.name,
      designId: assets.designId,
      designSubject: assets.designSubject
    })
    .from(castings)
    .innerJoin(assets, eq(assets.id, castings.assetId))
}

export function listCastings(projectId: string): Casting[] {
  return selectCastings()
    .where(eq(castings.projectId, projectId))
    .orderBy(asc(castings.name))
    .all()
    .map((r) => toCasting(r.casting, r))
}

export function getCasting(id: string): Casting | null {
  const row = selectCastings().where(eq(castings.id, id)).get()
  return row ? toCasting(row.casting, row) : null
}

/** The role sentence's inputs, assembled from the casting and its sheet. */
function roleOf(casting: Casting): CastingRole {
  return {
    name: casting.name,
    ...(casting.designSubject ? { subject: casting.designSubject } : {}),
    ...(casting.designId ? { designId: casting.designId } : {}),
    ...(casting.notes ? { notes: casting.notes } : {})
  }
}

/**
 * A role name is an identifier the prompts carry, so it is normalized once
 * here: trimmed, collapsed whitespace, and unique within the project
 * case-insensitively — "Léa" and "léa" naming two different sheets would make
 * every cast prompt ambiguous.
 */
function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed === '') throw new Error('A role needs a name.')
  return trimmed
}

function assertNameFree(projectId: string, name: string, exceptId?: string): void {
  const clash = getDb()
    .select({ id: castings.id, name: castings.name })
    .from(castings)
    .where(eq(castings.projectId, projectId))
    .all()
    .find(
      (row) =>
        row.id !== exceptId &&
        row.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
    )
  if (clash) throw new Error(`This project already casts a role named "${clash.name}".`)
}

export function createCasting(args: {
  projectId: string
  name: string
  assetId: string
  notes?: string | null
}): Casting {
  const name = normalizeName(args.name)
  const asset = getDb().select().from(assets).where(eq(assets.id, args.assetId)).get()
  if (!asset) throw new Error(`Unknown assetId "${args.assetId}".`)
  if (asset.projectId !== args.projectId) {
    throw new Error('That sheet belongs to another project.')
  }
  if (asset.kind !== 'image') {
    throw new Error(`A role is cast from an image sheet — "${asset.name}" is ${asset.kind}.`)
  }
  assertNameFree(args.projectId, name)

  const now = Date.now()
  const row: CastingRow = {
    id: randomUUID(),
    projectId: args.projectId,
    name,
    assetId: args.assetId,
    notes: args.notes?.trim() || null,
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(castings).values(row).run()
  return toCasting(row, {
    assetName: asset.name,
    designId: asset.designId,
    designSubject: asset.designSubject
  })
}

export function updateCasting(
  id: string,
  patch: { name?: string; assetId?: string; notes?: string | null }
): Casting {
  const current = getCasting(id)
  if (!current) throw new Error(`Unknown castingId "${id}".`)

  const name = patch.name === undefined ? current.name : normalizeName(patch.name)
  if (name !== current.name) assertNameFree(current.projectId, name, id)

  if (patch.assetId !== undefined && patch.assetId !== current.assetId) {
    const asset = getDb().select().from(assets).where(eq(assets.id, patch.assetId)).get()
    if (!asset) throw new Error(`Unknown assetId "${patch.assetId}".`)
    if (asset.projectId !== current.projectId) {
      throw new Error('That sheet belongs to another project.')
    }
    if (asset.kind !== 'image') {
      throw new Error(`A role is cast from an image sheet — "${asset.name}" is ${asset.kind}.`)
    }
  }

  getDb()
    .update(castings)
    .set({
      name,
      ...(patch.assetId !== undefined ? { assetId: patch.assetId } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
      updatedAt: Date.now()
    })
    .where(eq(castings.id, id))
    .run()

  const updated = getCasting(id)
  if (!updated) throw new Error(`Unknown castingId "${id}".`)
  return updated
}

/**
 * Forgets the role. Nothing in the graph is touched: shots already cast keep
 * their reference and their role sentence, because deleting the casting sheet
 * from the film's index is not the same gesture as un-wiring seven shots — and
 * only the second one would cost the user their prompts.
 */
export function deleteCasting(id: string): void {
  getDb().delete(castings).where(eq(castings.id, id)).run()
}

// ── Casting a role onto a video's shots ──────────────────────────────────────

export interface CastRolePlanEntry {
  nodeId: string
  label: string
  alias: string
  /** The sentence that would be appended; empty when the prompt already has it. */
  role: string
}

export interface CastRolePlan {
  castingId: string
  name: string
  /** The node already carrying the sheet in this video — null until the first cast. */
  sourceNodeId: string | null
  cast: CastRolePlanEntry[]
  alreadyCast: Array<{ nodeId: string; label: string; alias: string }>
  skipped: Array<{ nodeId: string; label: string; reason: string }>
}

export interface CastRoleResult {
  castingId: string
  name: string
  /** The `studio/asset` node the sheet fans out from (created on first cast). */
  sourceNodeId: string
  cast: Array<{ nodeId: string; alias: string }>
  alreadyCast: Array<{ nodeId: string; alias: string }>
  skipped: Array<{ nodeId: string; reason: string }>
}

type NodeRow = typeof nodes.$inferSelect

const labelOf = (row: NodeRow): string => row.label ?? row.key

/** `params.assetId` of a `studio/asset` node, when that is what it is. */
function assetIdOf(row: NodeRow): string | undefined {
  if (row.modelId !== 'studio/asset') return undefined
  const value = (row.params as { assetId?: unknown } | null)?.assetId
  return typeof value === 'string' ? value : undefined
}

/**
 * Everything both the dry run and the apply need, resolved once: the role, the
 * shots it targets, the handle each one would use, and the plan.
 *
 * Targets default to the video's SHOTS (video-kind nodes). Explicit `nodeIds`
 * widen that on purpose — a storyboard or a shot board is built from the same
 * sheets and legitimately wants the role wired too — so an explicit id is only
 * rejected for not belonging to the video, never for not being a clip.
 */
function resolveCast(videoId: string, castingId: string, nodeIds?: string[]) {
  const casting = getCasting(castingId)
  if (!casting) throw new Error(`Unknown castingId "${castingId}".`)
  const video = getVideo(videoId)
  if (!video) throw new Error(`Unknown videoId "${videoId}".`)
  if (video.projectId !== casting.projectId) {
    throw new Error(`Role "${casting.name}" belongs to another project.`)
  }

  const db = getDb()
  const allNodes = db.select().from(nodes).where(eq(nodes.videoId, videoId)).all()
  const byId = new Map(allNodes.map((n) => [n.id, n]))

  let targets: NodeRow[]
  if (nodeIds && nodeIds.length > 0) {
    targets = nodeIds.map((id) => {
      const row = byId.get(id)
      if (!row) throw new Error(`Unknown nodeId "${id}" in this video.`)
      return row
    })
  } else {
    targets = allNodes.filter((n) => getModel(n.modelId)?.kind === 'video')
  }

  // The sheet may already be on the canvas — from an earlier cast, or as a
  // recipe's source node. Reusing it is what keeps a re-cast idempotent.
  const sourceNode = allNodes.find((n) => assetIdOf(n) === casting.assetId) ?? null

  const allEdges = db.select().from(edges).where(eq(edges.videoId, videoId)).all()
  /** The handle's connections, in the order that numbers their aliases. */
  const wiredTo = (nodeId: string, handleKey: string) =>
    allEdges
      .filter((e) => e.targetNodeId === nodeId && e.targetHandle === handleKey)
      .sort((a, b) => a.createdAt - b.createdAt)

  const skipped: Array<{ nodeId: string; label: string; reason: string }> = []
  const shots: ShotForCasting[] = []
  const handleByShot = new Map<string, InputHandle>()

  for (const target of targets) {
    const handle = referenceImageHandle(target.modelId)
    if (!handle) {
      skipped.push({
        nodeId: target.id,
        label: labelOf(target),
        reason:
          target.modelId === 'studio/asset'
            ? `"${labelOf(target)}" is a media node, not a shot.`
            : `"${labelOf(target)}" runs on ${target.modelId}, which has no reference-image input — on that model a role stays consistent by re-anchoring every shot on the same clean still instead.`
      })
      continue
    }
    handleByShot.set(target.id, handle)
    const wired = wiredTo(target.id, handle.key)
    // "Already cast" is asked of the SHEET, not of one particular node: any
    // asset node pointing at it counts, so a second pass never double-wires.
    const existingIndex = wired.findIndex((e) => {
      const source = byId.get(e.sourceNodeId)
      return source !== undefined && assetIdOf(source) === casting.assetId
    })
    shots.push({
      id: target.id,
      label: labelOf(target),
      existingRefs: { count: wired.length },
      ...(existingIndex >= 0 ? { alreadyCastAt: existingIndex + 1 } : {})
    })
  }

  // Planned shot by shot: the alias vocabulary and the budget belong to each
  // shot's OWN handle, and a sequence may legitimately mix models (Seedance 2
  // takes 9 reference images, another model may take 3).
  const role = roleOf(casting)
  const plan: CastingPlan = { links: [], skipped: [], alreadyCast: [] }
  for (const shot of shots) {
    const handle = handleByShot.get(shot.id)!
    const one = planCasting([shot], role, {
      alias: handle.referenceAlias ?? '@Image',
      ...(handle.maxCount !== undefined ? { maxCount: handle.maxCount } : {})
    })
    plan.links.push(...one.links)
    plan.skipped.push(...one.skipped)
    plan.alreadyCast.push(...one.alreadyCast)
  }

  return { casting, plan, shots, byId, handleByShot, sourceNode, skipped }
}

/**
 * What `castRole` would do, without touching anything — the editor shows this
 * before spending an undo step, and the assistant can report it before asking.
 */
export function planCastRole(args: {
  videoId: string
  castingId: string
  nodeIds?: string[]
}): CastRolePlan {
  const { casting, plan, byId, sourceNode, skipped } = resolveCast(
    args.videoId,
    args.castingId,
    args.nodeIds
  )
  const labelFor = (id: string) => labelOf(byId.get(id)!)
  return {
    castingId: casting.id,
    name: casting.name,
    sourceNodeId: sourceNode?.id ?? null,
    cast: plan.links.map((link) => ({
      nodeId: link.shotId,
      label: labelFor(link.shotId),
      alias: link.alias,
      role: promptOf(byId.get(link.shotId)!).includes(link.alias) ? '' : link.role
    })),
    alreadyCast: plan.alreadyCast.map((entry) => ({
      nodeId: entry.shotId,
      label: labelFor(entry.shotId),
      alias: entry.alias
    })),
    skipped: [
      ...skipped,
      ...plan.skipped.map((s) => ({
        nodeId: s.shotId,
        label: labelFor(s.shotId),
        reason: s.reason
      }))
    ]
  }
}

function promptOf(row: NodeRow): string {
  const value = (row.params as { prompt?: unknown } | null)?.prompt
  return typeof value === 'string' ? value : ''
}

/**
 * Wires the role's sheet onto each targeted shot and declares it in each
 * prompt, as ONE undo step — creating the video's asset node for the sheet if
 * this is the first cast.
 */
export function castRole(args: {
  videoId: string
  castingId: string
  nodeIds?: string[]
}): CastRoleResult {
  const { casting, plan, byId, handleByShot, sourceNode, skipped } = resolveCast(
    args.videoId,
    args.castingId,
    args.nodeIds
  )

  const result: CastRoleResult = {
    castingId: casting.id,
    name: casting.name,
    sourceNodeId: sourceNode?.id ?? '',
    cast: [],
    alreadyCast: plan.alreadyCast.map((e) => ({ nodeId: e.shotId, alias: e.alias })),
    skipped: [
      ...skipped.map((s) => ({ nodeId: s.nodeId, reason: s.reason })),
      ...plan.skipped.map((s) => ({ nodeId: s.shotId, reason: s.reason }))
    ]
  }

  // Nothing to wire: do not create the asset node, and do not open a history
  // group — a no-op cast must not cost the user an undo step.
  if (plan.links.length === 0) return result

  withGraphHistoryGroup(args.videoId, () => {
    const sourceNodeId =
      sourceNode?.id ??
      graph.createNode({
        videoId: args.videoId,
        modelId: 'studio/asset',
        params: { assetId: casting.assetId },
        label: casting.name,
        intent: `Cast as "${casting.name}"${casting.designSubject ? ` (${casting.designSubject})` : ''} — reference only, wired on every shot the role appears in.`
      }).id
    result.sourceNodeId = sourceNodeId

    for (const link of plan.links) {
      const target = byId.get(link.shotId)!
      const handle = handleByShot.get(link.shotId)!
      graph.connectNodes({
        videoId: args.videoId,
        sourceNodeId,
        sourceHandle: 'output',
        targetNodeId: target.id,
        targetHandle: handle.key
      })
      // A reference nobody addresses in the prompt only guides by accident —
      // the rule the lint enforces, applied at wiring time.
      const params = { ...((target.params as Record<string, unknown> | null) ?? {}) }
      const prompt = typeof params.prompt === 'string' ? params.prompt : ''
      if (!prompt.includes(link.alias)) {
        params.prompt = prompt.trim() ? `${prompt.trim()} ${link.role}` : link.role
        graph.updateNodeParams(target.id, params)
      }
      result.cast.push({ nodeId: target.id, alias: link.alias })
    }
  })

  return result
}

/** Roles pointing at this asset — the delete guard's counterpart for sheets. */
export function castingsUsingAsset(assetId: string): Casting[] {
  return selectCastings()
    .where(eq(castings.assetId, assetId))
    .all()
    .map((r) => toCasting(r.casting, r))
}

/** Roles of a project that are already on a video's canvas, by node id. */
export function castingsOnVideo(
  videoId: string,
  projectId: string
): Array<{ castingId: string; nodeId: string }> {
  const rows = getDb()
    .select()
    .from(nodes)
    .where(and(eq(nodes.videoId, videoId), eq(nodes.modelId, 'studio/asset')))
    .all()
  const byAsset = new Map(listCastings(projectId).map((c) => [c.assetId, c.id]))
  const found: Array<{ castingId: string; nodeId: string }> = []
  for (const row of rows) {
    const assetId = assetIdOf(row)
    const castingId = assetId ? byAsset.get(assetId) : undefined
    if (castingId) found.push({ castingId, nodeId: row.id })
  }
  return found
}
