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

  constructor(private readonly concurrency: () => number) {}

  /** Schedules a task; it starts as soon as a slot is free (FIFO). */
  enqueue(id: string, start: () => Promise<void>): void {
    if (this.active.has(id) || this.waiting.some((w) => w.id === id)) return
    this.waiting.push({ id, start })
    this.pump()
  }

  /**
   * Occupies a slot for work already in flight (startup resume of a
   * generation that was submitted before the app quit).
   */
  adopt(id: string): void {
    this.active.add(id)
  }

  /** Frees the slot held by `id` (no-op for unknown ids) and starts waiting work. */
  release(id: string): void {
    this.active.delete(id)
    this.waiting = this.waiting.filter((w) => w.id !== id)
    this.pump()
  }

  snapshot(): { active: number; waiting: number } {
    return { active: this.active.size, waiting: this.waiting.length }
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.active.size < Math.max(1, this.concurrency())) {
      const item = this.waiting.shift()!
      this.active.add(item.id)
      void item.start().catch(() => {
        // The task is responsible for its own failure handling (failGeneration
        // → settle event → release). This catch only prevents an unhandled
        // rejection from a task that throws before reaching that path.
      })
    }
  }
}

/**
 * Failures that will repeat identically on every attempt: content-policy
 * rejections (kie phrases them with "violate/policy/flagged/…") and 4xx-class
 * errors (invalid params, insufficient credits — the kie code is embedded in
 * the message as "(4xx)").
 */
const PERMANENT_FAILURE =
  /violat|policy|moderat|flagg|censor|nsfw|safety|sensitive|prohibit|inappropriate|reject|\(4\d\d\)/i

/** Whether a failed generation is worth re-submitting (smart retry). */
export function isRetryableGenerationError(message: string): boolean {
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
