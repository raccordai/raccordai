import { createRequire } from 'node:module'
import { systemPreferences } from 'electron'
import type { DemoEvent } from '@shared/screenMotion'
import { createMoveThrottle, normalizeOnDisplay } from '@shared/screenMotion'
import { logInfo, logWarn } from './logger'

/**
 * Demo mode (§9) — the GLOBAL input journal of an external SCREEN take: a
 * uiohook (libuiohook) tap collecting mouse/keyboard events machine-wide
 * while the user demos another application. Thin shell (E2E scope, out of
 * unit coverage): normalization/throttling are the shared pure helpers of
 * screenMotion.ts; this file only owns the native module lifecycle.
 *
 * Events carry PROVISIONAL times (epoch seconds) — demo.ts rebases them onto
 * the capture start at finish. The keystroke redaction is identical to the
 * renderer journal: a keydown becomes a bare {t, type:'key'}, never the key.
 *
 * macOS: the tap needs the ACCESSIBILITY permission (plus Input Monitoring
 * for keyboard) granted to the hosting process — the terminal in dev,
 * Raccord.app packaged. Missing permission ⇒ startGlobalJournal reports it
 * and the take records without a journal (no automatic camera), never
 * crashes. The module loads lazily so platforms/CI without the prebuild
 * degrade the same way.
 */

interface UiohookModule {
  uIOhook: {
    on(event: string, handler: (e: { x: number; y: number }) => void): void
    removeAllListeners(): void
    start(): void
    stop(): void
  }
}

let cached: UiohookModule | null | undefined

function loadUiohook(): UiohookModule | null {
  if (cached !== undefined) return cached
  try {
    const require = createRequire(import.meta.url)
    cached = require('uiohook-napi') as UiohookModule
  } catch (error) {
    logWarn('demo', `uiohook-napi unavailable: ${String(error)}`)
    cached = null
  }
  return cached
}

interface ActiveHook {
  events: DemoEvent[]
  module: UiohookModule
}

let activeHook: ActiveHook | null = null

/**
 * Starts collecting global input over the given display. Returns the failure
 * reason (an actionable warning) when the journal cannot be collected.
 */
export function startGlobalJournal(bounds: {
  x: number
  y: number
  width: number
  height: number
}): { ok: true } | { ok: false; reason: string } {
  if (activeHook) return { ok: false, reason: 'A global journal is already running.' }
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    return {
      ok: false,
      reason:
        'macOS Accessibility permission is missing for this app (System Settings → Privacy & Security → Accessibility) — the take records without an input journal, so the automatic camera will not apply.'
    }
  }
  const module = loadUiohook()
  if (!module) {
    return { ok: false, reason: 'The global input hook could not be loaded on this platform.' }
  }

  const events: DemoEvent[] = []
  const throttle = createMoveThrottle()
  const nowSec = (): number => Date.now() / 1000
  const positioned = (type: DemoEvent['type'], e: { x: number; y: number }): void => {
    const point = normalizeOnDisplay(e.x, e.y, bounds)
    if (!point) return
    const event: DemoEvent = { t: nowSec(), type, x: point.x, y: point.y }
    if (type === 'move') {
      const kept = throttle(event)
      if (kept) events.push(kept)
    } else {
      events.push(event)
    }
  }

  try {
    module.uIOhook.on('mousedown', (e) => positioned('click', e))
    module.uIOhook.on('mousemove', (e) => positioned('move', e))
    module.uIOhook.on('wheel', (e) => positioned('scroll', e))
    // Redaction: the fact of a keystroke only — never which key.
    module.uIOhook.on('keydown', () => events.push({ t: nowSec(), type: 'key' }))
    module.uIOhook.start()
  } catch (error) {
    module.uIOhook.removeAllListeners()
    return { ok: false, reason: `The global input hook failed to start: ${String(error)}` }
  }
  activeHook = { events, module }
  logInfo('demo', 'global input journal started')
  return { ok: true }
}

/** Stops the tap and returns the collected events (provisional epoch-second times). */
export function stopGlobalJournal(): DemoEvent[] {
  if (!activeHook) return []
  const { events, module } = activeHook
  activeHook = null
  try {
    module.uIOhook.stop()
    module.uIOhook.removeAllListeners()
  } catch (error) {
    logWarn('demo', `global input hook did not stop cleanly: ${String(error)}`)
  }
  logInfo('demo', `global input journal stopped (${events.length} events)`)
  return events
}
