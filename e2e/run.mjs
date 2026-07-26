#!/usr/bin/env node
/**
 * E2E runner — `pnpm e2e [name...]`.
 *
 * Each spec is a standalone program run in its own process (own app instance,
 * own throwaway profile, own mock server), sequentially: three Electron
 * instances competing for CPU is how an E2E suite becomes flaky.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFixtures } from './harness/fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const specDir = join(here, 'specs')
const root = join(here, '..')

const available = readdirSync(specDir)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .sort()

const wanted = process.argv.slice(2)
const selected = wanted.length
  ? available.filter((f) => wanted.some((w) => f.startsWith(w)))
  : available

if (selected.length === 0) {
  console.error(`No spec matched ${wanted.join(', ')}. Available: ${available.join(', ')}`)
  process.exit(1)
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js is missing — run `pnpm build` first.')
  process.exit(1)
}

console.log('Generating media fixtures…')
ensureFixtures()

// Backstop: a spec that wedges (an app instance that won't die, a poller that
// never settles) must not burn the whole CI job's budget in silence.
const SPEC_TIMEOUT_MS = Number(process.env['E2E_SPEC_TIMEOUT_MS'] ?? 8 * 60 * 1000)

const results = []
for (const file of selected) {
  const ok = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(specDir, file)], {
      cwd: root,
      stdio: 'inherit'
    })
    const timer = setTimeout(() => {
      console.error(`\n✗ ${file} exceeded ${SPEC_TIMEOUT_MS / 1000}s — killing it.`)
      child.kill('SIGKILL')
    }, SPEC_TIMEOUT_MS)
    child.on('exit', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode === 0)
    })
  })
  results.push({ file, ok })
}

const failed = results.filter((r) => !r.ok)
console.log('')
for (const { file, ok } of results) console.log(`${ok ? '✓' : '✗'} ${file}`)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} spec(s) failed.`)
  process.exit(1)
}
console.log(`\n${results.length}/${results.length} specs passed.`)
