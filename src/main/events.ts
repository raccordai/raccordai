import { BrowserWindow } from 'electron'
import type {
  FocusNodePayload,
  NavigatePayload,
  RenderProgressPayload
} from '@shared/ipc/contracts'
import { recordChange } from './services/changeFeed'

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
  recordChange('generations', payload)
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:generationsChanged', payload)
  }
}

/** The assistant (or any main-side actor) mutated the graph — renderer refetches. */
export function broadcastWorkflowChanged(videoId: string): void {
  recordChange('workflow', { videoId })
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:workflowChanged', { videoId })
  }
}

/** A generation settled — the kie.ai balance likely moved; the toolbar refetches it. */
export function broadcastCreditsChanged(): void {
  recordChange('credits')
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:creditsChanged', {})
  }
}

export function broadcastChatUpdate(threadId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:chatUpdate', { threadId })
  }
}

/** MP4 render progress (see RenderProgressPayload in the shared contracts). */
export function broadcastRenderProgress(payload: RenderProgressPayload): void {
  recordChange('render-progress', { videoId: payload.videoId })
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:renderProgress', payload)
  }
}

/** The run queue moved (enqueue/start/settle/retry) — refetch generations:queueState. */
export function broadcastQueueChanged(): void {
  recordChange('queue')
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:queueChanged', {})
  }
}

/** Ask the editor to center a node (completion notification click). */
export function broadcastFocusNode(payload: FocusNodePayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:focusNode', payload)
  }
}

/** The assistant asks the app to navigate to a route (open_video tool). */
export function broadcastNavigate(payload: NavigatePayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:navigate', payload)
  }
}

/** Niche research data changed (any actor) — the Niches pages refetch. */
export function broadcastNichesChanged(): void {
  recordChange('niches')
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:nichesChanged', {})
  }
}

/** Voice personas changed (any actor) — persona pickers and lists refetch. */
export function broadcastVoicePersonasChanged(): void {
  recordChange('voice-personas')
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('event:voicePersonasChanged', {})
  }
}
