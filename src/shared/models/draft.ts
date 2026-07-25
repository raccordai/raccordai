import { getModel, getModelOrThrow } from './index'

/**
 * Draft-mode substitution (§6.1) resolved for one run: the model id actually
 * submitted, the RAW params to validate against that model's schema, and the
 * input-handle key remap (original key → draft key, identity when absent).
 */
export interface DraftSubstitution {
  modelId: string
  params: Record<string, unknown>
  inputs: Record<string, string>
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * Resolve the draft substitution for a run of `modelId` with the node's raw
 * params. Returns null when the model declares no `draftEquivalent` — or when
 * the substitution would change nothing (same model, same params): such a run
 * is already at draft cost and must NOT be stamped `draft`, otherwise finalize
 * would pointlessly re-run it.
 *
 * The returned params are raw (unparsed): overlay of the node's params + the
 * declared overrides, with enum-valued fields the draft model doesn't accept
 * replaced by the draft model's default (e.g. resolution floored from 4k to
 * the draft tier's cap). Marker params (`applyVideoStyle`, `designId`) ride
 * along untouched — the draft model's zod schema strips them at parse, and the
 * engine reads them from the raw node params anyway.
 */
export function resolveDraftRun(modelId: string, rawParams: unknown): DraftSubstitution | null {
  const model = getModel(modelId)
  const draft = model?.draftEquivalent
  if (!model || !draft) return null
  const target = getModelOrThrow(draft.modelId)
  const base = (rawParams ?? {}) as Record<string, unknown>
  const params: Record<string, unknown> = { ...base, ...(draft.params ?? {}) }
  for (const field of target.paramFields) {
    if (!field.options) continue
    const value = params[field.key]
    if (value === undefined) continue
    if (!field.options.some((o) => o.value === value)) {
      if (field.defaultValue !== undefined) params[field.key] = field.defaultValue
      else delete params[field.key]
    }
  }
  if (target.id === model.id && shallowEqual(params, base)) return null
  return { modelId: target.id, params, inputs: draft.inputs ?? {} }
}

/**
 * Remap resolved input URLs (keyed by the ORIGINAL model's handle keys, as
 * wired by the graph's edges) onto the draft model's handles: renamed keys
 * follow the declared mapping, arrays are clamped to the draft handle's
 * maxCount, and inputs the draft model has no handle for are dropped.
 */
export function remapDraftInputs(
  substitution: DraftSubstitution,
  inputs: Record<string, string[]>
): Record<string, string[]> {
  const target = getModelOrThrow(substitution.modelId)
  const out: Record<string, string[]> = {}
  for (const [key, urls] of Object.entries(inputs)) {
    const mappedKey = substitution.inputs[key] ?? key
    const handle = target.inputs.find((h) => h.key === mappedKey)
    if (!handle) continue
    const merged = [...(out[mappedKey] ?? []), ...urls]
    out[mappedKey] = handle.maxCount !== undefined ? merged.slice(0, handle.maxCount) : merged
  }
  return out
}
