# Raccord — conventions

Electron app (main / preload / renderer). Package manager: pnpm.

## Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `pnpm build` before considering a change done (CI also runs `format:check` — run `pnpm format` after edits).
- ESLint (flat config, `eslint.config.mjs`) encodes the no-raw-colors rule; lefthook runs lint+prettier at pre-commit and commitlint (conventional commits, required by release-please) at commit-msg. typescript-eslint runs on its own TS 5.x via `.pnpmfile.cjs` (TS 7's native compiler has no JS API yet) — don't remove that hook.
- Unit tests: Vitest launched through `scripts/run-vitest.mjs` (Electron's embedded Node — never run `vitest` directly, better-sqlite3 is compiled for Electron's ABI). Strategy and coverage rules: `docs/testing.md` — every new logic module ships with its tests and enters `coverage.include` (thresholds are blocking in CI; never lower them or shrink the scope).
- To verify at runtime: build, then drive the app with playwright-core `_electron.launch({ args: ['.'] })` (the script must run from the project root to resolve modules). Kill leftover Electron instances first (`pkill -f "projects/app/node_modules/.pnpm/electron"`) — the single-instance lock makes any second instance quit silently.

## Rules

- All renderer→main communication goes through a channel declared in `src/shared/ipc/contracts.ts` (zod input/output schemas). Adding a channel = contract + handler in `src/main/ipc/index.ts` + usage through the typed `invoke()`.
- Business logic lives in `src/main/services/`, consumed by IPC **and** by the Hono routes (`src/main/server/`) — never write it in a handler.
- SQLite schema: edit `src/main/db/schema.ts` then `pnpm db:generate`. Migrations are **additive only** (backward compatibility of user databases, hard product requirement).
- New early-phase feature → flag in `src/shared/flags/registry.ts` (defaults per dev/beta/stable channel).
- Every user-visible string goes through i18next: add the key to `src/shared/i18n/locales/fr/common.json` **and** `en/common.json` (keys are typed from the fr JSON).
- The router uses a hash history (required under `file://`) — do not remove it.
- **Colors**: pastel palette mandated by Romain (#ff9bc6 / #ffbcd6 / #ffe5f9 / #b7b6ff / #afdeff). Every color goes through the tokens in `src/renderer/src/styles.css` (`accent`=lavender, `highlight`=pink for the main CTA and the logo, `accent-soft`=sky blue, pastel `success`/`danger`/`warning` for states) — never raw color classes. On solid `accent`/`highlight` backgrounds: `text-neutral-900`, never white. `danger` = error states and destructive hover only, never a solid button background.
- **Editor layout**: UI as floating islands (`island` utility in styles.css) above the full-frame React Flow canvas — toolbar on top, timeline at the bottom, panels (params/history/chat) in a right-hand column. Any new panel follows this pattern.
- TypeScript 7: `baseUrl` no longer exists, `paths` must be relative (`./src/...`).
- **Graph undo/redo**: every graph mutation is journaled by `src/main/services/graphHistory.ts` (per-video before/after snapshots, diff-restore so untouched generations survive an undo; deleted generations are NOT restored). New graph mutations must go through the graph service so they get journaled — and `withGraphHistory` is the single point that broadcasts `event:workflowChanged`.

## Generation (kie.ai)

- The engine lives in `src/main/services/runEngine.ts` (no webhooks on desktop: the poller IS the completion path; in-flight generations resume on startup via `resumePolling()`, queued-but-unsubmitted ones are re-queued from their input snapshot).
- Submissions go through a **concurrency-limited queue** (`src/main/services/genQueue.ts`, limit = `maxConcurrentGenerations` setting, default 2; a slot is held until the generation settles). `runNode` returns `kieTaskId: ''` while queued. createTask retries transient failures with backoff.
- **Smart retry**: a failed generation (submission error or remote `fail`) is re-submitted from its input snapshot after 5 s, max 3 times, without releasing its queue slot — EXCEPT permanent errors (content-policy violations, 4xx), classified by `isRetryableGenerationError` in genQueue.ts. No retry on poll timeout or user cancellation.
- Each new generation stamps `creditsEstimated` (from the model's `estimateCredits` — **indicative rates declared per model file**, align them with https://kie.ai/pricing); per-project totals via `projects:creditsUsage`.
- **New model** = ONE `ModelDefinition` file in `src/shared/models/` + entry in the `MODELS` array (pure data/functions, no Electron imports). Full guide — required fields, UI/engine/docs consumption map, quality checklist: `docs/models.md`. Replacing a model: add the old id to `MODEL_ALIASES`.
- **Image-input semantics — the #1 pitfall**: seedance-1.5 `input_urls`/grok `image_urls`/seedance-2-family `first_frame_url`+`last_frame_url` are FRAME ANCHORS (the image appears on screen); seedance-2-family `reference_*` are REFERENCES (guide only, invisible without a frame role in the prompt). On Seedance 2.x, frame anchoring and @ references are mutually exclusive per run. Character sheets/storyboards → references ONLY. Details: `docs/models.md`; templates enforce it by test. Anchor handles declare `frameAnchor: true` on their `InputHandle` (tests + UI guard derive from it — set it on any new anchor input).
- **Design recipes** (`src/shared/designs/registry.ts`, flag `design-recipes`): "Designs" group in the add-node menu — character/décor/prop/styleframe nodes with prompts BUILT per model + video style (per-model overrides via `byModel`, fallback `buildPrompt`). The node carries `params.designId` (marker, stripped at run) and a "reference" intent; the editor confirm()s before wiring its output to a `frameAnchor` handle. New recipe = one entry in `DESIGN_RECIPES` + i18n `designs.<id>.{name,desc,placeholder}` (fr+en); the MCP `docs "designs"` topic is generated from the registry.
- The API key is encrypted with `safeStorage` (never in the clear outside the main process). Local input media are uploaded on demand to kie.ai's File Upload API (48h TTL cache in the database; files expire on kie's side after ~3 days).
- **Credit-free E2E tests**: `RACCORD_KIE_BASE=http://127.0.0.1:<port>` points the client (`src/main/services/kie.ts`) at a local mock that simulates `POST /api/v1/jobs/createTask`, `GET /api/v1/jobs/recordInfo` (resultJson → `{"resultUrls":[...]}`) and serves the resulting media.

## MCP server

- `src/main/mcp/`: `registry.ts` (THE extension point — one capability = one `AgentTool` entry), `docs.ts` (in-band exploratory docs, model topics generated from the model registry), `server.ts` (stateless Streamable HTTP on Hono `/mcp`, Bearer auth). Full docs: `docs/mcp.md`.
- Rules: short tool descriptions (depth goes in the `docs` tool), explicit ids, `mutates: true` on writes (refreshes the UI). Any new app capability should be added to the registry at the same time.

## Assistant (Anthropic chat)

- Service in `src/main/services/chat.ts`: agentic Messages API loop with tools wired to the SAME services as IPC. Sessions are per-videoId, **persisted in SQLite** (`chat_sessions` table via `chatStore.ts` — transcript, Anthropic history and watched generation ids survive restarts; `busy` never persists); the renderer syncs via `chat:get` + `event:chatUpdate` events; graph mutations push `event:workflowChanged`.
- **Home assistant** (Assistant button on the home page): session key `HOME_CHAT_ID` ('home', own table `chat_home_session` — chat_sessions has a videos FK), prompt SYSTEM_HOME + toolset TOOLS_HOME = project tools (create_project/create_video/list_*) + the graph tools with an explicit required `videoId`. It can deliver a full project from one message ("crée-moi un projet d'animé de 2,5 min…"). Its history is Anthropic-format regardless of model.
- **Assistant model is a setting** (`settings:get/setAssistantModel`, select in Settings → General): `claude-opus-4-8` (default) and `claude-sonnet-5` via the Claude proxy; `gpt-5-6-sol` and `gpt-5.4-codex` via kie's OpenAI **Responses** proxies (`/codex/v1/responses`, `/api/v1/responses`) through the pure translator `chatOpenAIFormat.ts` (Anthropic ⇄ Responses; unit-tested, in coverage).
- **Credit-free assistant E2E**: `pnpm test:assistant` (scripts/assistant-e2e.mjs) mocks the Claude proxy with a scripted agent (create_project → create_video → set_video_style → import_workflow) and asserts the project/video/graph exist in the real app, then cleans up. Run it after touching chat.ts, the MCP registry or the docs topics.
- **Automatic wake-up**: generations launched through the `run_node` tool are watched (`session.watched`); on completion the run engine emits `generationSettled` on the in-main bus (`src/main/bus.ts`) and the chat **resumes the conversation on its own** (injected `<system-reminder>` note + new turn). If the settle lands mid-turn, it is queued and drained at the end of the turn. Never let the assistant promise a follow-up without this mechanism.
- **Provider: kie.ai's Claude proxy only** (the Anthropic fallback was removed at Romain's request) (`${KIE_BASE}/claude/v1/messages`, Bearer auth with the kie key — one key for everything, https://docs.kie.ai/market/claude/claude-opus-4-8); direct Anthropic key as a fallback if it is the only one configured. Explicit `stream: false` (the proxy documents stream=true as the default). Both keys in safeStorage, entered in Integrations.
- **Credit-free E2E tests**: `RACCORD_ANTHROPIC_BASE=http://127.0.0.1:<port>` points the SDK at a mock that scripts responses (shape: `{id, type:'message', role, model, content:[text|tool_use], stop_reason, stop_sequence, usage}`).

## Known pitfalls (media & islands)

- The `media://` scheme must stay registered with `standard: true, stream: true, supportFetchAPI: true, corsEnabled: true` (privileges in `src/main/media/protocol.ts`) — without `standard`, Chromium rejects every media/fetch request from `file://`. The handler must serve **Range requests** (206 + Content-Range) or `<video>` elements won't play, and must answer OPTIONS preflights (fetch with a Range header).
- The CSP (`src/renderer/index.html`) must keep `media:` in `img-src`, `media-src` **and** `connect-src` (the FCPXML export fetches local media).
- The `island` utility deliberately has NO `overflow: hidden` (toolbar dropdowns must be able to overflow) — scrollable panels add it themselves.
- **Chromium `backdrop-filter` + `<video>` bug**: an ancestor with backdrop-filter makes videos invisible to hit-testing (controls render but receive no clicks). Mandatory workaround in styles.css: `.island video { position: relative; z-index: 1 }`. Any new blurred container hosting a video must keep this rule (diagnosed by bisection: removing the blur restores clicks). CAUTION: that rule is unlayered so it beats Tailwind's `absolute` utility — videos that must be absolutely-positioned overlays (TimelineV2's A/B player) need the `.video-stack` container class, whose rule restores `position: absolute` (otherwise the standby video is pushed out of frame → black player from clip 2 on).
- React Flow v12 selectors: panels carry separate classes (`.bottom.left`), and the minimap IS its own panel (`.react-flow__minimap.bottom.left`).
- **Draggable title bar**: the header has `-webkit-app-region: drag` — any interactive element placed in it MUST be covered by the no-drag rule in styles.css (`a, button, input, select`), otherwise its clicks are swallowed by window dragging.

## Known pitfalls

- better-sqlite3 must be compiled for Electron's ABI: on a `NODE_MODULE_VERSION` error, run `./node_modules/.bin/electron-builder install-app-deps`.
- `electron-updater` is CommonJS: import the default and destructure (`import electronUpdater from 'electron-updater'`) — a named import passes typecheck but crashes the ESM main bundle at load.

## Backup & updates

- **Backup `.raccord`** (`src/main/services/backup.ts`): full-app archive (manifest + `VACUUM INTO` db snapshot + media store, streamed via fflate). Import validates the manifest BEFORE touching live data, keeps the old db as `.bak-<ts>`, merges media, then relaunches the app. Native dialogs live in the IPC handlers (`backup:export/import`).
- **Auto-update** (`src/main/services/updater.ts`): electron-updater on the **github provider** (releases of raccordai/raccordai, config in `electron-builder.yml`; the mac `zip` target is required — the updater installs from it, not the dmg). The packaged channel (`updateChannel` setting, stable|beta, Settings → Updates) drives BOTH the update feed (beta = `allowPrerelease`, i.e. GitHub prereleases `vX.Y.Z-beta.N` — never set `autoUpdater.channel` with this provider) and `getReleaseChannel()` (flag defaults). Dev builds: updater is a no-op ('unsupported'). macOS installs updates only on a signed app — until notarization ships, mac update attempts end in 'error'.
- **Release pipeline**: release-please tags/creates the GitHub release, then `publish-release.yml` (chained job — `release:` events never fire from GITHUB_TOKEN-created releases) builds the 3 OS and uploads installers + `latest*.yml`/blockmaps + stable-named aliases (`Raccord-mac.dmg`, `Raccord-windows.exe`, `Raccord-linux.{AppImage,deb}`) for permanent `releases/latest/download/...` links; it also has a manual `workflow_dispatch` on a tag for backfills. macOS is signed + notarized there via repo secrets (`MAC_CSC_LINK` base64 .p12, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); electron-builder skips notarization with a warning when they are absent, so PR/fork builds stay unsigned but green.
