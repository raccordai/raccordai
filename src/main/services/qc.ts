import { eq } from 'drizzle-orm'
import { getModel } from '@shared/models'
import type { QcVerdict } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { generations, nodes, videos } from '../db/schema'
import { broadcastGenerationsChanged } from '../events'
import { imageBlockFor } from './ai'
import { kieClaudeMessage, type ClaudeContentBlock } from './kie'
import { lintNodeById } from './lint'
import { logError } from './logger'
import {
  buildClipQcUserText,
  buildQcUserText,
  CLIP_QC_SYSTEM,
  foldLintIntoVerdict,
  imageReferenceUrls,
  isClipQcEligible,
  isQcEligible,
  parseQcVerdict,
  QC_SYSTEM
} from './qcPlan'
import { previewImageBase64, probeDurationSec } from './mediaPreview'

/**
 * Vision QC (§6.2) — the generation "linter": one cheap vision check on each
 * successful image generation (opt-in per video). Decisions live in qcPlan.ts
 * (pure, unit-tested); this module is the I/O half.
 */

/** Cheapest vision-capable model on kie.ai's Claude proxy. */
const QC_MODEL = 'claude-sonnet-5'
/** The settle event (and its queue slot) waits on QC — never let it hang. */
const QC_TIMEOUT_MS = 60_000
const MAX_REFERENCE_IMAGES = 4

export interface QcResult {
  verdict: QcVerdict
  notes: string
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`QC timed out after ${ms / 1000}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Run the vision check on one successful generation, persist the verdict on
 * the row and return it. Throws on non-reviewable targets (missing, not
 * successful, not an image model); a failing QC *call* is persisted and
 * returned as verdict 'error' instead of throwing.
 */
export async function reviewGeneration(generationId: string): Promise<QcResult> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen) throw new Error('Generation not found')
  if (gen.status !== 'success') throw new Error('Only successful generations can be reviewed')
  const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  const model = node ? getModel(node.modelId) : undefined
  if (!node || !isQcEligible(model?.kind)) {
    throw new Error('Vision QC only supports image generations for now')
  }

  let result: QcResult
  try {
    const outputUrl = gen.resultPath ? `media://generation/${gen.id}/result` : gen.resultUrl
    if (!outputUrl) throw new Error('Generation has no result media')
    const snapshot = gen.inputSnapshot as {
      params?: { prompt?: unknown }
      inputs?: Record<string, string[]>
    } | null
    const referenceUrls = Object.values(snapshot?.inputs ?? {})
      .flat()
      .slice(0, MAX_REFERENCE_IMAGES)
    const params = (node.params ?? {}) as { designId?: unknown; designSubject?: unknown }
    const prompt = snapshot?.params?.prompt
    const content: ClaudeContentBlock[] = [
      imageBlockFor(outputUrl),
      ...referenceUrls.map(imageBlockFor),
      {
        type: 'text',
        text: buildQcUserText({
          prompt: typeof prompt === 'string' ? prompt : '',
          referenceCount: referenceUrls.length,
          isStoryboard: params.designId === 'storyboard',
          designSubject: typeof params.designSubject === 'string' ? params.designSubject : null
        })
      }
    ]
    const reply = await withTimeout(
      kieClaudeMessage({ model: QC_MODEL, system: QC_SYSTEM, content }),
      QC_TIMEOUT_MS
    )
    // §6.5 — the prompt lint rides along in the same report: it catches what
    // the image cannot show (undeclared references, out-of-enum params).
    result = foldLintIntoVerdict(parseQcVerdict(reply), lintNodeById(node.id))
  } catch (err) {
    result = { verdict: 'error', notes: err instanceof Error ? err.message : String(err) }
  }

  db.update(generations)
    .set({ qcVerdict: result.verdict, qcNotes: result.notes || null })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
  return result
}

/**
 * The run engine's settle hook: QC only when the video opted in and the
 * generation is a reviewable image success. Returns null when QC doesn't
 * apply; never throws (a broken QC must never block the settle path).
 */
export async function maybeRunQcOnSettle(generationId: string): Promise<QcResult | null> {
  try {
    const db = getDb()
    const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
    if (!gen || gen.status !== 'success') return null
    const video = db.select().from(videos).where(eq(videos.id, gen.videoId)).get()
    if (!video?.qcEnabled) return null
    const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
    if (!node || !isQcEligible(getModel(node.modelId)?.kind)) return null
    return await reviewGeneration(generationId)
  } catch (err) {
    logError('qc', `settle hook failed for ${generationId}`, err)
    return null
  }
}

/**
 * Clip QC (review_clip): the video counterpart of reviewGeneration — samples
 * first/middle/last frames from the downloaded clip (local ffmpeg, task-1
 * plumbing) and asks the same cheap vision model for a verdict. Deliberately
 * NOT wired into the settle hook: clips are longer requests, so automatic QC
 * stays an image-only concern and clip review is an explicit call.
 */
export async function reviewClipGeneration(generationId: string): Promise<QcResult> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen) throw new Error('Generation not found')
  if (gen.status !== 'success') throw new Error('Only successful generations can be reviewed')
  const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  const nodeModel = node ? getModel(node.modelId) : undefined
  if (!node || !isClipQcEligible(nodeModel?.kind)) {
    throw new Error(
      'review_clip only supports video generations — use review_generation for images.'
    )
  }
  if (!gen.resultPath) {
    throw new Error(
      'The clip is not downloaded locally yet — call refresh_generation_status, then retry.'
    )
  }

  let result: QcResult
  try {
    const durationSec = await probeDurationSec(gen.resultPath)
    const seeks = [
      { atSec: 0 },
      ...(durationSec ? [{ atSec: durationSec / 2 }] : []),
      { fromEnd: true }
    ]
    const frames = await Promise.all(seeks.map((seek) => previewImageBase64(gen.resultPath!, seek)))

    const snapshot = gen.inputSnapshot as {
      modelId?: string
      params?: { prompt?: unknown }
      inputs?: Record<string, string[]>
    } | null
    // References against the SUBMITTED model's handles (draft substitution).
    const submittedModel = (snapshot?.modelId ? getModel(snapshot.modelId) : undefined) ?? nodeModel
    const referenceUrls = imageReferenceUrls(snapshot?.inputs, submittedModel).slice(
      0,
      MAX_REFERENCE_IMAGES
    )
    const prompt = snapshot?.params?.prompt
    const content: ClaudeContentBlock[] = [
      ...frames.map((data): ClaudeContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data }
      })),
      ...referenceUrls.map(imageBlockFor),
      {
        type: 'text',
        text: buildClipQcUserText({
          prompt: typeof prompt === 'string' ? prompt : '',
          frameCount: frames.length,
          referenceCount: referenceUrls.length,
          durationSec
        })
      }
    ]
    const reply = await withTimeout(
      kieClaudeMessage({ model: QC_MODEL, system: CLIP_QC_SYSTEM, content }),
      QC_TIMEOUT_MS
    )
    result = foldLintIntoVerdict(parseQcVerdict(reply), lintNodeById(node.id))
  } catch (err) {
    result = { verdict: 'error', notes: err instanceof Error ? err.message : String(err) }
  }

  db.update(generations)
    .set({ qcVerdict: result.verdict, qcNotes: result.notes || null })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
  return result
}
