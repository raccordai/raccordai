import { BrowserWindow, Notification } from 'electron'
import { eq } from 'drizzle-orm'
import { resources } from '@shared/i18n/resources'
import { getDb } from '../db/client'
import { nodes } from '../db/schema'
import { onGenerationSettled } from '../bus'
import { broadcastFocusNode } from '../events'
import { getLocale, getNotifyOnCompletion } from './settings'

/**
 * OS completion notifications — the desktop answer to "is it done yet?" while
 * the app sits in the background. Per-generation notifications only fire when
 * no window is focused (a visible editor already shows the state live);
 * clicking one focuses the window and centers the node (event:focusNode).
 */

type NotificationStrings = (typeof resources)['en']['common']['notifications']

function str(key: keyof NotificationStrings, vars: Record<string, string | number> = {}): string {
  let text: string = resources[getLocale()].common.notifications[key]
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${name}}}`, String(value))
  }
  return text
}

function anyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => w.isFocused())
}

function focusMainWindow(): void {
  const [window] = BrowserWindow.getAllWindows()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function initNotifications(): void {
  onGenerationSettled((event) => {
    if (!getNotifyOnCompletion() || !Notification.isSupported() || anyWindowFocused()) return
    const node = getDb().select().from(nodes).where(eq(nodes.id, event.nodeId)).get()
    const label = node?.label ?? node?.key ?? 'node'
    const notification = new Notification({
      title: str(event.status === 'success' ? 'generationSuccess' : 'generationFailed', { label }),
      body: event.status === 'failed' ? (event.errorMessage ?? '').slice(0, 200) : ''
    })
    notification.on('click', () => {
      focusMainWindow()
      broadcastFocusNode({ videoId: event.videoId, nodeId: event.nodeId })
    })
    notification.show()
  })
}

/** One summary per batch run ("4 succeeded, 1 failed") — sent by the renderer. */
export function notifyBatchSummary(succeeded: number, failed: number): void {
  if (!getNotifyOnCompletion() || !Notification.isSupported()) return
  const notification = new Notification({
    title: str('batchTitle'),
    body: str('batchSummary', { succeeded, failed })
  })
  notification.on('click', focusMainWindow)
  notification.show()
}
