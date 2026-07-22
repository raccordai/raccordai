---
name: verify
description: Runtime verification recipe for Raccord — launch the built app with a mocked kie.ai and drive it via Playwright + the window.api IPC bridge.
---

# Verifying Raccord at runtime

Build first (`pnpm build`), kill leftovers (`pkill -f "projects/app/node_modules/.pnpm/electron"` — single-instance lock), then launch with playwright-core **from the project root**:

```js
const { _electron } = require('playwright-core') // createRequire against the project's package.json
const app = await _electron.launch({
  args: ['.'],
  env: { ...process.env, RACCORD_KIE_BASE: `http://127.0.0.1:${PORT}` } // credit-free kie mock
})
```

## kie mock endpoints (all `{code:200,msg,data}` envelope)

- `POST /api/v1/jobs/createTask` → `{data:{taskId}}`
- `GET /api/v1/jobs/recordInfo?taskId=` → `{data:{state:'success', resultJson:'{"resultUrls":[...]}'}}`
- `GET /api/v1/chat/credit` → `{data:<number>}` (toolbar credits chip)
- `POST /api/file-stream-upload` → `{data:{downloadUrl}}` (lastFrame/asset uploads)
- Suno (music nodes): `POST /api/v1/generate` → `{data:{taskId}}`; `GET /api/v1/generate/record-info?taskId=` → `{data:{taskId, status:'SUCCESS', response:{sunoData:[{audioUrl}]}}}`.
- Serve real media bytes for resultUrls — a real mp4 is needed for last-frame extraction/preview. Homebrew ffmpeg/ffprobe exist at `/opt/homebrew/bin` — generate fixtures with `-f lavfi testsrc2/sine` instead of borrowing user media.

## Gotchas

- **API key**: the user's `kieApiKeyEncrypted` does NOT decrypt under a playwright launch (different keychain scope) — save the ciphertext row via sqlite, `invoke('settings:setKieApiKey', {key:'test'})` at start, restore the row after `app.close()`. sqlite3 lives at `~/Library/Android/sdk/platform-tools/sqlite3`.
- **Drive via IPC, assert via UI**: `win.evaluate(([c,i]) => window.api.invoke(c,i), [channel, input])` reaches every typed channel (`projects:create`, `nodes:create`, `edges:connect`, `generations:run`, `generations:listForNode`…). Navigate with `window.location.hash = '#/projects/<pid>/videos/<vid>'` (hash router).
- **Generation timing**: poller fires 15 s after submission (`POLL_INTERVAL_MS`) — allow ~45 s per generation.
- **Timeline v2 play button**: click via `getByRole('button', { name: 'Play', exact: true })`; CSS `:has(svg.lucide-play)` hits the wrong element. Playback check: some `<video>` with `!paused && currentTime > 0 && videoWidth > 0`.
- Renderer CSP blocks `http://127.0.0.1` media/fetch (`connect-src`/`media-src` allow only `https:`/`media:`) — mock-URL fetch errors in the renderer console are expected noise; the main process downloads fine and everything flips to `media://`.
- Cleanup: `invoke('projects:delete', {id})` removes the project and its media dir.
- After touching chat.ts, the MCP registry or docs topics: run `pnpm test:assistant` too.

- **MP4 render**: `render:export` opens a native save dialog (blocks automation) — drive the render through the MCP tool instead: `settings:localApiInfo` gives `{url, token}` (`url` already ends in `/mcp`), then POST a JSON-RPC `tools/call` of `render_video` with an explicit `outputPath` (response may be SSE — parse `data:` lines). Progress: collect `window.api.on('event:renderProgress', …)` payloads from the page. Cancellation is racy on tiny fixtures — spam `render:cancel` until it returns true instead of sleeping.

Reference scripts from past sessions: fixture = 2 chained seedance-2-fast nodes (`lastFrame` → `reference_image_urls`), asserts credits chip refreshes, media:// serves 206 + DB mime, preview plays. Render E2E (July 2026): 2 heterogeneous grok t2v clips + suno music → MCP render_video → ffprobe asserts spec/duration/audio, volumedetect proves the music lane, then a cancel pass.
