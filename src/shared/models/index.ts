import type { ModelDefinition } from './types'
import { gptImage2T2I } from './gpt-image-2-t2i'
import { gptImage2I2I } from './gpt-image-2-i2i'
import { seedance2Fast } from './seedance-2-fast'
import { seedance15Pro } from './seedance-15-pro'
import { grokImagineI2V } from './grok-imagine-i2v'
import { sunoMusic } from './suno-music'

/**
 * Single source of truth for every model the studio supports.
 * Add a new model: create a file in this folder, then append it here.
 * The UI form, the kie.ai payload builder, and the LLM workflow doc all derive from this list.
 */
export const MODELS: ModelDefinition[] = [
  gptImage2T2I,
  gptImage2I2I,
  seedance2Fast,
  seedance15Pro,
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
  // Grok Imagine 1.0 → 1.5 (the new default Grok video model).
  'grok-imagine/image-to-video': 'grok-imagine-video-1-5-preview'
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

export type {
  ModelDefinition,
  InputHandle,
  OutputHandle,
  ParamField,
  ParamFieldType,
  MediaKind,
  ModelKind
} from './types'
