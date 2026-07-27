import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { describeParamsError, estimateCreditsFor, getModel, getModelOrThrow } from '@shared/models'
import { remapDraftInputs, resolveDraftRun } from '@shared/models/draft'
import { appendStyleBible, getStyle, nodeAppliesVideoStyle } from '@shared/styles/registry'
import { getDb } from '../db/client'
import { assets, edges, generations, nodes, videos } from '../db/schema'
import { emitGenerationSettled, onGenerationSettled } from '../bus'
import {
  broadcastCreditsChanged,
  broadcastGenerationsChanged,
  broadcastQueueChanged
} from '../events'
import { mediaDirFor, mimeTypeFor } from '../media/files'
import { GenerationQueue, isRetryableGenerationError, withRetry } from './genQueue'
import { clampVariants } from './runPlanner'
import {
  kieCreateSunoTask,
  kieCreateTask,
  kieGetSunoStatus,
  kieGetTaskInfo,
  kieUploadFile,
  parseResultUrl
} from './kie'
import { type GenerationRow } from './generations'
import { maybeRunQcOnSettle } from './qc'
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
const queue = new GenerationQueue(getMaxConcurrentGenerations, broadcastQueueChanged)
onGenerationSettled((event) => {
  queue.release(event.generationId)
  retryCounts.delete(event.generationId)
  broadcastQueueChanged()
  broadcastCreditsChanged()
})

/** Queue + retry visibility for the renderer (generations:queueState). */
export function queueState(): {
  running: string[]
  queued: string[]
  limit: number
  retrying: Record<string, number>
} {
  return {
    ...queue.snapshot(),
    limit: getMaxConcurrentGenerations(),
    retrying: Object.fromEntries(retryCounts)
  }
}

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
  // The attempt counter is part of the queue-state payload the UI polls.
  broadcastQueueChanged()
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
  // Keep the failCode in the message: it is what lets isRetryableGenerationError
  // classify remote 4xx rejections (bad inputs) as permanent instead of retrying.
  if (data.state === 'fail') {
    const failMsg =
      [data.failCode ? `(${data.failCode})` : null, data.failMsg].filter(Boolean).join(' ') ||
      undefined
    return { state: 'fail', failMsg }
  }
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

/** How long a run waits for the renderer's last-frame extraction to land. */
const LAST_FRAME_WAIT_MS = 45_000
const LAST_FRAME_POLL_MS = 500

/**
 * The last frame is extracted by the renderer (browser-side video decode)
 * shortly AFTER the upstream generation succeeds — a downstream run launched
 * right away (chained runs, eager user) races it. Poll the row instead of
 * failing the run outright.
 */
async function waitForLastFramePath(generationId: string): Promise<string | null> {
  const deadline = Date.now() + LAST_FRAME_WAIT_MS
  while (Date.now() < deadline) {
    const row = getDb().select().from(generations).where(eq(generations.id, generationId)).get()
    if (!row || row.status !== 'success') return null
    if (row.lastFramePath) return row.lastFramePath
    await new Promise((resolve) => setTimeout(resolve, LAST_FRAME_POLL_MS))
  }
  return null
}

async function publicUrlForGeneration(
  gen: GenerationRow,
  sourceHandle: string
): Promise<string | null> {
  const db = getDb()
  if (sourceHandle === 'lastFrame') {
    const lastFramePath = gen.lastFramePath ?? (await waitForLastFramePath(gen.id))
    if (!lastFramePath) return null
    const cached = uploadFresh(gen.lastFrameUploadedUrl, gen.lastFrameUploadedAt)
    if (cached) return cached
    const url = await kieUploadFile(lastFramePath, 'raccord/frames')
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
  /** True when the run was substituted to the model's draftEquivalent (§6.1). */
  draft: boolean
  payload: Record<string, unknown>
  inputSnapshot: {
    /** The SUBMITTED model id (the draft one under draft mode) — replay-identical retries. */
    modelId: string
    params: unknown
    inputs: Record<string, string[]>
    aliases: Record<string, string>
  }
}

async function prepareRun(nodeId: string, opts?: { forceFinal?: boolean }): Promise<PreparedRun> {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) throw new Error('Node not found')
  if (node.modelId === 'studio/asset') throw new Error('Asset nodes are not runnable')

  const nodeModel = getModelOrThrow(node.modelId)
  const video = db.select().from(videos).where(eq(videos.id, node.videoId)).get()

  // Draft mode (§6.1): substitute the model's declared draftEquivalent — same
  // mechanic as style-at-payload below: resolved BEFORE the input snapshot is
  // persisted, so retries and re-queues replay the substituted run, and the
  // node's stored model/params stay untouched. Finalize passes forceFinal.
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

  // Style-at-payload: nodes flagged `applyVideoStyle` get the video's CURRENT
  // style bible appended to their prompt here — before the input snapshot is
  // persisted, so retries and re-queues replay the exact same payload. Stored
  // prompts stay business-only; a style change propagates on the next run.
  if (model.kind !== 'audio' && nodeAppliesVideoStyle(node.params)) {
    const style = video?.styleId ? getStyle(video.styleId) : undefined
    const prompt = (validatedParams as { prompt?: unknown }).prompt
    if (style && typeof prompt === 'string') {
      validatedParams = {
        ...(validatedParams as Record<string, unknown>),
        prompt: appendStyleBible(prompt, style.styleBible)
      }
    }
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
          ? ` (the last frame could not be extracted — keep this video's editor open so extraction can run, then retry)`
          : ` — run or select an output on the upstream node first.`
      throw new Error(
        `Input "${edge.targetHandle}" has no resolvable source from "${source.label ?? source.key}.${edge.sourceHandle}"${hint}`
      )
    }
    const bucket = (inputUrls[edge.targetHandle] ??= [])
    bucket.push(url)
    const handle = nodeModel.inputs.find((h) => h.key === edge.targetHandle)
    if (handle?.referenceAlias) {
      aliasMap[`${handle.referenceAlias}${bucket.length}`] = source.key
    }
  }

  // Edges are wired to the NODE model's handles — validate against those, then
  // remap onto the draft model's handles (renames + maxCount clamp) if needed.
  for (const handle of nodeModel.inputs) {
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
  const runInputs = draftSub ? remapDraftInputs(draftSub, inputUrls) : inputUrls

  const payload = model.buildPayload({ params: validatedParams as never, inputs: runInputs })

  return {
    videoId: node.videoId,
    modelId: model.id,
    provider: model.provider ?? 'jobs',
    draft: draftSub !== null,
    payload,
    inputSnapshot: {
      modelId: model.id,
      params: validatedParams,
      inputs: runInputs,
      aliases: aliasMap
    }
  }
}

// ── Claim (dedup) ────────────────────────────────────────────────────────────

function claimRun(args: {
  nodeId: string
  videoId: string
  inputSnapshot: unknown
  reuseSatisfied: boolean
  creditsEstimated: number | null
  draft: boolean
  /** §6.6 variants: claim a fresh row even if the node already has runs in
   *  flight — parallel candidates of the same node are the whole point. */
  forceNew?: boolean
}): { generationId: string; reused: boolean; kieTaskId: string | null } {
  const { nodeId, videoId, inputSnapshot, creditsEstimated, draft } = args
  const db = getDb()
  const rows = db
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()

  if (!args.forceNew) {
    const inFlight = rows.find((g) => g.status === 'running' || g.status === 'pending')
    if (inFlight) return { generationId: inFlight.id, reused: true, kieTaskId: inFlight.kieTaskId }

    if (args.reuseSatisfied) {
      const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
      const selected = node?.selectedGenerationId
        ? rows.find((g) => g.id === node.selectedGenerationId)
        : undefined
      const success =
        selected?.status === 'success' ? selected : rows.find((g) => g.status === 'success')
      if (success) return { generationId: success.id, reused: true, kieTaskId: success.kieTaskId }
    }
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
      draft,
      createdAt: Date.now()
    })
    .run()
  return { generationId, reused: false, kieTaskId: null }
}

// ── Completion + local media download ────────────────────────────────────────

/** Fallback extension per model kind — kie's endpoints deliver these formats. */
const EXT_BY_KIND: Record<string, string> = { video: '.mp4', image: '.jpg', audio: '.mp3' }

function extForContentType(
  contentType: string | null,
  fallbackUrl: string,
  defaultExt?: string
): string {
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
  // Unknown/generic Content-Type (e.g. application/octet-stream): trust the
  // URL only if its extension is a known media type, else fall back to the
  // model kind — a .bin file would be refused by Chromium's <video>.
  const urlExt = extname(new URL(fallbackUrl).pathname).toLowerCase()
  if (urlExt && mimeTypeFor(`f${urlExt}`)) return urlExt
  return defaultExt ?? (urlExt || '.bin')
}

/** Downloads the kie.ai result into the managed media store (fire-and-forget). */
async function downloadResult(generationId: string): Promise<void> {
  const db = getDb()
  const gen = db.select().from(generations).where(eq(generations.id, generationId)).get()
  if (!gen?.resultUrl || gen.resultPath) return
  const video = db.select().from(videos).where(eq(videos.id, gen.videoId)).get()
  if (!video) return
  const node = db.select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  const kind = node ? getModel(node.modelId)?.kind : undefined

  const res = await fetch(gen.resultUrl)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const contentType = res.headers.get('content-type')
  const ext = extForContentType(contentType, gen.resultUrl, kind ? EXT_BY_KIND[kind] : undefined)
  const target = join(mediaDirFor(video.projectId), `gen-${gen.id}${ext}`)
  writeFileSync(target, new Uint8Array(await res.arrayBuffer()))
  // Store a *media* mime only — the protocol handler serves it as Content-Type
  // (a generic application/octet-stream would make <video> undecodable).
  const headerMime = contentType?.split(';')[0]?.trim() ?? ''
  const mediaMime = /^(video|audio|image)\//.test(headerMime) ? headerMime : mimeTypeFor(target)
  db.update(generations)
    .set({ resultPath: target, resultMimeType: mediaMime })
    .where(eq(generations.id, generationId))
    .run()
  broadcastGenerationsChanged({ videoId: gen.videoId, nodeId: gen.nodeId })
}

/** downloadResult with backoff — a transient CDN hiccup must not strand the
 * generation on its remote URL (kie expires results after ~3 days). */
function downloadResultWithRetry(generationId: string): void {
  withRetry(() => downloadResult(generationId), { attempts: 3, baseDelayMs: 3000 }).catch((err) =>
    console.error(`[run-engine] media download failed for ${generationId}`, err)
  )
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
    downloadResultWithRetry(generationId)
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
  if (state === 'success') {
    // Vision QC (§6.2) runs BEFORE the settle event fires, so the chat
    // wake-up note and batch summaries carry the verdict. The service
    // degrades every failure to an 'error' verdict or null — the settle
    // path can never hang on it beyond its internal timeout.
    void maybeRunQcOnSettle(generationId).then((qc) => {
      emitGenerationSettled({
        generationId,
        videoId: gen.videoId,
        nodeId: gen.nodeId,
        status: 'success',
        errorMessage: null,
        qcVerdict: qc?.verdict ?? null,
        qcNotes: qc?.notes ?? null
      })
    })
  } else {
    emitGenerationSettled({
      generationId,
      videoId: gen.videoId,
      nodeId: gen.nodeId,
      status: 'failed',
      errorMessage: failMsg ?? 'kie.ai task failed'
    })
  }
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

  // Self-heal: successful generations whose download failed are stuck on the
  // remote kie URL, which expires after ~3 days — retry them now, serially.
  const undownloaded = getDb()
    .select()
    .from(generations)
    .where(and(eq(generations.status, 'success'), isNull(generations.resultPath)))
    .all()
    .filter((g) => g.resultUrl)
  if (undownloaded.length > 0) {
    console.log(`[run-engine] backfilling ${undownloaded.length} missing media download(s)`)
    void (async () => {
      for (const gen of undownloaded) {
        try {
          await downloadResult(gen.id)
        } catch (err) {
          console.error(`[run-engine] backfill download failed for ${gen.id}`, err)
        }
      }
    })()
  }
}

/** Rebuilds a ready-to-submit run from a generation's persisted input snapshot. */
function prepFromSnapshot(gen: GenerationRow): PreparedRun | null {
  const node = getDb().select().from(nodes).where(eq(nodes.id, gen.nodeId)).get()
  const snapshot = gen.inputSnapshot as PreparedRun['inputSnapshot'] | null
  // The snapshot records the SUBMITTED model (the draft one under draft mode —
  // pre-6.1 snapshots have no modelId); the node's model is only a fallback.
  const model = snapshot?.modelId
    ? getModel(snapshot.modelId)
    : node
      ? getModel(node.modelId)
      : undefined
  if (!node || !model || !snapshot?.params) return null
  return {
    videoId: gen.videoId,
    modelId: model.id,
    provider: model.provider ?? 'jobs',
    draft: gen.draft ?? false,
    payload: model.buildPayload({
      params: snapshot.params as never,
      inputs: snapshot.inputs ?? {}
    }),
    inputSnapshot: { ...snapshot, modelId: model.id }
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
  reuseSatisfied = false,
  opts?: { forceFinal?: boolean; variants?: number }
): Promise<{ generationId: string; kieTaskId: string; generationIds: string[] }> {
  // Fail fast on the one config error the user can fix immediately — every
  // other submission error surfaces asynchronously on the generation row.
  if (!getKieApiKey()) {
    throw new Error(
      "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."
    )
  }
  const variants = clampVariants(opts?.variants ?? 1)
  const prep = await prepareRun(nodeId, opts)

  const estimate = estimateCreditsFor(prep.modelId, prep.inputSnapshot.params)

  // Variants ×N (§6.6): ONE prepare (so every candidate submits the byte-identical
  // payload — including the same uploaded inputs) and N independent claims, each
  // taking its own queue slot. Dedup is bypassed on purpose: parallel candidates
  // of the same node are exactly what the user asked for.
  if (variants > 1) {
    const generationIds = Array.from(
      { length: variants },
      () =>
        claimRun({
          nodeId,
          videoId: prep.videoId,
          inputSnapshot: prep.inputSnapshot,
          reuseSatisfied: false,
          creditsEstimated: estimate,
          draft: prep.draft,
          forceNew: true
        }).generationId
    )
    broadcastGenerationsChanged({ videoId: prep.videoId, nodeId })
    for (const id of generationIds) queue.enqueue(id, () => submitGeneration(id, prep))
    return { generationId: generationIds[0] as string, kieTaskId: '', generationIds }
  }

  const claim = claimRun({
    nodeId,
    videoId: prep.videoId,
    inputSnapshot: prep.inputSnapshot,
    reuseSatisfied,
    creditsEstimated: estimate,
    draft: prep.draft
  })
  if (claim.reused) {
    return {
      generationId: claim.generationId,
      kieTaskId: claim.kieTaskId ?? '',
      generationIds: [claim.generationId]
    }
  }
  const generationId = claim.generationId
  broadcastGenerationsChanged({ videoId: prep.videoId, nodeId })

  // Queued: submission happens when a concurrency slot frees up. The task id
  // is therefore not known yet — callers track the generation id.
  queue.enqueue(generationId, () => submitGeneration(generationId, prep))
  return { generationId, kieTaskId: '', generationIds: [generationId] }
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

/**
 * Cancels EVERY run in flight on the node — a variants batch (§6.6) puts N of
 * them there and one Cancel click must stop the whole exploration, not peel
 * candidates off one at a time.
 */
export function cancelGeneration(nodeId: string): { cancelled: boolean } {
  const inFlight = getDb()
    .select()
    .from(generations)
    .where(eq(generations.nodeId, nodeId))
    .orderBy(desc(generations.createdAt))
    .all()
    .filter((g) => g.status === 'running' || g.status === 'pending')
  for (const gen of inFlight) failGeneration(gen.id, 'Cancelled by user.')
  return { cancelled: inFlight.length > 0 }
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
