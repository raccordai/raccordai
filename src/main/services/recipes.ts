import { eq } from 'drizzle-orm'
import {
  defaultModeOf,
  getRecipe,
  recipeIntent,
  recipeModelChoices,
  recipeNodeParams,
  resolveRecipeHandle,
  type Recipe,
  type RecipeMode,
  type RecipeValues
} from '@shared/designs/registry'
import { getStyle } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { nodes } from '../db/schema'
import * as graph from './graph'
import { withGraphHistoryGroup } from './graphHistory'
import { getAsset } from './assets'
import { getVideo } from './videos'

/**
 * Recipe nodes — the single creation path for every pre-configured node
 * (design sheets AND shot presets), shared by the editor's add-node form
 * (IPC `recipes:createNode`) and by the agents (`add_recipe_node`).
 *
 * It lives in main, not in the renderer hook it grew out of, for two reasons:
 * the knowledge of what a recipe produces must reach the agent tools without a
 * copy, and creating a node WITH its source wired is a composite gesture that
 * has to land as ONE undo step — which only the graph history can guarantee.
 */

export interface CreateRecipeNodeArgs {
  videoId: string
  recipeId: string
  /** Defaults to the recipe's first mode. */
  modeId?: string
  /** Overrides the mode's model — must be one of the recipe's supportedModels. */
  modelId?: string
  values: RecipeValues
  /** The media feeding a `from-image`/`from-video` mode. Exactly one of the two. */
  source?: { assetId?: string; nodeId?: string }
  position?: { x: number; y: number }
  /**
   * Node key. Left out, the graph assigns a random one; the scenario builder
   * (§6.11) passes the shot's own key so the graph and the shot list stay
   * readable together — and so a second build recognizes what it already made.
   */
  key?: string
  /** Overrides the label built from the recipe and its subject (a shot title). */
  label?: string
  /** Overrides the recipe's default clip length — see `recipeNodeParams`. */
  durationSeconds?: number
}

export interface CreateRecipeNodeResult {
  nodeId: string
  modelId: string
  modeId: string
  prompt: string
  /** The node the source was wired from — a freshly created asset node, or an existing one. */
  sourceNodeId: string | null
  /** The input handle the source landed on, derived from the model registry. */
  handleKey: string | null
}

/** Left-of-the-node column for the asset node a `from-*` mode creates. */
const SOURCE_OFFSET_X = 420

function resolveMode(recipe: Recipe, modeId: string | undefined): RecipeMode {
  if (modeId === undefined) return defaultModeOf(recipe)
  const mode = recipe.modes.find((m) => m.id === modeId)
  if (!mode) {
    throw new Error(
      `Unknown mode "${modeId}" for recipe "${recipe.id}" (${recipe.modes.map((m) => m.id).join(', ')}).`
    )
  }
  return mode
}

export function createRecipeNode(args: CreateRecipeNodeArgs): CreateRecipeNodeResult {
  const recipe = getRecipe(args.recipeId)
  if (!recipe) throw new Error(`Unknown recipe "${args.recipeId}".`)
  const mode = resolveMode(recipe, args.modeId)
  const modelId = args.modelId ?? mode.modelId
  const choices = recipeModelChoices(recipe, mode)
  if (!choices.includes(modelId)) {
    throw new Error(
      `Recipe "${recipe.id}" in mode "${mode.id}" runs on ${choices.join(', ')} — not "${modelId}".`
    )
  }
  const video = getVideo(args.videoId)
  if (!video) throw new Error(`Unknown videoId "${args.videoId}".`)

  for (const field of recipe.fields) {
    if (!field.required) continue
    if ((args.values[field.key] ?? '').trim() === '') {
      throw new Error(`Recipe "${recipe.id}" requires a "${field.key}".`)
    }
  }

  // The source handle is derived from the model's declared semantics, never
  // hardcoded: the same recipe runs on models that name their inputs
  // differently (Seedance 1.5 `input_urls` vs Seedance 2 `first_frame_url`).
  const handle = mode.source ? resolveRecipeHandle(modelId, mode.source) : undefined
  if (mode.source && !handle) {
    throw new Error(
      `Model "${modelId}" has no ${mode.source.role} input accepting ${mode.source.accepts} — recipe "${recipe.id}" cannot run in mode "${mode.id}" on it.`
    )
  }
  const sourceRef = args.source?.assetId ?? args.source?.nodeId
  if (mode.source?.required && !sourceRef) {
    throw new Error(
      `Recipe "${recipe.id}" in mode "${mode.id}" needs a source ${mode.source.accepts}.`
    )
  }
  if (args.source?.assetId && args.source.nodeId) {
    throw new Error('Give a source asset OR a source node, not both.')
  }

  const style = video.styleId ? getStyle(video.styleId) : undefined
  const params = recipeNodeParams({
    recipe,
    mode,
    modelId,
    values: args.values,
    ...(style ? { style } : {}),
    videoDefaults: video,
    ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {})
  })
  const subject = (args.values.description ?? '').trim()
  const name = recipe.label
  const position = args.position ?? graph.nextFreePosition(args.videoId)

  // Existing source node: validate before opening the history group so a bad
  // reference never leaves a half-built gesture in the journal.
  let existingSource: { id: string; label: string | null; key: string } | null = null
  if (args.source?.nodeId) {
    const row = getDb()
      .select({ id: nodes.id, label: nodes.label, key: nodes.key, videoId: nodes.videoId })
      .from(nodes)
      .where(eq(nodes.id, args.source.nodeId))
      .get()
    if (!row) throw new Error(`Unknown source nodeId "${args.source.nodeId}".`)
    if (row.videoId !== args.videoId) {
      throw new Error(`Source node "${args.source.nodeId}" does not belong to this video.`)
    }
    existingSource = { id: row.id, label: row.label, key: row.key }
  }
  const asset = args.source?.assetId ? getAsset(args.source.assetId) : null
  if (args.source?.assetId && !asset) {
    throw new Error(`Unknown source assetId "${args.source.assetId}".`)
  }

  // Create (+ create the asset node) + wire is ONE gesture for the user, so it
  // is ONE undo step — the same rule the annotation fix node follows.
  const created = withGraphHistoryGroup(args.videoId, () => {
    let sourceNodeId = existingSource?.id ?? null
    if (asset) {
      sourceNodeId = graph.createNode({
        videoId: args.videoId,
        modelId: 'studio/asset',
        position: { x: position.x - SOURCE_OFFSET_X, y: position.y },
        params: { assetId: asset.id },
        label: asset.name,
        intent: `Source for "${name}"${asset.designSubject ? ` (${asset.designSubject})` : ''}.`
      }).id
    }
    const node = graph.createNode({
      videoId: args.videoId,
      modelId,
      position,
      params,
      ...(args.key !== undefined ? { key: args.key } : {}),
      label: args.label ?? (subject ? `${name} — ${subject.slice(0, 40)}` : name),
      intent: recipeIntent(recipe, args.values)
    })
    if (sourceNodeId && handle) {
      graph.connectNodes({
        videoId: args.videoId,
        sourceNodeId,
        sourceHandle: 'output',
        targetNodeId: node.id,
        targetHandle: handle.key
      })
    }
    return { node, sourceNodeId }
  })

  return {
    nodeId: created.node.id,
    modelId,
    modeId: mode.id,
    prompt: String(params.prompt ?? ''),
    sourceNodeId: handle ? created.sourceNodeId : null,
    handleKey: created.sourceNodeId && handle ? handle.key : null
  }
}
