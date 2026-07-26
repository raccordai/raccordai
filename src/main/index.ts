import { join } from 'node:path'
import { BrowserWindow, app, dialog, safeStorage, shell } from 'electron'
import { openDatabase } from './db/client'
import { registerIpcHandlers } from './ipc'
import { registerMediaProtocolHandler, registerMediaProtocolPrivileges } from './media/protocol'
import { startLocalApi } from './server'
import { initNotifications } from './services/notifications'
import { resumePolling } from './services/runEngine'
import { ensureDefaultThread } from './services/chat'
import { backfillChatThreads } from './services/chatStore'
import {
  backfillOnboardingCompleted,
  getChatThreadsBackfilled,
  setChatThreadsBackfilled
} from './services/settings'
import { initUpdater } from './services/updater'

// Must run before app ready.
registerMediaProtocolPrivileges()

// A headless Linux box (the E2E CI job) has no keyring, so safeStorage finds no
// OS password manager, refuses to encrypt, and the app cannot store an API key
// at all. Only the E2E harness opts into Electron's in-memory password, and the
// packaged guard makes it unreachable in a real install: user secrets always go
// through the OS keychain. Must be called before ready.
if (!app.isPackaged && process.platform === 'linux' && process.env['RACCORD_E2E'] === '1') {
  safeStorage.setUsePlainTextEncryption(true)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0a',
    // 'hidden' (not 'hiddenInset', which ignores trafficLightPosition) so the
    // traffic lights can be centred in the renderer's 48px header:
    // buttons are 12px tall → y = (48 - 12) / 2 = 18.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // External links open in the system browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  app
    .whenReady()
    .then(async () => {
      try {
        openDatabase()
      } catch (error) {
        dialog.showErrorBox(
          'Raccord — database error',
          `The local database could not be opened:\n${error instanceof Error ? error.message : String(error)}`
        )
        app.exit(1)
        return
      }

      // In dev the app runs from the generic Electron binary, whose bundle
      // icon is baked in; the packaged icon (build/icon.png) only applies to
      // the DMG build, so set the Dock icon manually.
      if (!app.isPackaged && process.platform === 'darwin') {
        app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
      }

      registerMediaProtocolHandler()
      // Existing users (kie key already configured) never see the first-run overlay.
      backfillOnboardingCompleted()
      // Pre-thread conversations become threads once, then the switcher is
      // guaranteed to have at least one row to select.
      backfillChatThreads(getChatThreadsBackfilled, setChatThreadsBackfilled)
      ensureDefaultThread()
      registerIpcHandlers()
      initNotifications()
      resumePolling()
      initUpdater() // no-op in dev; packaged builds check the channel feed

      try {
        await startLocalApi()
      } catch (error) {
        // The app is fully usable without the local API; log and move on.
        console.error('[local-api] failed to start', error)
      }

      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      console.error('Fatal error during startup', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
