import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Persistent file log for the main process — the only place errors survive a
 * packaged build (console output is invisible there, and open-source support
 * without a log file is blind). Deliberately tiny instead of electron-log:
 * synchronous appends (low volume), one size-based rotation, no transports.
 *
 * Renderer errors reach the same file through the `log:renderer` IPC channel.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string, cause?: unknown): void
  /** Absolute path of the current log file. */
  readonly filePath: string
}

/** One rotation: main.log → main.log.1 (the previous .1 is dropped). */
const DEFAULT_MAX_BYTES = 1024 * 1024

/** `Error` → message + stack, anything else → String(). */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`
  return String(cause)
}

export function formatLogLine(
  now: Date,
  level: LogLevel,
  scope: string,
  message: string,
  cause?: unknown
): string {
  const suffix = cause === undefined ? '' : ` — ${describeCause(cause)}`
  // Multi-line stacks stay greppable: continuation lines are indented.
  return `${now.toISOString()} [${level}] [${scope}] ${message}${suffix}`.replace(/\n/g, '\n    ')
}

export function createLogger(options: {
  dir: string
  maxBytes?: number
  /** Mirror warn/error to the console (dev builds). */
  mirror?: boolean
}): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const filePath = join(options.dir, 'main.log')
  let ready = false

  const write = (level: LogLevel, scope: string, message: string, cause?: unknown): void => {
    // Logging must never take the app down — swallow fs errors (full disk,
    // read-only home…) after mirroring to the console.
    try {
      if (!ready) {
        mkdirSync(options.dir, { recursive: true })
        ready = true
      }
      rotateIfNeeded()
      appendFileSync(filePath, `${formatLogLine(new Date(), level, scope, message, cause)}\n`)
    } catch (err) {
      console.error('[logger] write failed:', err)
    }
    if (options.mirror && level !== 'info') {
      console[level](`[${scope}] ${message}`, ...(cause === undefined ? [] : [cause]))
    }
  }

  const rotateIfNeeded = (): void => {
    try {
      if (statSync(filePath).size < maxBytes) return
    } catch {
      return // no file yet
    }
    rmSync(`${filePath}.1`, { force: true })
    renameSync(filePath, `${filePath}.1`)
  }

  return {
    filePath,
    info: (scope, message) => write('info', scope, message),
    warn: (scope, message) => write('warn', scope, message),
    error: (scope, message, cause) => write('error', scope, message, cause)
  }
}

let singleton: Logger | null = null

/** The app-wide logger (userData/logs/main.log). Lazily created. */
export function getLogger(): Logger {
  if (!singleton) {
    singleton = createLogger({
      dir: join(app.getPath('userData'), 'logs'),
      mirror: !app.isPackaged
    })
  }
  return singleton
}

/** Shorthand used across main services. */
export function logError(scope: string, message: string, cause?: unknown): void {
  getLogger().error(scope, message, cause)
}

export function logWarn(scope: string, message: string): void {
  getLogger().warn(scope, message)
}

export function logInfo(scope: string, message: string): void {
  getLogger().info(scope, message)
}
