import type { DemoEvent } from '@shared/screenMotion'

/**
 * Demo mode (§9) — the decision-shaped parts of the input-event journal, kept
 * pure so they are unit-testable: event normalization (with the keystroke
 * redaction rule), pointer-move coalescing and the base64 chunking of the
 * MediaRecorder blobs. The recorder store (features/demo) only wires these to
 * the DOM and the IPC bridge.
 */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * One journal entry from a raw DOM sample. Coordinates are normalized to the
 * capture frame (window content size). Key events carry NO position and NO key
 * value — `DemoEvent` has no field for either, which IS the redaction: what
 * the user types (passwords included) never reaches the journal, only the
 * fact that they typed.
 */
export function normalizeEvent(
  type: DemoEvent['type'],
  tSec: number,
  clientX: number,
  clientY: number,
  innerWidth: number,
  innerHeight: number
): DemoEvent {
  const t = Math.max(0, tSec)
  if (type === 'key') return { t, type }
  if (innerWidth <= 0 || innerHeight <= 0) return { t, type }
  return { t, type, x: clamp01(clientX / innerWidth), y: clamp01(clientY / innerHeight) }
}

/**
 * Latest-sample-per-window coalescing for pointermove: at most one move event
 * per interval, always the most recent position (the glide compiler only
 * needs waypoints, not every 8 ms sample).
 */
export function createMoveThrottle(intervalSec = 0.08): (event: DemoEvent) => DemoEvent | null {
  let windowStart = -Infinity
  return (event) => {
    if (event.t - windowStart < intervalSec) return null
    windowStart = event.t
    return event
  }
}

/**
 * Bytes → base64 strings sized for the IPC boundary (the handle() wrapper
 * zod-parses every payload, so one giant string is off the table). The
 * 0x8000-slice String.fromCharCode loop avoids the spread-arg stack overflow
 * on big buffers (same loop as useLastFrameExtractor).
 */
export function toBase64Chunks(bytes: Uint8Array, maxChars = 4_000_000): string[] {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const base64 = btoa(binary)
  // Main decodes each chunk independently (Buffer.from per appendChunk), so
  // every cut must land on a 4-char base64 boundary (4 chars = 3 bytes).
  const step = Math.max(4, maxChars - (maxChars % 4))
  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += step) {
    chunks.push(base64.slice(i, i + step))
  }
  return chunks
}
