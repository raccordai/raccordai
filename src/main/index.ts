import { join } from 'node:path'
import { BrowserWindow, app, dialog, safeStorage, shell } from 'electron'
import { openDatabase } from './db/client'
import { logError } from './services/logger'
import { registerIpcHandlers } from './ipc'
import { registerMediaProtocolHandler, registerMediaProtocolPrivileges } from './media/protocol'
import { startLocalApi } from './server'
import { initNotifications } from './services/notifications'
import { resumePolling } from './services/runEngine'
import { ensureDefaultThread } from './services/chat'
import { backfillChatThreads } from './services/chatStore'
import { autoRefreshStaleNiches } from './services/niches'
import {
  backfillOnboardingCompleted,
  getChatThreadsBackfilled,
  setChatThreadsBackfilled
} from './services/settings'
import { initUpdater } from './services/updater'

// Must run before app ready.
registerMediaProtocolPrivileges()

// Last-resort crash log (userData/logs/main.log): in a packaged build the
// console does not exist, so without this an open-source bug report is
// "the app stopped working" with nothing to attach. Log and keep running —
// the poller, queue and windows are still consistent, and taking the app
// down would also take the user's in-flight generations with it.
process.on('uncaughtException', (err) => {
  logError('process', 'uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logError('process', 'unhandledRejection', reason)
})

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
  // Only protocols a browser/mail client owns: links also come from assistant
  // output (which quotes fetched web content), so file:// or an arbitrary
  // scheme handler must never reach the OS.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(?:https?|mailto):/i.test(url)) void shell.openExternal(url)
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

      // Every post-DB step is fenced on its own: a throw here used to fall
      // into the final .catch → app.exit(1) with no window and no dialog, and
      // since the faulty state persists (e.g. a pending generation whose
      // snapshot no longer builds), the app never started again. A failed
      // step now only logs — the window still opens.
      const bootStep = (name: string, step: () => void): void => {
        try {
          step()
        } catch (error) {
          logError('startup', `${name} failed`, error)
        }
      }
      // Existing users (kie key already configured) never see the first-run overlay.
      bootStep('onboarding backfill', backfillOnboardingCompleted)
      // Pre-thread conversations become threads once, then the switcher is
      // guaranteed to have at least one row to select.
      bootStep('chat thread backfill', () => {
        backfillChatThreads(getChatThreadsBackfilled, setChatThreadsBackfilled)
        ensureDefaultThread()
      })
      bootStep('ipc handlers', registerIpcHandlers)
      bootStep('notifications', initNotifications)
      bootStep('resume polling', resumePolling)
      bootStep('updater', initUpdater) // no-op in dev; packaged builds check the channel feed
      // Niche watchlists refresh themselves when older than 24 h — delayed so
      // startup never waits on the network, and every failure only logs.
      setTimeout(() => {
        void autoRefreshStaleNiches()
      }, 10_000)

      try {
        await startLocalApi()
      } catch (error) {
        // The app is fully usable without the local API; log and move on.
        logError('local-api', 'failed to start', error)
      }

      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      logError('startup', 'fatal error during startup', error)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
