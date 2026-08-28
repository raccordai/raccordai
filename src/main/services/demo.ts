import { execFile } from 'node:child_process'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron'
import type { DemoEvent } from '@shared/screenMotion'
import { normalizeOnDisplay } from '@shared/screenMotion'
import { ffmpegPath } from '../media/ffbin'
import { broadcastDemoControl } from '../events'
import { buildDemoTranscodeArgs } from './renderPlan'
import { importAssetFromBytes, setAssetDemoEvents } from './assets'
import { startGlobalJournal, stopGlobalJournal } from './demoGlobalHook'
import { logError, logInfo } from './logger'

/**
 * Demo mode (§9) — ONE recording path for everything: every take films a
 * whole display (Raccord fullscreen, or any other application) with the
 * input journal collected by the machine-wide hook. Thin orchestration shell
 * (E2E scope, out of unit coverage): every decision lives elsewhere — the
 * event schema and normalization in shared/screenMotion.ts, the transcode
 * argv in renderPlan.ts (pure, tested), asset persistence in assets.ts.
 * This file only owns the session state machine: staging dir + growing webm,
 * the menu-bar REC tray, the stop↔finish handshake, and delivering the take
 * to its destination project AT STOP TIME (demo:stop's projectId overrides
 * the start's — an agent can record in one context and file the take
 * elsewhere).
 *
 * Armed by RACCORD_DEMO=1 only. NOT in the graph journal — nothing touches a
 * graph until the imported asset is placed on a timeline. macOS permissions:
 * Screen Recording prompts on the first capture; the journal needs
 * Accessibility (missing ⇒ warning + no journal, never a crash).
 */

const STOP_TIMEOUT_MS = 15_000

const exec = promisify(execFile)

export interface DemoStopResult {
  assetId: string | null
  path: string
  eventsPath: string | null
  durationSec: number
  format: 'mp4' | 'webm'
  warnings: string[]
  events: DemoEvent[]
}

/** What finishDemo produces — media still staged in tmpDir, delivered at stop. */
interface FinishedTake {
  mediaPath: string
  format: 'mp4' | 'webm'
  durationSec: number
  events: DemoEvent[]
}

interface DemoSession {
  sessionId: string
  external: boolean
  projectId: string | null
  displayId: number
  displayBounds: Electron.Rectangle
  hookRunning: boolean
  warnings: string[]
  /** Agent pointing (demo:point) — provisional epoch-second times, like the hook's. */
  syntheticEvents: DemoEvent[]
  tmpDir: string
  webmPath: string
  stream: ReturnType<typeof createWriteStream>
  nextSeq: number
  startedAt: number
  prevBackgroundThrottling: boolean | null
  pending: {
    resolve: (take: FinishedTake) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null
  /** Finish landed before stop was called — stashed here. */
  result: FinishedTake | { error: Error } | null
}

let active: DemoSession | null = null

export function isDemoEnabled(): boolean {
  return process.env['RACCORD_DEMO'] === '1'
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

/**
 * The REC indicator is a MENU-BAR tray item, not a window: window content
 * protection does NOT exclude a window from full-display captures (only from
 * window captures), so any floating indicator would end up in the take — the
 * in-page banner did, and so did the pill window that replaced it. A tiny
 * menu-bar dot is invisible when the demoed app runs fullscreen (macOS hides
 * the menu bar) and discreet otherwise.
 */
let recTray: Tray | null = null

const REC_DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYElEQVR4nGP4ERXFQAmmSDMxBsgCsTGUJsmAOCA+D8T/kfB5qDhBA7rQNKLjLnwGxBHQDMNxuAxAdzYufB6bAbJEaoZhWXQDjEk0wJjqLqA4DKgSCxSnA6qkRKrkBaIxAMalEgpF4vBAAAAAAElFTkSuQmCC'

function openRecTray(): void {
  if (recTray) return
  recTray = new Tray(nativeImage.createFromDataURL(REC_DOT_PNG))
  recTray.setToolTip('Raccord — demo recording (⇧⌘R stops it)')
  recTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Stop demo recording',
        click: () => {
          stopDemo().catch((error: unknown) => logError('demo', 'tray stop failed', error))
        }
      }
    ])
  )
}

function closeRecTray(): void {
  recTray?.destroy()
  recTray = null
}

/** Drops the REC pill, the hook and the throttling opt-out — safe to call twice. */
function releaseCapture(session: DemoSession): void {
  closeRecTray()
  if (session.hookRunning) {
    stopGlobalJournal()
    session.hookRunning = false
  }
  const window = mainWindow()
  if (window && !window.isDestroyed() && session.prevBackgroundThrottling !== null) {
    window.webContents.setBackgroundThrottling(session.prevBackgroundThrottling)
  }
  session.prevBackgroundThrottling = null
}

function cleanup(session: DemoSession): void {
  releaseCapture(session)
  if (session.pending) {
    clearTimeout(session.pending.timer)
    session.pending = null
  }
  rmSync(session.tmpDir, { recursive: true, force: true })
  if (active?.sessionId === session.sessionId) active = null
}

/** The machine's displays — what a take can capture. */
export function listDemoDisplays(): Array<{
  id: number
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  primary: boolean
}> {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId
  }))
}

/**
 * The display the ACTIVE session captures — consulted by the display-media
 * handler in main/index.ts to answer getDisplayMedia with the right screen
 * source (null when no live capture is expected).
 */
export function pendingScreenCaptureDisplayId(): number | null {
  return active && !active.external ? active.displayId : null
}

export function startDemo(input: { projectId?: string; displayId?: number; external?: boolean }): {
  sessionId: string
} {
  if (!isDemoEnabled()) throw new Error('Demo mode is not enabled (launch with RACCORD_DEMO=1).')
  if (active) throw new Error('A demo recording is already in progress.')

  const window = mainWindow()
  const display =
    input.displayId !== undefined
      ? (screen.getAllDisplays().find((d) => d.id === input.displayId) ?? null)
      : window && !window.isDestroyed()
        ? screen.getDisplayMatching(window.getBounds())
        : screen.getPrimaryDisplay()
  if (!display) throw new Error(`Unknown displayId ${input.displayId} (see demo:listDisplays).`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'raccord-demo-'))
  const webmPath = join(tmpDir, 'capture.webm')
  const sessionId = `demo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const session: DemoSession = {
    sessionId,
    external: input.external === true,
    projectId: input.projectId ?? null,
    displayId: display.id,
    displayBounds: display.bounds,
    hookRunning: false,
    warnings: [],
    syntheticEvents: [],
    tmpDir,
    webmPath,
    stream: createWriteStream(webmPath),
    nextSeq: 0,
    startedAt: Date.now(),
    prevBackgroundThrottling: null,
    pending: null,
    result: null
  }
  active = session

  if (!session.external) {
    const hook = startGlobalJournal(display.bounds)
    if (hook.ok) session.hookRunning = true
    else session.warnings.push(hook.reason)

    if (window && !window.isDestroyed()) {
      // The renderer keeps recording while Raccord is unfocused/offscreen.
      session.prevBackgroundThrottling = window.webContents.getBackgroundThrottling()
      window.webContents.setBackgroundThrottling(false)
    }
    openRecTray()
    broadcastDemoControl({ action: 'start', sessionId })
  }
  logInfo(
    'demo',
    `recording started (${sessionId}, display ${display.id}${session.external ? ', external' : ''})`
  )
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

/**
 * Agent pointing: tool-driven demos never move the real mouse, so the
 * renderer forwards where focus_node landed (SCREEN coordinates) and the
 * journal gets a synthetic glide + click there — the auto camera's target.
 */
export function demoPoint(input: { x: number; y: number }): void {
  const session = active
  if (!session || session.external) return
  const point = normalizeOnDisplay(input.x, input.y, session.displayBounds)
  if (!point) return
  const nowSec = Date.now() / 1000
  session.syntheticEvents.push({ t: nowSec - 0.4, type: 'move', x: point.x, y: point.y })
  session.syntheticEvents.push({ t: nowSec, type: 'click', x: point.x, y: point.y })
}

/** Delivers a finished take to its destination and builds the stop result. */
function deliverTake(
  session: DemoSession,
  take: FinishedTake,
  projectId: string | null
): DemoStopResult {
  const stamp = new Date(session.startedAt)
  const label = `Demo ${stamp.toISOString().slice(0, 16).replace('T', ' ')}`
  if (projectId) {
    const asset = importAssetFromBytes({
      projectId,
      bytes: readFileSync(take.mediaPath),
      mimeType: take.format === 'mp4' ? 'video/mp4' : 'video/webm',
      name: label,
      description: 'Demo-mode screen recording (input-event journal attached).'
    })
    setAssetDemoEvents(asset.id, take.events, 'screen')
    return {
      assetId: asset.id,
      path: asset.filePath ?? take.mediaPath,
      eventsPath: null,
      durationSec: take.durationSec,
      format: take.format,
      warnings: session.warnings,
      events: take.events
    }
  }
  const base = join(app.getPath('downloads'), label.replace(/[: ]/g, '-'))
  const outPath = `${base}.${take.format}`
  const eventsPath = `${base}.events.json`
  writeFileSync(outPath, readFileSync(take.mediaPath))
  writeFileSync(eventsPath, JSON.stringify(take.events, null, 2))
  return {
    assetId: null,
    path: outPath,
    eventsPath,
    durationSec: take.durationSec,
    format: take.format,
    warnings: session.warnings,
    events: take.events
  }
}

export async function stopDemo(input?: { projectId?: string }): Promise<DemoStopResult> {
  const session = active
  if (!session) throw new Error('No demo recording in progress.')
  const projectId = input?.projectId ?? session.projectId

  let take: FinishedTake
  if (session.result) {
    // External drivers may finish before calling stop — hand the stash over.
    const stashed = session.result
    if ('error' in stashed) {
      cleanup(session)
      throw stashed.error
    }
    take = stashed
  } else {
    if (session.pending) throw new Error('A demo stop is already pending.')
    take = await new Promise<FinishedTake>((resolve, reject) => {
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

  try {
    return deliverTake(session, take, projectId)
  } finally {
    cleanup(session)
  }
}

/**
 * Global-hook and pointing events carry provisional epoch-second times —
 * rebase them onto the capture start (the renderer's recorder.onstart epoch,
 * falling back to the session start), clamp into the take and sort.
 */
function rebaseGlobalEvents(
  events: DemoEvent[],
  startEpochMs: number,
  durationSec: number
): DemoEvent[] {
  const startSec = startEpochMs / 1000
  return events
    .map((e) => ({ ...e, t: e.t - startSec }))
    .filter((e) => e.t >= 0 && e.t <= durationSec)
    .sort((a, b) => a.t - b.t)
}

export async function finishDemo(input: {
  sessionId: string
  durationSec: number
  events: DemoEvent[]
  captureStartEpochMs?: number
  error?: string
}): Promise<void> {
  const session = active
  if (!session || session.sessionId !== input.sessionId) {
    throw new Error('No demo recording matches this session.')
  }

  // The stop timeout only covers the renderer HANDSHAKE. Once finish arrives
  // the take is safe and the transcode may take as long as it needs — a
  // Retina display capture is heavy; timing out here used to destroy the
  // staging dir mid-transcode and lose the take.
  if (session.pending) clearTimeout(session.pending.timer)

  await new Promise<void>((resolve) => session.stream.end(resolve))
  const hookEvents = session.hookRunning ? stopGlobalJournal() : []
  session.hookRunning = false
  releaseCapture(session)

  const settle = (outcome: FinishedTake | { error: Error }): void => {
    if (session.pending) {
      clearTimeout(session.pending.timer)
      const pending = session.pending
      session.pending = null
      if ('error' in outcome) {
        cleanup(session)
        pending.reject(outcome.error)
      } else {
        // stopDemo delivers and cleans up after the await.
        pending.resolve(outcome)
      }
    } else {
      // Stop not called yet: stash — delivery and cleanup happen there.
      session.result = outcome
    }
  }

  if (input.error) {
    settle({ error: new Error(`Demo capture failed: ${input.error}`) })
    return
  }

  // External drivers provide the journal themselves; live takes journal
  // through the machine-wide hook + agent pointing.
  const events = session.external
    ? input.events
    : rebaseGlobalEvents(
        [...hookEvents, ...session.syntheticEvents],
        input.captureStartEpochMs ?? session.startedAt,
        input.durationSec
      )

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
    settle({ mediaPath, format, durationSec: input.durationSec, events })
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
