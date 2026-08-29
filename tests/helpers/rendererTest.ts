import { vi, type Mock } from 'vitest'

/**
 * Renderer component tests run under jsdom without a preload bridge: install
 * a `window.api` stub and assert on the `invoke` mock — the components go
 * through the real typed `invoke()` facade, so the channel names and payloads
 * they submit are exactly what main would receive.
 *
 * Installed on `globalThis` (=== `window` under jsdom): this file lives in
 * tests/, which tsconfig.node.json typechecks WITHOUT the DOM lib — naming
 * `window` here would fail `pnpm typecheck`.
 */
export function installApiMock(): Mock {
  const invoke = vi.fn().mockResolvedValue({})
  Object.defineProperty(globalThis, 'api', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined), getPathForFile: vi.fn() }
  })
  return invoke
}
