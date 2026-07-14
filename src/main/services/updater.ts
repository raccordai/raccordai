import { app } from 'electron'
// electron-updater is CommonJS: a named import breaks at runtime in the ESM
// main bundle (only the default export exists).
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/ipc/contracts'
import { getUpdateChannel } from './settings'

const { autoUpdater } = electronUpdater

/**
 * Auto-update via electron-updater, wired to the release channels:
 *   - dev (unpackaged): updater disabled, status stays 'unsupported';
 *   - packaged: the feed channel follows the `updateChannel` setting —
 *     'stable' reads latest*.yml, 'beta' reads beta*.yml from the publish
 *     endpoint declared in electron-builder.yml.
 *
 * Updates download in the background; installation is user-triggered from
 * Settings (quitAndInstall), never forced mid-session.
 */

let state: UpdateState = { status: 'unsupported', version: null, error: null }
let initialized = false

export function getUpdateState(): UpdateState {
  return state
}

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
}

export function initUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  autoUpdater.channel = getUpdateChannel() === 'beta' ? 'beta' : 'latest'
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (info) =>
    set({ status: 'downloading', version: info.version })
  )
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date', version: null }))
  autoUpdater.on('download-progress', () => set({ status: 'downloading' }))
  autoUpdater.on('update-downloaded', (info) =>
    set({ status: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) => {
    // Offline or feed unreachable is a normal desktop situation — log, don't crash.
    console.warn('[updater]', err.message)
    set({ status: 'error', error: err.message })
  })

  set({ status: 'idle' })
  void checkForUpdates()
}

/** Manual or startup check. No-op in dev. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  if (!initialized) initUpdater()
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // the 'error' listener already captured the failure into `state`
  }
  return state
}

/** Applies the update channel change immediately (next check uses it). */
export function applyUpdateChannel(): void {
  if (!initialized) return
  autoUpdater.channel = getUpdateChannel() === 'beta' ? 'beta' : 'latest'
}

/** Quits and installs the downloaded update. */
export function installUpdate(): void {
  if (state.status !== 'downloaded') return
  autoUpdater.quitAndInstall()
}
