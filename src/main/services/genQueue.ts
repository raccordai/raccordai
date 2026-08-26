/**
 * Generation queue — bounds how many kie.ai generations are in flight at once.
 *
 * A slot is held from submission until the generation settles (success or
 * failure), not just during the createTask call: the concurrency limit is a
 * real budget control, not a rate limiter. Slot release is wired to the
 * `generationSettled` bus event by the run engine.
 *
 * Pure in-memory scheduling with injected concurrency — unit-testable without
 * Electron or the network.
 */

interface QueueItem {
  id: string
  start: () => Promise<void>
}

export class GenerationQueue {
  private active = new Set<string>()
  private waiting: QueueItem[] = []

  /**
   * `onChange` fires after every state transition (enqueue, adopt, release,
   * a waiting task starting) — the run engine broadcasts it to the renderer.
   * `onTaskError` fires when a started task rejects: the task normally settles
   * its own failure, so a rejection reaching here means it threw before that
   * path — the callback must settle or release `id`, or the slot leaks.
   */
  constructor(
    private readonly concurrency: () => number,
    private readonly onChange?: () => void,
    private readonly onTaskError?: (id: string, err: unknown) => void
  ) {}

  /** Schedules a task; it starts as soon as a slot is free (FIFO). */
  enqueue(id: string, start: () => Promise<void>): void {
    if (this.active.has(id) || this.waiting.some((w) => w.id === id)) return
    this.waiting.push({ id, start })
    this.pump()
    this.onChange?.()
  }

  /**
   * Occupies a slot for work already in flight (startup resume of a
   * generation that was submitted before the app quit).
   */
  adopt(id: string): void {
    this.active.add(id)
    this.onChange?.()
  }

  /** Frees the slot held by `id` (no-op for unknown ids) and starts waiting work. */
  release(id: string): void {
    this.active.delete(id)
    this.waiting = this.waiting.filter((w) => w.id !== id)
    this.pump()
    this.onChange?.()
  }

  /** Ids in flight and ids still waiting, in start order. */
  snapshot(): { running: string[]; queued: string[] } {
    return { running: [...this.active], queued: this.waiting.map((w) => w.id) }
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.active.size < Math.max(1, this.concurrency())) {
      const item = this.waiting.shift()!
      this.active.add(item.id)
      void item.start().catch((err) => {
        // The task is responsible for its own failure handling (failGeneration
        // → settle event → release). A rejection landing here means the task
        // threw before reaching that path: without the callback the throw is
        // swallowed and the slot is held until restart.
        this.onTaskError?.(item.id, err)
      })
    }
  }
}

/**
 * Failures that will repeat identically on every attempt. Deliberately keyed
 * on kie's STRUCTURED signals only (Romain's call): content-policy wording,
 * and a 4xx status/failCode embedded in the message — "(4xx)" from
 * createTask/checkRemoteStatus, or "status/code/error/HTTP 4xx" prose. Codes
 * are only matched with that context so bare numbers ("512px", "worker 403")
 * stay neutral. Free-text model errors without a code (e.g. "reference audio
 * too long") are NOT pattern-matched: a few wasted retries beat
 * misclassifying a transient failure as permanent.
 */
const STATUS_CTX = String.raw`(?:\(|\b(?:http|status|code|error)\s*:?\s*)`
const PERMANENT_FAILURE = new RegExp(
  /violat|policy|moderat|flagg|censor|nsfw|safety|sensitive|prohibit|inappropriate|reject/.source +
    String.raw`|${STATUS_CTX}4\d\d\b`,
  'i'
)

/**
 * Transient signals win over PERMANENT_FAILURE: 408/429 are 4xx yet worth
 * retrying, and rate-limit wording ("rate limit exceeded") would otherwise
 * trip the permanent patterns.
 */
const TRANSIENT_FAILURE = new RegExp(
  String.raw`rate.?limit|too many requests|${STATUS_CTX}(?:408|429|5\d\d)\b|timed?\s?out|overload|temporar|try again later`,
  'i'
)

/** Whether a failed generation is worth re-submitting (smart retry). */
export function isRetryableGenerationError(message: string): boolean {
  if (TRANSIENT_FAILURE.test(message)) return true
  return !PERMANENT_FAILURE.test(message)
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  /** Return false to fail immediately (e.g. a 4xx that will never succeed). */
  isTransient?: (error: unknown) => boolean
}

/** Runs `fn`, retrying transient failures with linear backoff (1×, 2×, 3× base delay). */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 2000
  const isTransient = options.isTransient ?? (() => true)

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isTransient(err)) break
      await new Promise((resolve) => setTimeout(resolve, attempt * baseDelayMs))
    }
  }
  throw lastError
}
