/**
 * Spec scaffolding: reporting, assertions, polling and deferred cleanup.
 *
 * Every spec file is a standalone Node program (`node e2e/specs/<name>.e2e.mjs`)
 * so a single scenario can be debugged without the runner. `spec()` owns the
 * exit code and guarantees the deferred teardown runs even on failure.
 */

const cleanups = []

/** Registers a teardown callback, run LIFO when the spec ends (pass or fail). */
export function defer(fn) {
  cleanups.push(fn)
}

export function step(label) {
  console.log(`  · ${label}`)
}

export function ok(label) {
  console.log(`  ✓ ${label}`)
}

export function check(condition, label) {
  if (!condition) throw new Error(label)
  ok(label)
}

export function checkEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} — expected ${expected}, got ${actual}`)
  ok(`${label} (${actual})`)
}

/** Numeric assertion with a tolerance — durations never land on the exact value. */
export function checkClose(actual, expected, tolerance, label) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${label} — expected ${expected} ±${tolerance}, got ${actual}`)
  }
  ok(`${label} (${actual})`)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls `fn` until it returns a truthy value; resolves with that value.
 * Everything asynchronous in the app (poller, downloads, UI refresh) is waited
 * on this way — never with a bare sleep, which is what makes E2E flaky.
 */
export async function waitFor(fn, { label, timeout = 30_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
      throw new Error(`timeout after ${timeout}ms waiting for ${label ?? 'condition'}${detail}`)
    }
    await sleep(interval)
  }
}

/** Runs a spec body, reports it, and always drains the cleanup stack. */
export async function spec(name, body) {
  const started = Date.now()
  console.log(`▶ ${name}`)
  let failure
  try {
    await body()
  } catch (error) {
    failure = error
    // Set before the teardown runs: cleanups (app.close) use the exit code to
    // decide whether to dump diagnostics.
    process.exitCode = 1
  }
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch (error) {
      console.error(`  ! cleanup failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  cleanups.length = 0
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (failure) {
    console.error(`✗ ${name} FAILED after ${seconds}s`)
    console.error(failure instanceof Error ? (failure.stack ?? failure.message) : failure)
    return
  }
  console.log(`✓ ${name} passed in ${seconds}s`)
}
