import { useSyncExternalStore } from 'react'
import type { DemoControlPayload } from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'
import { toBase64Chunks } from '@renderer/lib/demoJournal'
import { reportRendererError } from '@renderer/lib/errorReporter'

/**
 * Demo mode (§9) — the renderer's capture head, obeying main's demoControl
 * events. Thin shell (E2E scope, out of unit coverage): it records the
 * display main granted (getDisplayMedia + MediaRecorder) and streams chunks
 * back — the INPUT JOURNAL is entirely main's business (machine-wide hook +
 * demo:point), one path for Raccord and third-party apps alike. The only
 * journal-shaped thing here is agent pointing: focus_node landings are
 * forwarded to demo:point in SCREEN coordinates.
 *
 * Module-level singleton à la assistantStore: StrictMode double-invokes
 * effects in dev, so `handleDemoControl` is idempotent by sessionId and the
 * recorder itself never lives in React state.
 */

export interface DemoRecorderState {
  recording: boolean
  sessionId: string | null
  startedAt: number | null
}

let state: DemoRecorderState = { recording: false, sessionId: null, startedAt: null }
const listeners = new Set<() => void>()

function setState(next: DemoRecorderState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDemoRecorder(): DemoRecorderState {
  return useSyncExternalStore(subscribe, () => state)
}

interface ActiveCapture {
  sessionId: string
  recorder: MediaRecorder
  stream: MediaStream
  /** Serial upload queue — chunks reach main in order, one at a time. */
  queue: Promise<void>
  seq: number
  t0: number
  /** Date.now() at recorder.onstart — main rebases global-hook events onto it. */
  startEpochMs: number
  aborted: boolean
  detach: () => void
}

let capture: ActiveCapture | null = null

function pickMimeType(): string | undefined {
  for (const candidate of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return undefined
}

/**
 * Agent pointing: tool-driven demos never move the real mouse (the journal
 * would be empty and the auto camera blind). focus_node is the agent's way
 * of POINTING at what it demos — once the editor's pan settles, forward the
 * node's landing spot to main in SCREEN coordinates (window position +
 * client rect; both in DIPs, the space main normalizes against).
 */
function attachAgentPointing(): () => void {
  const focusTimers = new Set<ReturnType<typeof setTimeout>>()
  const unsubFocus = window.api.on('event:focusNode', (payload) => {
    const nodeId = (payload as { nodeId?: string })?.nodeId
    if (!nodeId) return
    const timer = setTimeout(() => {
      focusTimers.delete(timer)
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
      const rect = el?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      void invoke('demo:point', {
        x: window.screenX + rect.x + rect.width / 2,
        y: window.screenY + rect.y + rect.height / 2
      }).catch(() => undefined)
    }, 700)
    focusTimers.add(timer)
  })
  return () => {
    for (const timer of focusTimers) clearTimeout(timer)
    unsubFocus()
  }
}

function uploadBlob(active: ActiveCapture, blob: Blob): void {
  active.queue = active.queue
    .then(async () => {
      if (active.aborted) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      for (const base64 of toBase64Chunks(bytes)) {
        await invoke('demo:appendChunk', { sessionId: active.sessionId, seq: active.seq, base64 })
        active.seq += 1
      }
    })
    .catch((error: unknown) => {
      if (active.aborted) return
      active.aborted = true
      reportRendererError('demo', error)
      // Losing a chunk corrupts the take — abort the recording entirely.
      if (active.recorder.state !== 'inactive') active.recorder.stop()
    })
}

async function finish(active: ActiveCapture, durationSec: number, error?: string): Promise<void> {
  await active.queue.catch(() => undefined)
  active.detach()
  for (const track of active.stream.getTracks()) track.stop()
  if (capture?.sessionId === active.sessionId) capture = null
  setState({ recording: false, sessionId: null, startedAt: null })
  try {
    await invoke('demo:finish', {
      sessionId: active.sessionId,
      durationSec,
      events: [],
      captureStartEpochMs: active.startEpochMs,
      ...(error ? { error } : {})
    })
  } catch (finishError) {
    reportRendererError('demo', finishError)
  }
}

async function startCapture(sessionId: string): Promise<void> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false
    })
  } catch (error) {
    await invoke('demo:finish', {
      sessionId,
      durationSec: 0,
      events: [],
      error: `getDisplayMedia failed: ${error instanceof Error ? error.message : String(error)}`
    }).catch((e: unknown) => reportRendererError('demo', e))
    return
  }

  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000
  })
  const active: ActiveCapture = {
    sessionId,
    recorder,
    stream,
    queue: Promise.resolve(),
    seq: 0,
    t0: performance.now(),
    startEpochMs: Date.now(),
    aborted: false,
    detach: () => undefined
  }
  capture = active

  recorder.onstart = () => {
    active.t0 = performance.now()
    active.startEpochMs = Date.now()
    active.detach = attachAgentPointing()
    setState({ recording: true, sessionId, startedAt: Date.now() })
  }
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) uploadBlob(active, e.data)
  }
  recorder.onstop = () => {
    const durationSec = (performance.now() - active.t0) / 1000
    void finish(active, durationSec, active.aborted ? 'chunk upload failed' : undefined)
  }
  recorder.onerror = () => {
    active.aborted = true
    if (recorder.state !== 'inactive') recorder.stop()
  }
  recorder.start(1000)
}

/** Obeys main's demoControl broadcast. Idempotent by sessionId (StrictMode-safe). */
export function handleDemoControl(payload: DemoControlPayload): void {
  if (payload.action === 'start') {
    if (capture?.sessionId === payload.sessionId) return
    if (capture) return // another take is live — main refuses double starts anyway
    void startCapture(payload.sessionId)
    return
  }
  if (capture?.sessionId === payload.sessionId && capture.recorder.state !== 'inactive') {
    capture.recorder.stop()
  }
}

/**
 * Renderer-reload rehydration: main still holds a session but our recorder is
 * gone — fail the take so the pending stop settles instead of timing out.
 */
export async function reconcileDemoStatus(): Promise<void> {
  try {
    const status = await invoke('demo:status')
    if (status.recording && status.sessionId && !capture) {
      await invoke('demo:finish', {
        sessionId: status.sessionId,
        durationSec: 0,
        events: [],
        error: 'renderer reloaded during the recording'
      })
    }
  } catch (error) {
    reportRendererError('demo', error)
  }
}
