/**
 * Global renderer error funnel. Silent failure used to be the default: no
 * ErrorBoundary, a bare QueryClient, mutations without onError. Everything
 * unhandled now converges here — one toast for the user (deduped, since the
 * same failure often surfaces through several paths at once) and one line in
 * main's log file via the `log:renderer` channel.
 */

export function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Time-window dedupe keyed by message: returns true when the key has not been
 * seen within the window. The map is pruned in passing so it stays bounded.
 */
export function createDeduper(windowMs: number): (key: string, now: number) => boolean {
  const seen = new Map<string, number>()
  return (key, now) => {
    const last = seen.get(key)
    if (last !== undefined && now - last < windowMs) return false
    if (seen.size > 100) {
      for (const [k, at] of seen) if (now - at >= windowMs) seen.delete(k)
    }
    seen.set(key, now)
    return true
  }
}

type ToastFn = (message: string) => void
let toastListener: ToastFn | null = null

/** FeedbackProvider registers its error toast here on mount. */
export function setErrorToastListener(fn: ToastFn | null): void {
  toastListener = fn
}

/**
 * Logs to main's file (stack included) and, unless `toast: false`, surfaces
 * the message as an error toast. Never throws — this is the last resort.
 */
export function reportRendererError(
  scope: string,
  error: unknown,
  options?: { toast?: boolean }
): void {
  const message = normalizeErrorMessage(error)
  const detail = error instanceof Error && error.stack ? error.stack : message
  try {
    void window.api.invoke('log:renderer', {
      level: 'error',
      scope,
      message: detail.slice(0, 10_000)
    })
  } catch {
    // The bridge itself is down — the console is all that's left.
    console.error(`[${scope}]`, error)
  }
  if (options?.toast !== false) toastListener?.(message)
}

/** Window-level nets: uncaught exceptions and unhandled promise rejections. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    reportRendererError('window', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError('promise', event.reason)
  })
}
