import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron'
import type { DemoEvent } from '@shared/screenMotion'
import { normalizeOnDisplay } from '@shared/screenMotion'
import { ffmpegPath } from '../media/ffbin'
import { broadcastDemoControl, broadcastDemoGesture } from '../events'
import type { DemoGesturePayload } from '@shared/ipc/contracts'
import { buildDemoTranscodeArgs } from './renderPlan'
import { importAssetFromBytes, setAssetDemoEvents } from './assets'
import { startGlobalJournal, stopGlobalJournal } from './demoGlobalHook'
import { listDemoWindows, trackWindowBounds } from './demoWindows'
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
  /**
   * 'window' films Raccord's own window (frame capture — pixel-exact content,
   * no Screen Recording prompt, other windows never in the take); 'app'
   * films ONE third-party window (desktopCapturer window source + System
   * Events bounds polling); 'display' films a whole screen.
   */
  target: 'window' | 'display' | 'app'
  /** target 'app': the demoed application's process name + its polled window state. */
  appName: string | null
  appWindowTitle: string | null
  appBounds: Electron.Rectangle | null
  appPoll: NodeJS.Timeout | null
  /** True once the gesture engine drove the UI: its visible cursor is in the pixels. */
  staged: boolean
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

/** Drops the REC tray, the hook, the app poll and the throttling opt-out — safe to call twice. */
function releaseCapture(session: DemoSession): void {
  closeRecTray()
  if (session.appPoll) {
    clearInterval(session.appPoll)
    session.appPoll = null
  }
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
 * source. Null for window/app takes and when no live capture is expected.
 */
export function pendingScreenCaptureDisplayId(): number | null {
  return active && !active.external && active.target === 'display' ? active.displayId : null
}

/**
 * The third-party WINDOW title the ACTIVE session captures — the display-media
 * handler matches it against desktopCapturer window sources. Null outside an
 * 'app' take (the handler then falls back per pendingScreenCaptureDisplayId).
 */
export function pendingAppWindowTitle(): string | null {
  return active && !active.external && active.target === 'app' ? active.appWindowTitle : null
}

/** The capture area the journal normalizes against — live, so a window take follows its window. */
function captureBounds(session: DemoSession): Electron.Rectangle {
  if (session.target === 'window') {
    const window = mainWindow()
    if (window && !window.isDestroyed()) return window.getContentBounds()
  }
  if (session.target === 'app' && session.appBounds) return session.appBounds
  return session.displayBounds
}

export async function startDemo(input: {
  projectId?: string
  target?: 'window' | 'display' | 'app'
  app?: string
  windowTitle?: string
  displayId?: number
  external?: boolean
}): Promise<{
  sessionId: string
}> {
  if (!isDemoEnabled()) throw new Error('Demo mode is not enabled (launch with RACCORD_DEMO=1).')
  if (active) throw new Error('A demo recording is already in progress.')

  // Default: film Raccord's own window; an app name implies an 'app' take, a
  // displayId (or external driver mode) implies a display take.
  const target =
    input.target ??
    (input.app !== undefined
      ? 'app'
      : input.displayId !== undefined || input.external === true
        ? 'display'
        : 'window')

  // target 'app': resolve the third-party window BEFORE opening the session —
  // its title pins the capture source, its bounds feed the journal. An
  // explicit windowTitle picks ONE window (a browser demo tab) instead of
  // whatever window happens to be frontmost.
  let appWindow: { app: string; title: string; bounds: Electron.Rectangle } | null = null
  if (target === 'app') {
    const query = input.app?.trim().toLowerCase()
    if (!query) throw new Error('target "app" needs the application name (see demo:listWindows).')
    const wantedTitle = input.windowTitle?.trim().toLowerCase()
    const candidates = (await listDemoWindows()).filter((w) => {
      const name = w.app.toLowerCase()
      return name.includes(query) || query.includes(name)
    })
    appWindow = wantedTitle
      ? (candidates.find((w) => w.title.toLowerCase().includes(wantedTitle)) ?? null)
      : (candidates[0] ?? null)
    if (!appWindow) {
      throw new Error(
        wantedTitle
          ? `No "${input.app}" window matches title "${input.windowTitle}" (demo:listWindows lists them).`
          : `No visible window found for "${input.app}" (demo:listWindows lists them; macOS Accessibility is required).`
      )
    }
  }

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
  const sessionId = `demo_${randomUUID()}`
  const session: DemoSession = {
    sessionId,
    external: input.external === true,
    projectId: input.projectId ?? null,
    target,
    appName: appWindow?.app ?? null,
    appWindowTitle: appWindow?.title ?? null,
    appBounds: appWindow?.bounds ?? null,
    appPoll: null,
    staged: false,
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
    const hook = startGlobalJournal(() => captureBounds(session))
    if (hook.ok) session.hookRunning = true
    else session.warnings.push(hook.reason)

    if (session.target === 'app' && session.appName) {
      // The demoed window moves/resizes — follow it BY GEOMETRY (its title
      // changes on every navigation in a browser take, geometry does not).
      const appName = session.appName
      session.appPoll = setInterval(() => {
        const last = session.appBounds
        if (!last) return
        void trackWindowBounds(appName, last).then((bounds) => {
          if (bounds && active?.sessionId === session.sessionId) session.appBounds = bounds
        })
      }, 1000)
    }

    if (window && !window.isDestroyed()) {
      // The renderer keeps recording while Raccord is unfocused/offscreen.
      session.prevBackgroundThrottling = window.webContents.getBackgroundThrottling()
      window.webContents.setBackgroundThrottling(false)
    }
    openRecTray()
    broadcastDemoControl({ action: 'start', sessionId })
  }
  const targetLabel =
    target === 'window'
      ? 'app window'
      : target === 'app'
        ? `window of ${appWindow?.app}`
        : `display ${display.id}`
  logInfo(
    'demo',
    `recording started (${sessionId}, ${targetLabel}${session.external ? ', external' : ''})`
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

// ── Gesture engine (§9) — request/response with the renderer ────────────────

const GESTURE_TIMEOUT_MS = 8_000

const pendingGestures = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()

/**
 * Performs one REAL UI gesture in the renderer (visible cursor + genuine DOM
 * events) and resolves when the renderer reports back. Works outside a take
 * too (rehearsal, tests); during a take it marks the session `staged` so the
 * render skips the synthetic cursor (the visible one is in the pixels).
 */
export function performGesture(gesture: DemoGesturePayload['gesture']): Promise<{ ok: true }> {
  const window = mainWindow()
  if (!window || window.isDestroyed()) {
    return Promise.reject(new Error('No app window to perform the gesture in.'))
  }
  const requestId = `g_${randomUUID()}`
  return new Promise((resolve, reject) => {
    pendingGestures.set(requestId, {
      resolve: () => resolve({ ok: true }),
      reject,
      timer: setTimeout(() => {
        pendingGestures.delete(requestId)
        reject(new Error('The gesture timed out (renderer unresponsive).'))
      }, GESTURE_TIMEOUT_MS)
    })
    broadcastDemoGesture({ requestId, gesture })
  })
}

/** The renderer's report for a pending gesture. */
export function gestureResult(input: { requestId: string; ok: boolean; error?: string }): void {
  const pending = pendingGestures.get(input.requestId)
  if (!pending) return
  pendingGestures.delete(input.requestId)
  clearTimeout(pending.timer)
  if (input.ok) {
    if (active && !active.external) active.staged = true
    pending.resolve()
  } else {
    pending.reject(new Error(input.error ?? 'The gesture failed.'))
  }
}

/**
 * Agent pointing: tool-driven demos never move the real mouse, so the
 * renderer forwards where focus_node landed (SCREEN coordinates) and the
 * journal gets a synthetic glide + click there — the auto camera's target.
 */
export function demoPoint(input: { x: number; y: number }): void {
  const session = active
  if (!session || session.external) return
  const point = normalizeOnDisplay(input.x, input.y, captureBounds(session))
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
    setAssetDemoEvents(
      asset.id,
      take.events,
      session.staged ? 'staged' : session.target === 'window' ? 'self' : 'screen'
    )
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
  if (!session.external && !input.error && events.length === 0) {
    session.warnings.push(
      'The take has NO input journal — the automatic camera and cursor will not apply. Check the macOS Accessibility permission of the launching process, or point with focus_node during agent-driven takes.'
    )
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
