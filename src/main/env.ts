import { app } from 'electron'
import type { ReleaseChannel } from '@shared/ipc/contracts'
import { getUpdateChannel } from './services/settings'

/**
 * dev = unpackaged run. Packaged builds follow the updateChannel setting
 * (stable by default, beta opt-in from Settings) — the same channel drives
 * the auto-update feed and the flag defaults.
 */
export function getReleaseChannel(): ReleaseChannel {
  if (!app.isPackaged) return 'dev'
  try {
    return getUpdateChannel()
  } catch {
    // Called before openDatabase() — keep the safe default.
    return 'stable'
  }
}
