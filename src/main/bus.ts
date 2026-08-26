import { EventEmitter } from 'node:events'
import { logError } from './services/logger'

/**
 * In-main event bus — lets services react to each other without circular
 * imports (e.g. the run engine notifying the chat service that a generation
 * it launched has settled).
 */

export interface GenerationSettledEvent {
  generationId: string
  videoId: string
  nodeId: string
  status: 'success' | 'failed'
  errorMessage: string | null
  /** Vision-QC outcome (§6.2), already persisted when the event fires. Absent when QC didn't run. */
  qcVerdict?: 'pass' | 'warn' | 'error' | null
  qcNotes?: string | null
}

const emitter = new EventEmitter()
// A large batch waits on one listener per in-flight generation — the default
// cap of 10 would spam MaxListenersExceededWarning.
emitter.setMaxListeners(0)

export function emitGenerationSettled(event: GenerationSettledEvent): void {
  emitter.emit('generationSettled', event)
}

/** Subscribe; returns the unsubscribe (the batch engine adds/removes waiters). */
export function onGenerationSettled(listener: (event: GenerationSettledEvent) => void): () => void {
  // emit() is synchronous: an unguarded listener that throws would skip every
  // listener registered after it — including the queue-slot release and the
  // batch waiters, which then never wake up.
  const safe = (event: GenerationSettledEvent): void => {
    try {
      listener(event)
    } catch (err) {
      logError('bus', 'generationSettled listener failed', err)
    }
  }
  emitter.on('generationSettled', safe)
  return () => emitter.off('generationSettled', safe)
}
