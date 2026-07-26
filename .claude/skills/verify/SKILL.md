---
name: verify
description: Runtime verification recipe for Raccord — drive the built app through the versioned E2E harness (isolated profile, mocked kie.ai, Playwright + the window.api IPC bridge).
---

# Verifying Raccord at runtime

The harness is versioned in `e2e/` — **never hand-roll a new driver**. Read
`e2e/README.md` first; `pnpm build && pnpm e2e` runs the whole suite.

## One-off check

Write a throwaway script (or a new `e2e/specs/*.e2e.mjs`) on top of the harness:

```js
import { launchApp } from './e2e/harness/app.mjs'
import { startKieMock } from './e2e/harness/kie-mock.mjs'

const mock = await startKieMock({ credits: 4321 }) // + { claude, resultFor, pendingPolls }
const app = await launchApp({ kieBase: mock.base }) // isolated profile, key + locale seeded
const video = await app.invoke('videos:create', { projectId, name: 'Test' })
await app.goto(`#/projects/${projectId}/videos/${video.id}`)
```

`launchApp` gives `invoke` (every typed channel), `goto` (hash router),
`collectEvent` (main→renderer pushes), `mcp` (local MCP tool call), `win`
(Playwright page) and `close`. `E2E_VERBOSE=1` streams the app's logs.

Isolation is automatic: throwaway `--user-data-dir` + own local-API port, so
the developer's real install is untouched and no `pkill` dance is needed.

## Gotchas

- **Build first** — the harness runs `out/main/index.js`, not the sources.
- **Generation timing**: the poller fires 15 s after submission
  (`POLL_INTERVAL_MS`) — budget ~20 s per generation, and always `waitFor()`
  the state, never `sleep()`.
- **Drive via IPC, assert via UI/filesystem** — `invoke()` keeps the setup
  short; the assertions are what must go through the real surfaces.
- **MP4 render**: `render:export` opens a native save dialog (blocks
  automation) — render through `app.mcp('render_video', { videoId, outputPath })`.
  Cancellation is a race: poll `render:cancel` until it returns true.
- **Timeline v2 play button**: `getByRole('button', { name: 'Play', exact: true })`;
  `:has(svg.lucide-play)` hits the wrong element. Playback check: some `<video>`
  with `!paused && currentTime > 0 && videoWidth > 0`.
- The assistant sidebar **defaults to open** (localStorage) — clicking the
  header toggle unconditionally closes it.
- Renderer CSP blocks `http://127.0.0.1` media/fetch (`connect-src`/`media-src`
  allow only `https:`/`media:`) — mock-URL fetch errors in the renderer console
  are expected noise; main downloads fine and everything flips to `media://`.
- A `kie:credits` "API key is not configured" error at startup is normal: the
  first render happens before the harness seeds the key.
