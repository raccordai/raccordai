import { describeParamsError, getModelOrThrow } from '@shared/models'
import { resolveDraftRun } from '@shared/models/draft'
import { getStyle, nodeAppliesVideoStyle, wrapPromptWithStyle } from '@shared/styles/registry'

/**
 * Draft substitution (§6.1) + params validation + style-at-payload (§6.9): the
 * exact composition prepareRun persists into the input snapshot, extracted so
 * preview_run_payload can show agents the FINAL prompt without running.
 *
 * Pure — no db, no Electron: this decides what is actually submitted to
 * kie.ai (and therefore billed), so it lives on its own and under test.
 *
 * Draft mode substitutes the model's declared draftEquivalent — resolved
 * BEFORE the input snapshot is persisted, so retries and re-queues replay the
 * substituted run, and the node's stored model/params stay untouched
 * (finalize passes forceFinal). Style-at-payload composes the video's CURRENT
 * art direction into the prompt of nodes flagged `applyVideoStyle`: stored
 * prompts stay business-only and a style change propagates on the next run.
 * Stills get the bible appended; MOVING IMAGES get the full sandwich (capture
 * declaration + compressed bible on top, booster stack at the bottom).
 */
export function composeRunParams(
  node: { modelId: string; params: unknown },
  video: { draftMode?: boolean | null; styleId?: string | null } | undefined,
  opts?: { forceFinal?: boolean }
): {
  model: ReturnType<typeof getModelOrThrow>
  validatedParams: unknown
  draftSub: ReturnType<typeof resolveDraftRun>
} {
  const nodeModel = getModelOrThrow(node.modelId)
  const draftSub =
    video?.draftMode && !opts?.forceFinal ? resolveDraftRun(nodeModel.id, node.params ?? {}) : null
  const model = draftSub ? getModelOrThrow(draftSub.modelId) : nodeModel

  let validatedParams: unknown
  try {
    validatedParams = model.paramsSchema.parse(draftSub ? draftSub.params : (node.params ?? {}))
  } catch (err) {
    // A raw zod dump is unreadable in the node's error badge — name the field
    // and what it accepts (the prompt lint says the same thing before the run).
    throw new Error(`Invalid params: ${describeParamsError(err, model)}`, { cause: err })
  }

  if (model.kind !== 'audio' && nodeAppliesVideoStyle(node.params)) {
    const style = video?.styleId ? getStyle(video.styleId) : undefined
    const prompt = (validatedParams as { prompt?: unknown }).prompt
    if (style && typeof prompt === 'string') {
      validatedParams = {
        ...(validatedParams as Record<string, unknown>),
        prompt: wrapPromptWithStyle({ prompt, style, kind: model.kind })
      }
    }
  }
  return { model, validatedParams, draftSub }
}
