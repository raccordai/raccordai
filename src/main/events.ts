import { BrowserWindow } from 'electron'
import type { RenderProgressPayload } from '@shared/ipc/contracts'

/**
 * Main→renderer push events. The desktop replacement for Convex's reactive
 * queries: state changes in the main process broadcast an event; the renderer
 * invalidates the matching TanStack Query keys.
 */

export interface GenerationsChangedEvent {
  videoId: string
  nodeId: string
}

export function broadcastGenerationsChanged(payload: GenerationsChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:generationsChanged', payload)
  }
}

/** The assistant (or any main-side actor) mutated the graph — renderer refetches. */
export function broadcastWorkflowChanged(videoId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:workflowChanged', { videoId })
  }
}

/** A generation settled — the kie.ai balance likely moved; the toolbar refetches it. */
export function broadcastCreditsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:creditsChanged', {})
  }
}

export function broadcastChatUpdate(videoId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:chatUpdate', { videoId })
  }
}

/** MP4 render progress (see RenderProgressPayload in the shared contracts). */
export function broadcastRenderProgress(payload: RenderProgressPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:renderProgress', payload)
  }
}
