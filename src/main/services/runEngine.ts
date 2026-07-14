import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { desc, eq, inArray } from 'drizzle-orm'
import { estimateCreditsFor, getModel, getModelOrThrow } from '@shared/models'
import { getDb } from '../db/client'
import { assets, edges, generations, nodes, videos } from '../db/schema'
import { emitGenerationSettled, onGenerationSettled } from '../bus'
import { broadcastGenerationsChanged } from '../events'
import { mediaDirFor } from '../media/files'
import { GenerationQueue, isRetryableGenerationError, withRetry } from './genQueue'
import {
  kieCreateSunoTask,
  kieCreateTask,
  kieGetSunoStatus,
  kieGetTaskInfo,
  kieUploadFile,
  parseResultUrl
} from './kie'
import { type GenerationRow } from './generations'
import { getKieApiKey, getMaxConcurrentGenerations } from './settings'

/**
 * Local generation engine — port of convex/generations.ts onto the Electron
 * main process. Differences from the Convex original:
 *   - no public URL, so no webhook: the poller IS the completion path;
 *   - local input media (assets, last frames, downloaded results) is uploaded
 *     to kie.ai's temporary file host on demand, cached with a TTL;
 *   - successful results are downloaded into the local media store.
 */

const POLL_INTERVAL_MS = 15_000
const MAX_POLL_ATTEMPTS = 40 // ~10 min, matching the client-side wait cap
/** kie.ai deletes uploads after ~3 days; refresh well before that. */
const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000

/**
 * In-flight budget control: a slot is held from task submission until the
 * generation settles. The limit is a user setting (default 2).
 */
const queue = new GenerationQueue(getMaxConcurrentGenerations)
onGenerationSettled((event) => {
  queue.release(event.generationId)
  retryCounts.delete(event.generationId)
})

// ── Smart retry ───────────────────────────────────────────────────────────────
// kie failures are often transient (model overload, upstream 5xx): re-submit
// from the persisted snapshot a few seconds later, unless the error is
// permanent (content-policy violation, 4xx) — see isRetryableGenerationError.

const MAX_GENERATION_RETRIES = 3
const GENERATION_RETRY_DELAY_MS = 5_000
/** Attempts per generation id. In-memory: a restart resets the budget. */
const retryCounts = new Map<string, number>()

/** Annotates a terminal error with the retry history, if any. */
function withRetryNote(generationId: string, message: string): string {
  const n = retryCounts.get(generationId)
  return n ? `${message} (after ${n} automatic ${n > 1 ? 'retries' : 'retry'})` : message
}

/**
 * Re-submits a failed generation unless the error is permanent or the retry
 * budget is spent. Returns true when a retry was scheduled — the generation
 * then goes back to 'pending' WITHOUT settling, so it keeps its queue slot
 * (concurrency budget intact) and a restart mid-delay re-queues it from the
 * snapshot via resumePolling().
 */
function maybeScheduleRetry(generationId: string, errorMessage: string): boolean {
  if (!isRetryableGenerationError(errorMessage)) return false
  const attempt = (retryCounts.get(generationId) ?? 0) + 1
  if (attempt > MAX_GENERATION_RETRIES) return false
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen || gen.status === 'success' || gen.status === 'failed') return false

  retryCounts.set(generationId, attempt)
  db.update(generations)
    .set({ status: 'pending', kieTaskId: null })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
  console.warn(
    `[run-engine] generation ${generationId} failed ("${errorMessage}") — retry ${attempt}/${MAX_GENERATION_RETRIES} in ${GENERATION_RETRY_DELAY_MS / 1000}s`
  )

  setTimeout(() => {
    const fresh = getDb().select().from(generations).where(eq(generations.id, generationId)).get()
    // Cancelled or otherwise settled during the delay — drop the retry.
    if (!fresh || fresh.status !== 'pending') return
    const prep = prepFromSnapshot(fresh)
    if (!prep) {
      failGeneration(generationId, withRetryNote(generationId, errorMessage))
      return
    }
    // The slot is still held — submit directly instead of re-enqueueing.
    submitGeneration(generationId, prep).catch((err) =>
      failGeneration(generationId, err instanceof Error ? err.message : String(err))
    )
  }, GENERATION_RETRY_DELAY_MS)
  return true
}

type NodeRow = typeof nodes.$inferSelect

// ── Remote status (provider-normalized) ──────────────────────────────────────

async function checkRemoteStatus(
  modelId: string,
  kieTaskId: string
): Promise<{ state: 'success' | 'fail' | 'pending'; resultUrl?: string; failMsg?: string }> {
  const provider = getModel(modelId)?.provider ?? 'jobs'
  if (provider === 'suno') return kieGetSunoStatus(kieTaskId)

  const data = await kieGetTaskInfo(kieTaskId)
  if (data.state === 'success')
    return { state: 'success', resultUrl: parseResultUrl(data.resultJson) }
  if (data.state === 'fail') return { state: 'fail', failMsg: data.failMsg ?? undefined }
  return { state: 'pending' }
}

// ── Public input URLs (kie.ai must be able to fetch every input) ─────────────

function uploadFresh(url: string | null, at: number | null): string | null {
  return url && at && Date.now() - at < UPLOAD_TTL_MS ? url : null
}

async function publicUrlForAsset(assetId: string): Promise<string | null> {
  const db = getDb()
  const asset = db.select().from(assets).where(eq(assets.id, assetId)).get()
  if (!asset) return null
  if (asset.sourceUrl) return asset.sourceUrl
  if (!asset.filePath) return null

  const cached = uploadFresh(asset.uploadedUrl, asset.uploadedAt)
  if (cached) return cached
  const url = await kieUploadFile(asset.filePath, 'raccord/assets')
  db.update(assets)
    .set({ uploadedUrl: url, uploadedAt: Date.now() })
    .where(eq(assets.id, assetId))
    .run()
  return url
}

async function publicUrlForGeneration(
  gen: GenerationRow,
  sourceHandle: string
): Promise<string | null> {
  const db = getDb()
  if (sourceHandle === 'lastFrame') {
    if (!gen.lastFramePath) return null
    const cached = uploadFresh(gen.lastFrameUploadedUrl, gen.lastFrameUploadedAt)
    if (cached) return cached
    const url = await kieUploadFile(gen.lastFramePath, 'raccord/frames')
    db.update(generations)
      .set({ lastFrameUploadedUrl: url, lastFrameUploadedAt: Date.now() })
      .where(eq(generations.id, gen.id))
      .run()
    return url
  }

  // Main output: the kie.ai CDN URL is directly fetchable by kie itself.
  if (gen.resultUrl) return gen.resultUrl
  if (!gen.resultPath) return null
  const cached = uploadFresh(gen.resultUploadedUrl, gen.resultUploadedAt)
  if (cached) return cached
  const url = await kieUploadFile(gen.resultPath, 'raccord/results')
  db.update(generations)
    .set({ resultUploadedUrl: url, resultUploadedAt: Date.now() })
    .where(eq(generations.id, gen.id))
    .run()
  return url
}

/**
 * Public URL of a source node's output for a run (strict: model nodes need an
 * explicitly selected successful generation, matching the Convex original).
 */
async function resolveRunInputUrl(node: NodeRow, sourceHandle: string): Promise<string | null> {
  if (node.modelId === 'studio/asset') {
    if (sourceHandle !== 'output') return null
    const assetId = (node.params as { assetId?: string } | undefined)?.assetId
    if (!assetId) return null
    return publicUrlForAsset(assetId)
  }

  if (!node.selectedGenerationId) return null
  const gen = getDb()
    .select()
    .from(generations)
    .where(eq(generations.id, node.selectedGenerationId))
    .get()
  if (!gen || gen.status !== 'success') return null
  return publicUrlForGeneration(gen, sourceHandle)
}

// ── Prepare ──────────────────────────────────────────────────────────────────

interface PreparedRun {
  videoId: string
  modelId: string
  provider: 'jobs' | 'suno'
  payload: Record<string, unknown>
  inputSnapshot: {
    params: unknown
    inputs: Record<string, string[]>
    aliases: Record<string, string>
  }
}

async function prepareRun(nodeId: string): Promise<PreparedRun> {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) throw new Error('Node not found')
  if (node.modelId === 'studio/asset') throw new Error('Asset nodes are not runnable')

  const model = getModelOrThrow(node.modelId)

  let validatedParams: unknown
  try {
    validatedParams = model.paramsSchema.parse(node.params ?? {})
  } catch (err) {
    throw new Error(`Invalid params: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err
    })
  }

  const incomingForNode = db
    .select()
    .from(edges)
    .where(eq(edges.targetNodeId, nodeId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt)

  const inputUrls: Record<string, string[]> = {}
  const aliasMap: Record<string, string> = {}

  for (const edge of incomingForNode) {
    const source = db.select().from(nodes).where(eq(nodes.id, edge.sourceNodeId)).get()
    if (!source) throw new Error(`Source node ${edge.sourceNodeId} missing`)
    const url = await resolveRunInputUrl(source, edge.sourceHandle)
    if (!url) {
      const hint =
        edge.sourceHandle === 'lastFrame'
          ? ` (lastFrame may still be extracting — wait a moment and retry)`
          : ` — run or select an output on the upstream node first.`
      throw new Error(
        `Input "${edge.targetHandle}" has no resolvable source from "${source.label ?? source.key}.${edge.sourceHandle}"${hint}`
      )
    }
    const bucket = (inputUrls[edge.targetHandle] ??= [])
    bucket.push(url)
    const handle = model.inputs.find((h) => h.key === edge.targetHandle)
    if (handle?.referenceAlias) {
      aliasMap[`${handle.referenceAlias}${bucket.length}`] = source.key
    }
  }

  for (const handle of model.inputs) {
    const count = inputUrls[handle.key]?.length ?? 0
    if (handle.required && count === 0) {
      throw new Error(`Required input "${handle.key}" is not connected`)
    }
    if (handle.maxCount !== undefined && count > handle.maxCount) {
      throw new Error(
        `Input "${handle.key}" exceeds max connections (${count} > ${handle.maxCount})`
      )
    }
  }

  const payload = model.buildPayload({ params: validatedParams as never, inputs: inputUrls })

  return {
    videoId: node.videoId,
    modelId: model.id,
    provider: model.provider ?? 'jobs',
    payload,
    inputSnapshot: { params: validatedParams, inputs: inputUrls, aliases: aliasMap }
  }
}

// ── Claim (dedup) ────────────────────────────────────────────────────────────

function claimRun(
  nodeId: string,
  videoId: string,
  inputSnapshot: unknown,
  reuseSatisfied: boolean,
  creditsEstimated: number | null
): { generationId: string; reused: boolean; kieTaskId: string | null } {
  const db = getDb()
  const rows = db
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()

  const inFlight = rows.find((g) => g.status === 'running' || g.status === 'pending')
  if (inFlight) return { generationId: inFlight.id, reused: true, kieTaskId: inFlight.kieTaskId }

  if (reuseSatisfied) {
    const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
    const selected = node?.selectedGenerationId
      ? rows.find((g) => g.id === node.selectedGenerationId)
      : undefined
    const success =
      selected?.status === 'success' ? selected : rows.find((g) => g.status === 'success')
    if (success) return { generationId: success.id, reused: true, kieTaskId: success.kieTaskId }
  }

  const generationId = randomUUID()
  db.insert(generations)
    .values({
      id: generationId,
      nodeId,
      videoId,
      // 'pending' = claimed and queued; flips to 'running' at submission time.
      status: 'pending',
      inputSnapshot,
      creditsEstimated,
      createdAt: Date.now()
    })
    .run()
  return { generationId, reused: false, kieTaskId: null }
}

// ── Completion + local media download ────────────────────────────────────────

function extForContentType(contentType: string | null, fallbackUrl: string): string {
  const mime = contentType?.split(';')[0]?.trim() ?? ''
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/mp4': '.m4a'
  }
  if (byMime[mime]) return byMime[mime]
  const urlExt = extname(new URL(fallbackUrl).pathname)
  return urlExt || '.bin'
}

/** Downloads the kie.ai result into the managed media store (fire-and-forget). */
async function downloadResult(generationId: string): Promise<void> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen?.resultUrl || gen.resultPath) return
  const video = db.select().from(videos).where(eq(videos.id, gen.videoId)).get()
  if (!video) return

  const res = await fetch(gen.resultUrl)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const contentType = res.headers.get('content-type')
  const target = join(
    mediaDirFor(video.projectId),
    `gen-${gen.id}${extForContentType(contentType, gen.resultUrl)}`
  )
  writeFileSync(target, new Uint8Array(await res.arrayBuffer()))
  db.update(generations)
    .set({ resultPath: target, resultMimeType: contentType?.split(';')[0]?.trim() ?? null })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
}

function completeFromKie(
  generationId: string,
  state: 'success' | 'fail',
  resultUrl?: string,
  failMsg?: string
): { transitioned: boolean } {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen) return { transitioned: false }
  if (gen.status === 'success' || gen.status === 'failed') return { transitioned: false }

  if (state === 'success') {
    db.update(generations)
      .set({ status: 'success', resultUrl: resultUrl ?? null, completedAt: Date.now() })
      .where(eq(generations.id, generationId))
      .run()
    // Auto-select if the node has no current selection.
    const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
    if (node && !node.selectedGenerationId) {
      db.update(nodes)
        .set({ selectedGenerationId: generationId, updatedAt: Date.now() })
        .where(eq(nodes.id, node.id))
        .run()
    }
    downloadResult(generationId).catch((err) => {
      console.error(`[run-engine] media download failed for ${generationId}`, err)
    })
  } else {
    db.update(generations)
      .set({
        status: 'failed',
        errorMessage: failMsg ?? 'kie.ai task failed',
        completedAt: Date.now()
      })
      .where(eq(generations.id, generationId))
      .run()
  }
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
  emitGenerationSettled({
    generationId,
    videoId: gen.videoId,
    nodeId: gen.nodeId,
    status: state === 'success' ? 'success' : 'failed',
    errorMessage: state === 'success' ? null : (failMsg ?? 'kie.ai task failed')
  })
  return { transitioned: true }
}

function failGeneration(generationId: string, errorMessage: string): void {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  db.update(generations)
    .set({ status: 'failed', errorMessage, completedAt: Date.now() })
    .where(eq(generations.id, generationId))
    .run()
  if (gen) {
    broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
    emitGenerationSettled({
      generationId,
      videoId: gen.videoId,
      nodeId: gen.nodeId,
      status: 'failed',
      errorMessage
    })
  }
}

// ── Poller (the completion path — no webhook on desktop) ─────────────────────

const pollTimers = new Map<string, NodeJS.Timeout>()

function schedulePoll(generationId: string, attempt: number, delayMs = POLL_INTERVAL_MS): void {
  clearTimeout(pollTimers.get(generationId))
  pollTimers.set(
    generationId,
    setTimeout(() => {
      pollGeneration(generationId, attempt).catch((err) =>
        console.error(`[run-engine] poll crashed for ${generationId}`, err)
      )
    }, delayMs)
  )
}

async function pollGeneration(generationId: string, attempt: number): Promise<void> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen || gen.status === 'success' || gen.status === 'failed' || !gen.kieTaskId) {
    pollTimers.delete(generationId)
    return
  }
  const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  if (!node) {
    pollTimers.delete(generationId)
    return
  }

  let result: Awaited<ReturnType<typeof checkRemoteStatus>> | undefined
  try {
    result = await checkRemoteStatus(node.modelId, gen.kieTaskId)
  } catch {
    result = undefined // transient — reschedule below
  }

  if (result?.state === 'success') {
    completeFromKie(generationId, 'success', result.resultUrl)
    pollTimers.delete(generationId)
    return
  }
  if (result?.state === 'fail') {
    pollTimers.delete(generationId)
    const failMsg = result.failMsg ?? 'kie.ai task failed'
    if (!maybeScheduleRetry(generationId, failMsg)) {
      completeFromKie(generationId, 'fail', undefined, withRetryNote(generationId, failMsg))
    }
    return
  }
  if (attempt >= MAX_POLL_ATTEMPTS) {
    completeFromKie(
      generationId,
      'fail',
      undefined,
      `Timed out after ${Math.round((MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000)}s with no result from kie.ai.`
    )
    pollTimers.delete(generationId)
    return
  }
  schedulePoll(generationId, attempt + 1)
}

/**
 * Called at startup: pick up generations that were in flight when the app
 * quit. Rows already submitted resume polling (occupying a queue slot); rows
 * claimed but never submitted are re-queued from their input snapshot, so a
 * restart mid-queue loses nothing.
 */
export function resumePolling(): void {
  const rows = getDb()
    .select()
    .from(generations)
    .where(inArray(generations.status, ['running', 'pending']))
    .all()
  for (const gen of rows) {
    if (gen.kieTaskId) {
      queue.adopt(gen.id)
      schedulePoll(gen.id, 1, 2000)
    } else {
      resubmitFromSnapshot(gen)
    }
  }
  if (rows.length > 0) console.log(`[run-engine] resumed ${rows.length} in-flight generation(s)`)
}

/** Rebuilds a ready-to-submit run from a generation's persisted input snapshot. */
function prepFromSnapshot(gen: GenerationRow): PreparedRun | null {
  const node = getDb().select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  const snapshot = gen.inputSnapshot as PreparedRun['inputSnapshot'] | null
  const model = node ? getModel(node.modelId) : undefined
  if (!node || !model || !snapshot?.params) return null
  return {
    videoId: gen.videoId,
    modelId: model.id,
    provider: model.provider ?? 'jobs',
    payload: model.buildPayload({
      params: snapshot.params as never,
      inputs: snapshot.inputs ?? {}
    }),
    inputSnapshot: snapshot
  }
}

/** Rebuilds the kie.ai payload from the persisted snapshot and re-queues the run. */
function resubmitFromSnapshot(gen: GenerationRow): void {
  const prep = prepFromSnapshot(gen)
  if (!prep) {
    failGeneration(gen.id, 'Interrupted by app restart before submission.')
    return
  }
  queue.enqueue(gen.id, () => submitGeneration(gen.id, prep))
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Submits a claimed generation to kie.ai (with retry) and starts its poller. */
async function submitGeneration(generationId: string, prep: PreparedRun): Promise<void> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  // Cancelled (or otherwise settled) while waiting in the queue — nothing to do.
  if (!gen || gen.status === 'success' || gen.status === 'failed') return

  db.update(generations).set({ status: 'running' }).where(eq(generations.id, generationId)).run()
  broadcastGenerationsChanged({ videoId: prep.videoId, nodeId: gen.nodeId })

  let kieTaskId: string
  try {
    kieTaskId =
      prep.provider === 'suno'
        ? // The Suno client retries internally (its API 500s more often).
          await kieCreateSunoTask({ input: prep.payload })
        : await withRetry(() => kieCreateTask({ model: prep.modelId, input: prep.payload }), {
            attempts: 3,
            baseDelayMs: 2000,
            // createTask surfaces the kie code in the message; 4xx codes won't heal.
            isTransient: (err) => !/\((4\d\d)\)/.test(err instanceof Error ? err.message : '')
          })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!maybeScheduleRetry(generationId, msg)) {
      failGeneration(generationId, withRetryNote(generationId, msg))
    }
    return
  }

  db.update(generations).set({ kieTaskId }).where(eq(generations.id, generationId)).run()
  schedulePoll(generationId, 1)
}

export async function runNode(
  nodeId: string,
  reuseSatisfied = false
): Promise<{ generationId: string; kieTaskId: string }> {
  // Fail fast on the one config error the user can fix immediately — every
  // other submission error surfaces asynchronously on the generation row.
  if (!getKieApiKey()) {
    throw new Error(
      "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."
    )
  }
  const prep = await prepareRun(nodeId)

  const estimate = estimateCreditsFor(prep.modelId, prep.inputSnapshot.params)
  const claim = claimRun(nodeId, prep.videoId, prep.inputSnapshot, reuseSatisfied, estimate)
  if (claim.reused) return { generationId: claim.generationId, kieTaskId: claim.kieTaskId ?? '' }
  const generationId = claim.generationId
  broadcastGenerationsChanged({ videoId: prep.videoId, nodeId })

  // Queued: submission happens when a concurrency slot frees up. The task id
  // is therefore not known yet — callers track the generation id.
  queue.enqueue(generationId, () => submitGeneration(generationId, prep))
  return { generationId, kieTaskId: '' }
}

export async function refreshStatus(nodeId: string): Promise<{ status: string }> {
  const db = getDb()
  const rows = db
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()
  const gen = rows.find((g) => g.status === 'running' || g.status === 'pending')
  if (!gen) return { status: 'none' }
  if (!gen.kieTaskId) return { status: gen.status }
  const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  if (!node) return { status: gen.status }

  let result: Awaited<ReturnType<typeof checkRemoteStatus>>
  try {
    result = await checkRemoteStatus(node.modelId, gen.kieTaskId)
  } catch (err) {
    throw new Error(
      `kie.ai status check failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }

  if (result.state === 'success') {
    completeFromKie(gen.id, 'success', result.resultUrl)
    return { status: 'success' }
  }
  if (result.state === 'fail') {
    const failMsg = result.failMsg ?? 'kie.ai task failed'
    if (maybeScheduleRetry(gen.id, failMsg)) return { status: 'pending' }
    completeFromKie(gen.id, 'fail', undefined, withRetryNote(gen.id, failMsg))
    return { status: 'failed' }
  }
  return { status: gen.status }
}

export function cancelGeneration(nodeId: string): { cancelled: boolean } {
  const rows = getDb()
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()
  const gen = rows.find((g) => g.status === 'running' || g.status === 'pending')
  if (!gen) return { cancelled: false }
  failGeneration(gen.id, 'Cancelled by user.')
  return { cancelled: true }
}

/** Attach the client-extracted last frame (JPEG) to a generation. */
export function setLastFrame(generationId: string, jpegBase64: string): void {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen || gen.lastFramePath) return
  const video = db.select().from(videos).where(eq(videos.id, gen.videoId)).get()
  if (!video) return
  const target = join(mediaDirFor(video.projectId), `frame-${gen.id}.jpg`)
  writeFileSync(target, Buffer.from(jpegBase64, 'base64'))
  db.update(generations)
    .set({ lastFramePath: target })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
}
