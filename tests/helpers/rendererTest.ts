import { vi, type Mock } from 'vitest'

/**
 * Renderer component tests run under jsdom without a preload bridge: install
 * a `window.api` stub and assert on the `invoke` mock — the components go
 * through the real typed `invoke()` facade, so the channel names and payloads
 * they submit are exactly what main would receive.
 */
export function installApiMock(): Mock {
  const invoke = vi.fn().mockResolvedValue({})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => undefined), getPathForFile: vi.fn() }
  })
  return invoke
}
