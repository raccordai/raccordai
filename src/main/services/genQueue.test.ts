import { describe, expect, it } from 'vitest'
import { GenerationQueue, isRetryableGenerationError, withRetry } from './genQueue'

/** A task that records when it starts and resolves when told to. */
function task(started: string[], id: string): () => Promise<void> {
  return () => {
    started.push(id)
    return new Promise<void>((resolve) => resolve())
  }
}

describe('GenerationQueue', () => {
  it('starts tasks up to the concurrency limit, FIFO', () => {
    const queue = new GenerationQueue(() => 2)
    const started: string[] = []
    queue.enqueue('a', task(started, 'a'))
    queue.enqueue('b', task(started, 'b'))
    queue.enqueue('c', task(started, 'c'))
    expect(started).toEqual(['a', 'b'])
    expect(queue.snapshot()).toEqual({ running: ['a', 'b'], queued: ['c'] })
  })

  it('release frees the slot and starts the next task', () => {
    const queue = new GenerationQueue(() => 1)
    const started: string[] = []
    queue.enqueue('a', task(started, 'a'))
    queue.enqueue('b', task(started, 'b'))
    expect(started).toEqual(['a'])
    queue.release('a')
    expect(started).toEqual(['a', 'b'])
    queue.release('b')
    expect(queue.snapshot()).toEqual({ running: [], queued: [] })
  })

  it('release cancels a task still waiting in the queue', () => {
    const queue = new GenerationQueue(() => 1)
    const started: string[] = []
    queue.enqueue('a', task(started, 'a'))
    queue.enqueue('b', task(started, 'b'))
    queue.release('b') // cancelled before it ever ran
    queue.release('a')
    expect(started).toEqual(['a'])
    expect(queue.snapshot()).toEqual({ running: [], queued: [] })
  })

  it('notifies onChange on every transition', () => {
    let changes = 0
    const queue = new GenerationQueue(
      () => 1,
      () => changes++
    )
    const started: string[] = []
    queue.enqueue('a', task(started, 'a')) // starts immediately
    queue.enqueue('b', task(started, 'b')) // waits
    expect(changes).toBe(2)
    queue.release('a') // frees the slot, b starts
    expect(changes).toBe(3)
    queue.adopt('resumed')
    expect(changes).toBe(4)
  })

  it('adopt occupies a slot without running anything', () => {
    const queue = new GenerationQueue(() => 1)
    const started: string[] = []
    queue.adopt('resumed')
    queue.enqueue('a', task(started, 'a'))
    expect(started).toEqual([])
    queue.release('resumed')
    expect(started).toEqual(['a'])
  })

  it('ignores duplicate enqueues of the same id', () => {
    const queue = new GenerationQueue(() => 1)
    const started: string[] = []
    queue.enqueue('a', task(started, 'a'))
    queue.enqueue('a', task(started, 'a-again'))
    queue.release('a')
    expect(started).toEqual(['a'])
  })

  it('honors a live concurrency change on the next pump', () => {
    let limit = 1
    const queue = new GenerationQueue(() => limit)
    const started: string[] = []
    queue.enqueue('a', task(started, 'a'))
    queue.enqueue('b', task(started, 'b'))
    queue.enqueue('c', task(started, 'c'))
    expect(started).toEqual(['a'])
    limit = 3
    queue.release('a')
    expect(started).toEqual(['a', 'b', 'c'])
  })
})

describe('isRetryableGenerationError', () => {
  it('retries transient provider failures', () => {
    expect(isRetryableGenerationError('kie.ai task failed')).toBe(true)
    expect(isRetryableGenerationError('Internal server error (500)')).toBe(true)
    expect(isRetryableGenerationError('upstream timeout, please try again')).toBe(true)
    expect(isRetryableGenerationError('model overloaded')).toBe(true)
  })

  it('never retries content-policy rejections', () => {
    expect(
      isRetryableGenerationError('Your prompt was flagged as violating content policies')
    ).toBe(false)
    // Exact kie.ai message observed in production (image models).
    expect(
      isRetryableGenerationError(
        'The input or output was flagged as sensitive. Please try again with different inputs.'
      )
    ).toBe(false)
    expect(isRetryableGenerationError('Rejected by content moderation')).toBe(false)
    expect(isRetryableGenerationError('input contains sensitive content')).toBe(false)
    expect(isRetryableGenerationError('NSFW content detected')).toBe(false)
    expect(isRetryableGenerationError('image prohibited by safety system')).toBe(false)
  })

  it('never retries 4xx-class errors (invalid params, credits)', () => {
    expect(isRetryableGenerationError('kie.ai createTask failed (422): invalid input')).toBe(false)
    expect(isRetryableGenerationError('kie.ai createTask failed (402): insufficient credits')).toBe(
      false
    )
    // Remote task fail with the failCode relayed by checkRemoteStatus.
    expect(isRetryableGenerationError('(400) reference audio rejected')).toBe(false)
    expect(isRetryableGenerationError('Request failed with status code 400')).toBe(false)
    expect(isRetryableGenerationError('upstream returned HTTP 404')).toBe(false)
  })

  it('retries un-coded model errors — only kie codes and policy wording are trusted', () => {
    // Deliberate (see PERMANENT_FAILURE): without a 4xx code from kie, a
    // deterministic model error costs a few retries rather than risking a
    // transient one being misclassified as permanent.
    expect(isRetryableGenerationError('reference audio duration is not accepted')).toBe(true)
    expect(isRetryableGenerationError('(400) reference audio duration is not accepted')).toBe(false)
  })

  it('retries rate limits and transient 4xx/5xx despite permanent-looking wording', () => {
    expect(isRetryableGenerationError('rate limit exceeded, retry shortly')).toBe(true)
    expect(isRetryableGenerationError('(429) Too Many Requests')).toBe(true)
    expect(isRetryableGenerationError('kie.ai createTask failed (503): service unavailable')).toBe(
      true
    )
    expect(isRetryableGenerationError('model temporarily unavailable')).toBe(true)
  })

  it('does not read bare numbers as status codes', () => {
    expect(isRetryableGenerationError('render node crashed at frame 403')).toBe(true)
    expect(isRetryableGenerationError('generation stalled (worker 512 died)')).toBe(true)
  })
})

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries transient failures then succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('HTTP 500')
        return 'ok'
      },
      { attempts: 3, baseDelayMs: 1 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error(`fail ${calls}`)
        },
        { attempts: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrowError('fail 3')
    expect(calls).toBe(3)
  })

  it('stops immediately on a non-transient error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new Error('kie.ai createTask failed (401): unauthorized')
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          isTransient: (err) => !/\((4\d\d)\)/.test(err instanceof Error ? err.message : '')
        }
      )
    ).rejects.toThrowError(/401/)
    expect(calls).toBe(1)
  })
})
