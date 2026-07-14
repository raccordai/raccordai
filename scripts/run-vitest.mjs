/**
 * Runs vitest inside Electron's embedded Node (ELECTRON_RUN_AS_NODE).
 *
 * Why: better-sqlite3 is rebuilt for Electron's ABI by `electron-builder
 * install-app-deps` (postinstall), so it cannot load under the system Node.
 * Running the test suite through the Electron binary keeps a single native
 * build for both the app and the tests, locally and in CI.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron') // resolves to the Electron binary path
// The CLI entry is exposed as a bin, not a package export — resolve it by path.
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const result = spawnSync(electron, [vitest, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

process.exit(result.status ?? 1)
