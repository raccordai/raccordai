import { maxPollAttemptsFor, POLL_INTERVAL_MS, withRetry } from '../genQueue'
import {
  kieCreateSunoTask,
  kieCreateTask,
  kieGetSunoStatus,
  kieGetTaskInfo,
  kieUploadFile,
  parseResultUrl
} from '../kie'
import { getKieApiKey } from '../settings'
import type { GenerationProvider, InputPublisher, RemoteStatus } from './types'

/**
 * kie.ai providers — the unified jobs API (`jobs`, the default family) and
 * the dedicated Suno music API (`suno`). Both run on the kie key, share the
 * File Upload API for local input media and draw from the hosted concurrency
 * budget. Thin shells over `services/kie.ts` (E2E scope, like the client).
 */

export const KIE_KEY_MISSING_MESSAGE =
  "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."

function assertKieConfigured(): void {
  if (!getKieApiKey()) throw new Error(KIE_KEY_MISSING_MESSAGE)
}

// ── Input media (kie.ai must be able to fetch every input) ───────────────────

/** kie.ai deletes uploads after ~3 days; refresh well before that. */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000

/** A cached upload reference still inside its TTL, or null. */
export function uploadFresh(
  url: string | null,
  at: number | null,
  now = Date.now()
): string | null {
  return url && at && now - at < UPLOAD_TTL_MS ? url : null
}

/**
 * kie deletes uploads earlier than its documented ~3 days (observed dead within
 * ~30 h), so a TTL-fresh cache entry is only reused after a live HEAD probe —
 * a dead URL re-uploads the local copy instead of failing the run with a
 * 400 "Image fetch failed".
 */
async function uploadStillAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

export const kieInputPublisher: InputPublisher = {
  acceptsRemoteUrl: uploadStillAlive,
  async publish({ localPath, purpose, cached }) {
    const fresh = uploadFresh(cached.ref, cached.at)
    if (fresh && (await uploadStillAlive(fresh))) return { ref: fresh, reused: true }
    return { ref: await kieUploadFile(localPath, `raccord/${purpose}`), reused: false }
  }
}

// ── Providers ────────────────────────────────────────────────────────────────

/** The hosted concurrency budget every cloud provider shares. */
export const CLOUD_QUEUE_KEY = 'cloud'

const poll = { intervalMs: POLL_INTERVAL_MS, maxAttempts: maxPollAttemptsFor }

async function jobsStatus(taskRef: string): Promise<RemoteStatus> {
  const data = await kieGetTaskInfo(taskRef)
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

export const kieJobsProvider: GenerationProvider = {
  id: 'jobs',
  label: 'kie.ai',
  queueKey: CLOUD_QUEUE_KEY,
  assertConfigured: assertKieConfigured,
  async submit({ modelId, payload }) {
    const taskRef = await withRetry(() => kieCreateTask({ model: modelId, input: payload }), {
      attempts: 3,
      baseDelayMs: 2000,
      // createTask surfaces the kie code in the message; 4xx codes won't heal.
      isTransient: (err) => !/\((4\d\d)\)/.test(err instanceof Error ? err.message : '')
    })
    return { taskRef }
  },
  status: jobsStatus,
  poll,
  inputs: kieInputPublisher
}

export const kieSunoProvider: GenerationProvider = {
  id: 'suno',
  label: 'kie.ai',
  queueKey: CLOUD_QUEUE_KEY,
  assertConfigured: assertKieConfigured,
  // The Suno client retries internally (its API 500s more often).
  submit: async ({ payload }) => ({ taskRef: await kieCreateSunoTask({ input: payload }) }),
  status: kieGetSunoStatus,
  poll,
  inputs: kieInputPublisher
}
