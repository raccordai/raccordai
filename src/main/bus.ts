import { EventEmitter } from 'node:events'

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
}

const emitter = new EventEmitter()

export function emitGenerationSettled(event: GenerationSettledEvent): void {
  emitter.emit('generationSettled', event)
}

export function onGenerationSettled(listener: (event: GenerationSettledEvent) => void): void {
  emitter.on('generationSettled', listener)
}
