import type { ModelDefinition } from './types'
import { gptImage2T2I } from './gpt-image-2-t2i'
import { gptImage2I2I } from './gpt-image-2-i2i'
import { nanoBananaPro } from './nano-banana-pro'
import { nanoBanana2 } from './nano-banana-2'
import { nanoBanana2Lite } from './nano-banana-2-lite'
import { seedance2 } from './seedance-2'
import { seedance2Fast } from './seedance-2-fast'
import { seedance2Mini } from './seedance-2-mini'
import { seedance15Pro } from './seedance-15-pro'
import { grokImagineI2V } from './grok-imagine-i2v'
import { grokImagineT2V } from './grok-imagine-t2v'
import { kling3 } from './kling-3'
import { sunoMusic } from './suno-music'

/**
 * Single source of truth for every model the studio supports.
 * Add a new model: create a file in this folder, then append it here.
 * The UI form, the kie.ai payload builder, and the LLM workflow doc all derive from this list.
 */
export const MODELS: ModelDefinition[] = [
  gptImage2T2I,
  gptImage2I2I,
  nanoBananaPro,
  nanoBanana2,
  nanoBanana2Lite,
  seedance2,
  seedance2Fast,
  seedance2Mini,
  seedance15Pro,
  kling3,
  grokImagineT2V,
  grokImagineI2V,
  sunoMusic
]

const MODEL_MAP = new Map<string, ModelDefinition>(MODELS.map((m) => [m.id, m]))

/**
 * Backward-compat aliases: old model ids that should resolve to their current
 * replacement. Lets workflows/nodes saved before a model upgrade keep running —
 * the canonical id (and the string sent to kie.ai) is always the target's `.id`.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Grok Imagine 1.5 preview → current Grok Imagine i2v. (The current model
  // reuses the historical 'grok-imagine/image-to-video' id, so Grok 1.0 nodes
  // resolve directly and the 1.0 → 1.5 alias is gone with the 1.5 model.)
  'grok-imagine-video-1-5-preview': 'grok-imagine/image-to-video'
}
for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
  const def = MODEL_MAP.get(target)
  if (def) MODEL_MAP.set(alias, def)
}

export function getModel(id: string): ModelDefinition | undefined {
  return MODEL_MAP.get(id)
}

export function getModelOrThrow(id: string): ModelDefinition {
  const m = MODEL_MAP.get(id)
  if (!m) throw new Error(`Unknown model: ${id}`)
  return m
}

/**
 * Indicative credit cost of running `modelId` with `params` (null when the
 * model declares no rates or the params don't validate). See
 * ModelDefinition.estimateCredits for the accuracy caveat.
 */
export function estimateCreditsFor(modelId: string, params: unknown): number | null {
  const model = getModel(modelId)
  if (!model?.estimateCredits) return null
  const parsed = model.paramsSchema.safeParse(params ?? {})
  if (!parsed.success) return null
  return model.estimateCredits(parsed.data)
}

export function defaultParamsFor(modelId: string): Record<string, unknown> {
  const m = getModelOrThrow(modelId)
  const defaults: Record<string, unknown> = {}
  for (const field of m.paramFields) {
    if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue
  }
  return defaults
}

/** Video-level defaults, mapped onto the param keys every model shares. */
const VIDEO_DEFAULT_PARAM_KEYS = [
  ['aspect_ratio', 'defaultAspectRatio'],
  ['resolution', 'defaultResolution']
] as const

/**
 * The subset of a video's default params that `modelId` actually supports: a
 * default is included only when the model declares the field AND lists the
 * value among its options (each model has its own aspect/resolution enums).
 * Unknown models (e.g. "studio/asset") get no defaults.
 */
export function videoDefaultParams(
  modelId: string,
  defaults: { defaultAspectRatio?: string | null; defaultResolution?: string | null } | null
): Record<string, unknown> {
  const m = getModel(modelId)
  if (!m || !defaults) return {}
  const params: Record<string, unknown> = {}
  for (const [paramKey, defaultKey] of VIDEO_DEFAULT_PARAM_KEYS) {
    const value = defaults[defaultKey]
    if (!value) continue
    const field = m.paramFields.find((f) => f.key === paramKey)
    if (field?.options?.some((o) => o.value === value)) params[paramKey] = value
  }
  return params
}

export type {
  ModelDefinition,
  InputHandle,
  OutputHandle,
  ParamField,
  ParamFieldType,
  MediaKind,
  ModelKind
} from './types'
