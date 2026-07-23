import type { z } from 'zod'

export type ModelKind = 'image' | 'video' | 'audio'

/**
 * Which kie.ai API a model is driven through.
 * - `jobs` (default): the unified `/api/v1/jobs/createTask` + `recordInfo` API.
 * - `suno`: the dedicated Suno music API (`/api/v1/generate` + `/api/v1/generate/record-info`),
 *   which has a flat request body and a different status/result shape.
 */
export type ModelProvider = 'jobs' | 'suno'

export type ParamFieldType = 'text' | 'textarea' | 'number' | 'select' | 'boolean'

export interface ParamField {
  key: string
  label: string
  type: ParamFieldType
  defaultValue?: unknown
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string }>
  description?: string
}

export type MediaKind = 'image' | 'video' | 'audio'

export interface InputHandle {
  /** The kie.ai input field name on the target side. Also used as the React Flow handle id. */
  key: string
  label: string
  accepts: MediaKind[]
  multiple?: boolean
  required?: boolean
  description?: string
  /**
   * If set, connected sources are addressable in the prompt as `${alias}${n}` (1-based).
   * Example: with `alias = "@Image"`, the first connected source is `@Image1`, the second `@Image2`, etc.
   * The numbering is the connection order (sorted by edge creation time on the server) and is shown in the UI.
   */
  referenceAlias?: string
  /** Hard upper bound on the number of connections to this handle. Run is rejected if exceeded. */
  maxCount?: number
  /**
   * True when connected images APPEAR in the output literally (first/last frame),
   * as opposed to reference inputs that only guide identity/style. Design sheets
   * (characters, décors, props) must never be wired to a frame anchor — the UI
   * warns and the template tests enforce it.
   */
  frameAnchor?: boolean
}

export interface OutputHandle {
  key: string
  label: string
  kind: ModelKind
}

export interface BuildPayloadArgs<TParams> {
  params: TParams
  /** Resolved input URLs keyed by InputHandle.key. */
  inputs: Record<string, string[]>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the MODELS registry mixes param shapes; `unknown` would force casts at every use site
export interface ModelDefinition<TParams = any> {
  /** kie.ai model identifier, e.g. "bytedance/seedance-2-fast". */
  id: string
  label: string
  description: string
  kind: ModelKind
  /** kie.ai API family. Defaults to `jobs` (the unified API) when omitted. */
  provider?: ModelProvider
  /** Output type is TParams; input type is permissive because we accept user/JSON-imported partial params. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paramsSchema: z.ZodType<TParams, any>
  paramFields: ParamField[]
  inputs: InputHandle[]
  outputs: OutputHandle[]
  buildPayload(args: BuildPayloadArgs<TParams>): Record<string, unknown>
  /**
   * Indicative kie.ai credit cost of one run with the given params.
   * These rates are maintained by hand from https://kie.ai/pricing — treat the
   * result as an order-of-magnitude estimate, the kie.ai dashboard is the
   * authority. Omit when no reliable rate is known (the UI then shows nothing).
   */
  estimateCredits?(params: TParams): number
  /**
   * Declarative use-case tags (kebab-case, e.g. "character-consistency",
   * "cheap-draft", "photorealism", "first-frame-animation"): surfaced as
   * badges + recommended sort in the add-node menu, in the assistant's
   * list_models and in the MCP models docs — the model-recommendation layer
   * (§4.7). Every model must declare at least one (registry test).
   */
  recommendedFor: string[]
  /** Free-form guidance shown in the node params panel and the LLM doc. */
  promptingNotes?: string
  /**
   * Long-form prompting guide (anatomy of a good prompt, camera vocabulary,
   * dialogue/audio syntax, pitfalls, full examples). Kept out of list_models
   * and the model doc — served on demand via the docs topic `prompting:<id>`
   * so agents fetch the depth only when they are about to write a prompt.
   */
  promptGuide?: string
}
