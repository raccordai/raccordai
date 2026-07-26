/**
 * Launches the built app under Playwright, fully isolated from the developer's
 * install: a throwaway `--user-data-dir` (own SQLite database, own media store,
 * own single-instance lock) and its own local-API port. Nothing in this suite
 * ever touches `~/Library/Application Support/Raccord`.
 *
 * Requires `pnpm build` first — the launch runs `out/main/index.js`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const require = createRequire(join(PROJECT_ROOT, 'package.json'))
const { _electron } = require('playwright-core')

const VERBOSE = process.env['E2E_VERBOSE'] === '1'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * @param {object} options
 * @param {string} options.kieBase   RACCORD_KIE_BASE (the mock's base URL)
 * @param {string} [options.locale]  seeded UI language — 'en' keeps locators stable
 * @param {string} [options.apiKey]  seeded kie.ai key (encrypted through safeStorage)
 */
export async function launchApp({ kieBase, locale = 'en', apiKey = 'e2e-key' }) {
  if (!existsSync(join(PROJECT_ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js is missing — run `pnpm build` before the E2E suite')
  }
  const userDataDir = mkdtempSync(join(os.tmpdir(), 'raccord-e2e-'))
  const localApiPort = await freePort()

  const args = [PROJECT_ROOT, `--user-data-dir=${userDataDir}`]
  if (process.platform === 'linux') {
    // Headless CI has no keyring: without this safeStorage refuses to encrypt
    // and `settings:setKieApiKey` throws. Sandbox off for the CI container.
    args.push('--password-store=basic', '--no-sandbox')
  }

  const electronApp = await _electron.launch({
    args,
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      RACCORD_KIE_BASE: kieBase,
      RACCORD_LOCAL_API_PORT: String(localApiPort),
      // Lets main opt into safeStorage's in-memory password where no OS
      // keyring exists (headless Linux) — dev builds only, see src/main/index.ts.
      RACCORD_E2E: '1'
    }
  })

  const logs = []
  const record = (source, text) => {
    logs.push(`[${source}] ${text}`)
    if (logs.length > 200) logs.shift()
    if (VERBOSE) console.log(`    [${source}] ${text}`)
  }
  electronApp.process().stdout?.on('data', (d) => record('main', String(d).trimEnd()))
  electronApp.process().stderr?.on('data', (d) => record('main!', String(d).trimEnd()))

  const win = await electronApp.firstWindow()
  win.on('console', (message) => record('renderer', message.text()))
  win.on('pageerror', (error) => record('renderer!', error.message))

  const invoke = (channel, input) =>
    win.evaluate(([c, i]) => window.api.invoke(c, i), [channel, input])

  // Anything that throws between here and the return value would strand a live
  // Electron process (the spec has no handle to close yet), and an orphan keeps
  // its keep-alive sockets to the mock open — which is enough to hang the whole
  // run. Own the teardown here instead.
  try {
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(() => Boolean(window.api))

    // Seed the settings a fresh profile lacks, then reload so the renderer
    // starts from the seeded state (no first-run overlay, no missing-key banner).
    await invoke('settings:setLocale', locale)
    try {
      await invoke('settings:setKieApiKey', { key: apiKey })
    } catch (error) {
      throw new Error(
        'could not seed the kie.ai key — safeStorage refused to encrypt. Without an ' +
          'OS keyring, main must call safeStorage.setUsePlainTextEncryption(true) ' +
          '(gated on RACCORD_E2E in src/main/index.ts).',
        { cause: error }
      )
    }
    await invoke('settings:setOnboardingCompleted')
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(() => Boolean(window.api))
  } catch (error) {
    for (const line of logs.slice(-30)) console.error(`  ${line}`)
    await electronApp.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }

  let rpcId = 0

  return {
    electronApp,
    win,
    invoke,
    userDataDir,
    localApiPort,
    logs,

    /** Navigate the hash router (the app runs under file://). */
    async goto(hash) {
      await win.evaluate((h) => {
        window.location.hash = h
      }, hash)
    },

    /**
     * Subscribes to a main→renderer push event and returns a reader for
     * everything received so far. Installed before the action that emits.
     */
    async collectEvent(channel) {
      const key = `__e2e_${channel.replace(/\W/g, '_')}`
      await win.evaluate(
        ([c, k]) => {
          window[k] = []
          window.api.on(c, (payload) => window[k].push(payload))
        },
        [channel, key]
      )
      return () => win.evaluate((k) => window[k] ?? [], key)
    },

    /** Calls an MCP tool over the app's local Streamable-HTTP endpoint. */
    async mcp(name, args) {
      const info = await invoke('settings:localApiInfo')
      if (!info.running || !info.url) {
        throw new Error(`local API is not running (port ${localApiPort} taken?)`)
      }
      const res = await fetch(info.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${info.token}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'tools/call',
          params: { name, arguments: args }
        })
      })
      const raw = await res.text()
      // The transport answers with plain JSON (enableJsonResponse) but may fall
      // back to SSE framing — accept both.
      const payload = raw.startsWith('data:')
        ? JSON.parse(
            raw
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('')
          )
        : JSON.parse(raw)
      if (payload.error) throw new Error(`MCP ${name} failed: ${payload.error.message}`)
      const text = payload.result?.content?.[0]?.text ?? ''
      if (payload.result?.isError) throw new Error(`MCP ${name} returned an error: ${text}`)
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },

    async close() {
      if (process.exitCode) {
        console.error('  --- app log tail ---')
        for (const line of logs.slice(-30)) console.error(`  ${line}`)
      }
      await electronApp.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}
