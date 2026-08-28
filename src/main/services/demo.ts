import { execFile } from 'node:child_process'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow } from 'electron'
import type { DemoEvent } from '@shared/screenMotion'
import { ffmpegPath } from '../media/ffbin'
import { broadcastDemoControl } from '../events'
import { buildDemoTranscodeArgs } from './renderPlan'
import { importAssetFromBytes, setAssetDemoEvents } from './assets'
import { logError, logInfo } from './logger'

/**
 * Demo mode (§9) — the app records itself. Thin orchestration shell (E2E
 * scope, out of unit coverage): every decision lives elsewhere — the event
 * schema in shared/screenMotion.ts, the transcode argv in renderPlan.ts
 * (pure, tested), asset persistence in assets.ts. This file only owns the
 * session state machine: staging dir + growing webm, the window pin/restore,
 * and the pending stop↔finish handshake with the renderer recorder.
 *
 * Armed by RACCORD_DEMO=1 only. NOT in the graph journal — nothing touches a
 * graph until the imported asset is placed on a timeline. macOS note: frame
 * capture (setDisplayMediaRequestHandler in main/index.ts) reads nothing
 * outside our own contents, so no Screen Recording TCC prompt is expected;
 * the desktopCapturer fallback documented there WOULD trigger one.
 */

const STOP_TIMEOUT_MS = 15_000
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720

const exec = promisify(execFile)

export interface DemoStopResult {
  assetId: string | null
  path: string
  eventsPath: string | null
  durationSec: number
  format: 'mp4' | 'webm'
  events: DemoEvent[]
}

interface DemoSession {
  sessionId: string
  external: boolean
  projectId: string | null
  tmpDir: string
  webmPath: string
  stream: ReturnType<typeof createWriteStream>
  nextSeq: number
  startedAt: number
  prevBounds: Electron.Rectangle | null
  prevResizable: boolean | null
  pending: {
    resolve: (result: DemoStopResult) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null
  /** Finish landed before stop was called (external drivers) — stashed here. */
  result: DemoStopResult | { error: Error } | null
}

let active: DemoSession | null = null

export function isDemoEnabled(): boolean {
  return process.env['RACCORD_DEMO'] === '1'
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/** Restores the window pin — always safe to call twice. */
function restoreWindow(session: DemoSession): void {
  const window = mainWindow()
  if (!window || window.isDestroyed()) return
  if (session.prevResizable !== null) window.setResizable(session.prevResizable)
  if (session.prevBounds) window.setBounds(session.prevBounds)
  session.prevBounds = null
  session.prevResizable = null
}

function cleanup(session: DemoSession): void {
  restoreWindow(session)
  if (session.pending) {
    clearTimeout(session.pending.timer)
    session.pending = null
  }
  rmSync(session.tmpDir, { recursive: true, force: true })
  if (active?.sessionId === session.sessionId) active = null
}

export function startDemo(input: {
  projectId?: string
  width?: number
  height?: number
  external?: boolean
}): { sessionId: string } {
  if (!isDemoEnabled()) throw new Error('Demo mode is not enabled (launch with RACCORD_DEMO=1).')
  if (active) throw new Error('A demo recording is already in progress.')

  const tmpDir = mkdtempSync(join(tmpdir(), 'raccord-demo-'))
  const webmPath = join(tmpDir, 'capture.webm')
  const sessionId = `demo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const session: DemoSession = {
    sessionId,
    external: input.external === true,
    projectId: input.projectId ?? null,
    tmpDir,
    webmPath,
    stream: createWriteStream(webmPath),
    nextSeq: 0,
    startedAt: Date.now(),
    prevBounds: null,
    prevResizable: null,
    pending: null,
    result: null
  }
  active = session

  if (!session.external) {
    const window = mainWindow()
    if (window && !window.isDestroyed()) {
      session.prevBounds = window.getBounds()
      session.prevResizable = window.isResizable()
      window.setContentSize(input.width ?? DEFAULT_WIDTH, input.height ?? DEFAULT_HEIGHT)
      window.setResizable(false)
    }
    broadcastDemoControl({ action: 'start', sessionId })
  }
  logInfo('demo', `recording started (${sessionId}${session.external ? ', external' : ''})`)
  return { sessionId }
}

export function appendDemoChunk(input: { sessionId: string; seq: number; base64: string }): void {
  const session = active
  if (!session || session.sessionId !== input.sessionId) {
    throw new Error('No demo recording matches this session.')
  }
  if (input.seq !== session.nextSeq) {
    // A lost/reordered chunk would silently corrupt the webm — fail loudly.
    throw new Error(`Demo chunk out of order (got ${input.seq}, expected ${session.nextSeq}).`)
  }
  session.nextSeq += 1
  session.stream.write(Buffer.from(input.base64, 'base64'))
}

export function stopDemo(): Promise<DemoStopResult> {
  const session = active
  if (!session) return Promise.reject(new Error('No demo recording in progress.'))
  if (session.result) {
    // External drivers may finish before calling stop — hand the stash over.
    const stashed = session.result
    cleanup(session)
    if ('error' in stashed) return Promise.reject(stashed.error)
    return Promise.resolve(stashed)
  }
  if (session.pending) return Promise.reject(new Error('A demo stop is already pending.'))

  return new Promise<DemoStopResult>((resolve, reject) => {
    session.pending = {
      resolve,
      reject,
      timer: setTimeout(() => {
        logError('demo', 'recorder never finished — stop timed out')
        cleanup(session)
        reject(new Error('The demo recorder did not finish in time.'))
      }, STOP_TIMEOUT_MS)
    }
    if (!session.external) broadcastDemoControl({ action: 'stop', sessionId: session.sessionId })
  })
}

export async function finishDemo(input: {
  sessionId: string
  durationSec: number
  events: DemoEvent[]
  error?: string
}): Promise<void> {
  const session = active
  if (!session || session.sessionId !== input.sessionId) {
    throw new Error('No demo recording matches this session.')
  }

  await new Promise<void>((resolve) => session.stream.end(resolve))
  restoreWindow(session)

  const settle = (outcome: DemoStopResult | { error: Error }): void => {
    if (session.pending) {
      clearTimeout(session.pending.timer)
      const pending = session.pending
      session.pending = null
      cleanup(session)
      if ('error' in outcome) pending.reject(outcome.error)
      else pending.resolve(outcome)
    } else {
      // Stop not called yet (external drivers): stash, cleanup happens there.
      session.result = outcome
    }
  }

  if (input.error) {
    settle({ error: new Error(`Demo capture failed: ${input.error}`) })
    return
  }

  try {
    // Transcode to an editable mp4; a failed transcode keeps the webm take.
    let mediaPath = join(session.tmpDir, 'capture.mp4')
    let format: 'mp4' | 'webm' = 'mp4'
    try {
      await exec(ffmpegPath(), buildDemoTranscodeArgs(session.webmPath, mediaPath))
    } catch (error) {
      logError('demo', 'transcode failed — keeping the webm take', error)
      mediaPath = session.webmPath
      format = 'webm'
    }

    const stamp = new Date(session.startedAt)
    const label = `Demo ${stamp.toISOString().slice(0, 16).replace('T', ' ')}`
    if (session.projectId) {
      const asset = importAssetFromBytes({
        projectId: session.projectId,
        bytes: readFileSync(mediaPath),
        mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
        name: label,
        description: 'Demo-mode self recording (input-event journal attached).'
      })
      setAssetDemoEvents(asset.id, input.events)
      settle({
        assetId: asset.id,
        path: asset.filePath ?? mediaPath,
        eventsPath: null,
        durationSec: input.durationSec,
        format,
        events: input.events
      })
    } else {
      const base = join(app.getPath('downloads'), label.replace(/[: ]/g, '-'))
      const outPath = `${base}.${format}`
      const eventsPath = `${base}.events.json`
      writeFileSync(outPath, readFileSync(mediaPath))
      writeFileSync(eventsPath, JSON.stringify(input.events, null, 2))
      settle({
        assetId: null,
        path: outPath,
        eventsPath,
        durationSec: input.durationSec,
        format,
        events: input.events
      })
    }
    logInfo('demo', `recording finished (${input.durationSec.toFixed(1)}s, ${format})`)
  } catch (error) {
    logError('demo', 'finishing the recording failed', error)
    settle({ error: error instanceof Error ? error : new Error(String(error)) })
  }
}

export function demoStatus(): {
  recording: boolean
  sessionId: string | null
  startedAt: number | null
} {
  return {
    recording: active !== null,
    sessionId: active?.sessionId ?? null,
    startedAt: active?.startedAt ?? null
  }
}
