import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { getKieApiKey } from './settings'
import { mimeTypeFor } from '../media/files'

/**
 * kie.ai client — port of video-studio's convex/lib/kie.ts, plus the File
 * Upload API (local desktop media has no public URL, so inputs are uploaded
 * on demand; uploads expire after ~3 days on kie's side).
 * RACCORD_KIE_BASE overrides the host for integration tests (mock server).
 */

export const KIE_BASE = process.env['RACCORD_KIE_BASE'] ?? 'https://api.kie.ai'

/**
 * The File Upload API lives on its own host (kieai.redpandaai.co) — api.kie.ai
 * 404s on /api/file-stream-upload. The test override still routes uploads to
 * the same mock server as everything else.
 */
export const KIE_UPLOAD_BASE = process.env['RACCORD_KIE_BASE'] ?? 'https://kieai.redpandaai.co'

function getApiKey(): string {
  const key = getKieApiKey()
  if (!key) {
    throw new Error(
      "kie.ai API key is not configured. Add it in the app's Integrations section on the home page."
    )
  }
  return key
}

interface KieCreateTaskResponse {
  code: number
  msg: string
  data?: { taskId: string }
}

interface KieRecordInfoResponse {
  code: number
  msg: string
  data?: {
    taskId: string
    model: string
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail'
    param: string
    resultJson?: string
    failCode?: string | null
    failMsg?: string | null
  }
}

export async function kieCreateTask(args: {
  model: string
  input: Record<string, unknown>
}): Promise<string> {
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`
    },
    body: JSON.stringify(args)
  })
  const json = (await res.json()) as KieCreateTaskResponse
  if (!res.ok || json.code !== 200 || !json.data?.taskId) {
    throw new Error(`kie.ai createTask failed (${json.code}): ${json.msg}`)
  }
  return json.data.taskId
}

export async function kieGetTaskInfo(
  taskId: string
): Promise<NonNullable<KieRecordInfoResponse['data']>> {
  const res = await fetch(
    `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${getApiKey()}` } }
  )
  const json = (await res.json()) as KieRecordInfoResponse
  if (!res.ok || json.code !== 200 || !json.data) {
    throw new Error(`kie.ai recordInfo failed (${json.code}): ${json.msg}`)
  }
  return json.data
}

interface KieCreditResponse {
  code: number
  msg: string
  data?: number
}

/** Remaining kie.ai account credit balance. */
export async function kieGetCredits(): Promise<number> {
  const res = await fetch(`${KIE_BASE}/api/v1/chat/credit`, {
    headers: { Authorization: `Bearer ${getApiKey()}` }
  })
  const json = (await res.json()) as KieCreditResponse
  if (!res.ok || json.code !== 200 || typeof json.data !== 'number') {
    throw new Error(`kie.ai credit check failed (${json.code}): ${json.msg}`)
  }
  return json.data
}

export type KieKeyTestResult = 'ok' | 'unauthorized' | 'network' | 'missing'

/**
 * Cheap authenticated probe (the same credit-balance endpoint HeaderCredits
 * uses) so onboarding/settings can show live key validation instead of just
 * "saved". Never throws — the outcome is the classification.
 */
export async function kieTestApiKey(): Promise<KieKeyTestResult> {
  const key = getKieApiKey()
  if (!key) return 'missing'
  try {
    const res = await fetch(`${KIE_BASE}/api/v1/chat/credit`, {
      headers: { Authorization: `Bearer ${key}` }
    })
    let code: number | undefined
    try {
      code = ((await res.json()) as KieCreditResponse).code
    } catch {
      code = undefined
    }
    if ([401, 403].includes(res.status) || (code !== undefined && [401, 403].includes(code))) {
      return 'unauthorized'
    }
    return res.ok && code === 200 ? 'ok' : 'network'
  } catch {
    return 'network'
  }
}

/** Extracts the first result URL from kie.ai's stringified resultJson. */
export function parseResultUrl(resultJson: string | undefined | null): string | undefined {
  if (!resultJson) return undefined
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: string[] }
    return parsed.resultUrls?.[0]
  } catch {
    return undefined
  }
}

// ── Suno music API (flat body, different status vocabulary) ──────────────────

interface KieSunoStatusResponse {
  code: number
  msg: string
  data?: {
    taskId: string
    status: string
    errorCode?: number | null
    errorMessage?: string | null
    response?: { sunoData?: Array<{ audioUrl?: string }> }
  }
}

/**
 * kie.ai's Suno endpoint REQUIRES a callBackUrl even though desktop has no
 * public webhook — the poller (kieGetSunoStatus) is the real completion path.
 * Any syntactically valid URL satisfies the API; nothing is ever received here.
 */
const SUNO_CALLBACK_PLACEHOLDER = 'https://app.raccord.ai/api/suno-callback'

export async function kieCreateSunoTask(args: { input: Record<string, unknown> }): Promise<string> {
  const body = JSON.stringify({ callBackUrl: SUNO_CALLBACK_PLACEHOLDER, ...args.input })
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getApiKey()}`
  }

  let lastError = 'no response'
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${KIE_BASE}/api/v1/generate`, { method: 'POST', headers, body })
    const raw = await res.text()
    let json: KieCreateTaskResponse | undefined
    try {
      json = JSON.parse(raw) as KieCreateTaskResponse
    } catch {
      json = undefined
    }
    if (res.ok && json?.code === 200 && json.data?.taskId) return json.data.taskId

    lastError = `HTTP ${res.status} (code ${json?.code ?? '?'}): ${json?.msg ?? raw.slice(0, 300)}`
    const transient = res.status >= 500 || (json?.code ?? 0) >= 500
    if (!transient || attempt === 3) break
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
  }
  throw new Error(`kie.ai Suno generate failed — ${lastError}`)
}

export async function kieGetSunoStatus(
  taskId: string
): Promise<{ state: 'success' | 'fail' | 'pending'; resultUrl?: string; failMsg?: string }> {
  const res = await fetch(
    `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${getApiKey()}` } }
  )
  const json = (await res.json()) as KieSunoStatusResponse
  if (!res.ok || json.code !== 200 || !json.data) {
    throw new Error(`kie.ai Suno record-info failed (${json.code}): ${json.msg}`)
  }
  const { status, response, errorMessage, errorCode } = json.data
  const audioUrl = response?.sunoData?.find((t) => t.audioUrl)?.audioUrl

  if (status === 'SUCCESS' || (status === 'FIRST_SUCCESS' && audioUrl)) {
    return { state: 'success', resultUrl: audioUrl }
  }
  if (
    status === 'CREATE_TASK_FAILED' ||
    status === 'GENERATE_AUDIO_FAILED' ||
    status === 'CALLBACK_EXCEPTION' ||
    status === 'SENSITIVE_WORD_ERROR'
  ) {
    const detail = errorMessage ? ` — ${errorMessage}${errorCode ? ` (${errorCode})` : ''}` : ''
    return { state: 'fail', failMsg: `Suno ${status.toLowerCase().replace(/_/g, ' ')}${detail}` }
  }
  return { state: 'pending' }
}

// ── Claude messages proxy (prompt refinement) ────────────────────────────────

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

interface KieClaudeResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { type?: string; message?: string }
}

export async function kieClaudeMessage(args: {
  model: string
  system?: string
  content: ClaudeContentBlock[]
  maxTokens?: number
}): Promise<string> {
  const res = await fetch(`${KIE_BASE}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens ?? 1024,
      ...(args.system ? { system: args.system } : {}),
      messages: [{ role: 'user', content: args.content }]
    })
  })

  const raw = await res.text()
  let json: KieClaudeResponse
  try {
    json = JSON.parse(raw) as KieClaudeResponse
  } catch {
    throw new Error(`kie.ai Claude returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }
  if (!res.ok || json.error) {
    throw new Error(
      `kie.ai Claude failed (HTTP ${res.status}): ${json.error?.message ?? raw.slice(0, 300)}`
    )
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => (b.text as string).trim())
    .join('\n')
    .trim()
  if (!text) throw new Error('kie.ai Claude returned an empty response.')
  return text
}

// ── File Upload API (temporary hosting for local input media) ────────────────

interface KieUploadResponse {
  success?: boolean
  code: number
  msg: string
  data?: { downloadUrl?: string; fileName?: string }
}

/** Uploads a local file; returns its temporary public URL (expires ~3 days). */
export async function kieUploadFile(localPath: string, uploadPath: string): Promise<string> {
  const bytes = readFileSync(localPath)
  const mime = mimeTypeFor(localPath) ?? 'application/octet-stream'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), basename(localPath))
  form.append('uploadPath', uploadPath)

  const res = await fetch(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}` },
    body: form
  })
  const raw = await res.text()
  let json: KieUploadResponse
  try {
    json = JSON.parse(raw) as KieUploadResponse
  } catch {
    throw new Error(
      `kie.ai file upload returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`
    )
  }
  if (!res.ok || json.code !== 200 || !json.data?.downloadUrl) {
    throw new Error(
      `kie.ai file upload failed (HTTP ${res.status}, code ${json.code ?? '?'}): ${json.msg ?? raw.slice(0, 300)}`
    )
  }
  return json.data.downloadUrl
}
