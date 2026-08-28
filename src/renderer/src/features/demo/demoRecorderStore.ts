import { useSyncExternalStore } from 'react'
import type { DemoControlPayload } from '@shared/ipc/contracts'
import type { DemoEvent } from '@shared/screenMotion'
import { invoke } from '@renderer/lib/ipc'
import { createMoveThrottle, normalizeEvent, toBase64Chunks } from '@renderer/lib/demoJournal'
import { reportRendererError } from '@renderer/lib/errorReporter'

/**
 * Demo mode (§9) — the renderer's capture head, obeying main's demoControl
 * events. Thin shell (E2E scope, out of unit coverage): every decision lives
 * in lib/demoJournal.ts (pure, tested); this module wires getDisplayMedia +
 * MediaRecorder to the DOM listeners and the chunked IPC upload.
 *
 * Module-level singleton à la assistantStore: StrictMode double-invokes
 * effects in dev, so `handleDemoControl` is idempotent by sessionId and the
 * recorder itself never lives in React state.
 *
 * Journal listeners run in CAPTURE phase — TimelineV2/React Flow drag loops
 * stopPropagation, which would hide bubble-phase events. Known hole, not
 * fought: pointerdown over the title bar's empty drag region
 * (-webkit-app-region: drag) never reaches any listener (CLAUDE.md).
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
  events: DemoEvent[]
  /** Serial upload queue — chunks reach main in order, one at a time. */
  queue: Promise<void>
  seq: number
  t0: number
  aborted: boolean
  detach: () => void
}

let capture: ActiveCapture | null = null

const MOVE_THROTTLE_SEC = 0.08

function pickMimeType(): string | undefined {
  for (const candidate of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return undefined
}

function attachJournal(active: ActiveCapture): () => void {
  const throttle = createMoveThrottle(MOVE_THROTTLE_SEC)
  const now = (): number => (performance.now() - active.t0) / 1000
  const push = (event: DemoEvent | null): void => {
    if (event) active.events.push(event)
  }

  const onPointerDown = (e: PointerEvent): void =>
    push(normalizeEvent('click', now(), e.clientX, e.clientY, innerWidth, innerHeight))
  const onPointerMove = (e: PointerEvent): void =>
    push(throttle(normalizeEvent('move', now(), e.clientX, e.clientY, innerWidth, innerHeight)))
  // Redaction rule: keydown journals the bare fact — never read event.key
  // (it can even be a non-string on Chromium synthetic events).
  const onKeyDown = (): void => push(normalizeEvent('key', now(), 0, 0, 0, 0))
  const onWheel = (e: WheelEvent): void =>
    push(normalizeEvent('scroll', now(), e.clientX, e.clientY, innerWidth, innerHeight))

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('wheel', onWheel, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('wheel', onWheel, true)
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
      events: error ? [] : active.events,
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
    events: [],
    queue: Promise.resolve(),
    seq: 0,
    t0: performance.now(),
    aborted: false,
    detach: () => undefined
  }
  capture = active

  recorder.onstart = () => {
    active.t0 = performance.now()
    active.detach = attachJournal(active)
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
