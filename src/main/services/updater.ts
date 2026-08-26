import { app } from 'electron'
// electron-updater is CommonJS: a named import breaks at runtime in the ESM
// main bundle (only the default export exists).
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/ipc/contracts'
import { getUpdateChannel } from './settings'
import { logWarn } from './logger'
import { broadcastUpdateState } from '../events'

const { autoUpdater } = electronUpdater

/**
 * Auto-update via electron-updater, wired to the release channels:
 *   - dev (unpackaged): updater disabled, status stays 'unsupported';
 *   - packaged: the feed is the GitHub releases of the repo declared in
 *     electron-builder.yml. The `updateChannel` setting maps to prereleases:
 *     'stable' only sees full releases, 'beta' also accepts GitHub
 *     prereleases (vX.Y.Z-beta.N tags — the provider resolves their channel
 *     file from the tag itself, so `autoUpdater.channel` stays untouched).
 *
 * NOTE (macOS): electron-updater refuses to install onto an unsigned app —
 * until builds are notarized, mac users get status 'error' on update attempts.
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
  const prev = state
  state = { ...state, ...next }
  // Only meaningful transitions reach the renderer — download-progress ticks
  // re-set 'downloading' constantly and would spam the event channel.
  if (state.status !== prev.status || state.version !== prev.version) {
    broadcastUpdateState(state)
  }
}

export function initUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  autoUpdater.allowPrerelease = getUpdateChannel() === 'beta'
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
    logWarn('updater', err.message)
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
  autoUpdater.allowPrerelease = getUpdateChannel() === 'beta'
}

/** Quits and installs the downloaded update. */
export function installUpdate(): void {
  if (state.status !== 'downloaded') return
  autoUpdater.quitAndInstall()
}
