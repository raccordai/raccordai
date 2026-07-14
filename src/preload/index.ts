import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { ipcEvents, isIpcChannel } from '@shared/ipc/contracts'

/**
 * Minimal, whitelisted bridge: the renderer can only invoke channels and
 * subscribe to events declared in the shared contracts. Typing is layered
 * on in renderer/src/lib/ipc.ts.
 */
const api = {
  invoke(channel: string, input?: unknown): Promise<unknown> {
    if (!isIpcChannel(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, input)
  },
  /** Subscribe to a main-process push event; returns the unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!(ipcEvents as readonly string[]).includes(channel)) {
      throw new Error(`Unknown IPC event: ${channel}`)
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
