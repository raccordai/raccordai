import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Minimal stub of the `electron` module for unit tests (aliased in
 * vitest.config.ts). Only what main-process modules touch at import/call
 * time is implemented; anything else should fail loudly.
 */

const userData = mkdtempSync(join(tmpdir(), 'raccord-test-'))

export const BrowserWindow = {
  getAllWindows(): unknown[] {
    return []
  }
}

export const app = {
  isPackaged: false,
  getPath(name: string): string {
    if (name === 'userData') return userData
    if (name === 'temp') return userData
    throw new Error(`electron mock: app.getPath("${name}") is not stubbed`)
  },
  getAppPath(): string {
    return process.cwd()
  },
  getVersion(): string {
    return '0.0.0-test'
  }
}
