# Evolution proposals

Working document — nothing below is committed to. Indicative effort:
S (< 1 day), M (a few days), L (a week+).

North star: **be the most intuitive tool to create AI videos through
workflows**. Everything shipped through July 2026 — onboarding + template
slots, rendered MP4 export, generation feedback layer, video-level defaults +
style-at-payload, graph ergonomics, assistant-first flows, the full assistant
sidebar (global shell, per-turn app context, unified tool registry with risk
taxonomy, smart batch runs in main, global thread + compaction, SSE streaming,
@-mentions) and the whole iteration loop of §6 (draft mode + finalize, vision
QC on settle, regional feedback, checkpoints, prompt lint, variants ×N) — is
recorded in git history and CLAUDE.md; only open work remains below.

## 1. Open-source hygiene — before publishing

Shipped: the README quickstart (install → key → first shot → export, plus
run-from-source, a docs index and the community links), `SECURITY.md`
(private reporting channels, scope, how secrets are handled),
`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and the three issue forms
(bug with version/OS/channel/area, feature, new kie.ai model) behind a
`config.yml` that routes vulnerabilities to a private advisory and questions
to Discussions.

The mac-signing question is settled too: a local signed `pnpm dist:mac`
confirms electron-builder gives every asarUnpack'd binary (ffmpeg, both
ffprobe arches, `better_sqlite3.node`) its own Developer ID signature with the
hardened runtime — which is what the notary service checks. `publish-release.yml`
now asserts it per binary instead of trusting `codesign --verify --deep`,
which only re-checks the resource seal and would happily pass an unsigned one.

| Proposal                                             | Effort | Why                                                                                                                                                          |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| README screenshots + demo GIF                        | S      | The only piece of the landing page still missing — needs real project media, mock-generated output would misrepresent the app                                |
| Enable secret scanning + push protection on the repo | S      | Repo setting, not a file — a maintainer flips it in _Settings → Security_ (documented in CONTRIBUTING.md and SECURITY.md, which already states it as active) |
| Create the `model` issue label                       | S      | `model_request.yml` applies it; GitHub silently drops a label that does not exist                                                                            |
| Enable GitHub Discussions                            | S      | `.github/ISSUE_TEMPLATE/config.yml` and CONTRIBUTING.md send questions and open-ended ideas there                                                            |

## 2. Quality & CI chain

Shipped: the versioned E2E suite — `e2e/` (`pnpm e2e`, dedicated CI job).
The Playwright drivers and the kie mocks that used to live in session
scratchpads are now a harness: each spec launches the built app with a
throwaway `--user-data-dir` and its own local-API port (nothing touches the
developer's install, so no spec needs a cleanup step), against one mock that
serves every kie surface — jobs, Suno, uploads, credit balance, the Claude
proxy — plus the result media, and records what the app submitted so a spec
can assert the payload and not just the outcome. Three specs: generation +
poller + `media://` (and the style-at-payload rule), the home assistant, and
the MP4 render (heterogeneous clips + Suno music + cancellation, MCP-driven
to bypass the save dialog, asserted with ffprobe on the produced file).
Rules and how to add a spec: `e2e/README.md`.

## 3. Technical robustness

Shipped: the arm64-native ffprobe (`@ffprobe-installer/ffprobe` replaced
`ffprobe-static`, whose darwin/arm64 binary was actually x86_64 and broke the
MP4 render on Apple Silicon without Rosetta 2); disk cleanup on delete
(`deleteProject` removes the project's media directory; `deleteVideo` and the
undo/checkpoint diff-restore delete the media files of the generations their
cascade removes); and the reliability layer — a rotating file log
(`userData/logs/main.log`, `services/logger.ts`) fed by main's services,
`uncaughtException`/`unhandledRejection` handlers, and a renderer error funnel
(`lib/errorReporter.ts`: ErrorBoundary + route error screen, global
query/mutation `onError`, window error/unhandledrejection, deduped error
toasts, everything mirrored to the log via `log:renderer`). Silent failure is
no longer the renderer's default, and a packaged-build bug report can now
attach a log file.

| Proposal                                                  | Effort | Why                                                                                                             |
| --------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Opt-in crash telemetry (Sentry or self-hosted equivalent) | M      | The log file covers the local case; without aggregated crash reports, patterns across installs remain invisible |

## 4. Product — smaller items

Shared constraints: renderer→main goes through a zod contract in
`src/shared/ipc/contracts.ts` + handler in `src/main/ipc/index.ts`; business
logic in `src/main/services/`; SQLite migrations are **additive only**; every
user-visible string gets an i18next key in fr **and** en; graph mutations go
through the graph service (`withGraphHistory`); colors through the
`styles.css` tokens.

| Proposal                                                                           | Effort  | Why                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grow the model catalogue (Veo, Kling variants, Flux…)                              | S/model | The registry makes adding nearly declarative: one file + one entry in `MODELS`, invariant tests come for free                                                                                                            |
| Move the remaining hardcoded strings of `NodeParamsPanel` + `ModelNode` to i18next | S       | Node action tooltips, "No output yet", the promote-asset form are hardcoded English — the canvas is only partially localized (full inventory: §7.7)                                                                      |
| More i18n locales (es, de, ja) through community contributions                     | S       | The i18n infra + parity test makes contributing a locale trivial and safe                                                                                                                                                |
| Verify the per-model credit rates against the kie.ai dashboard                     | S       | Video models are done (Seedance 2 family, then Kling 3.0 + Grok Imagine from the dashboard, with `draftEquivalent` on Grok — draft mode now covers the whole video catalogue); the image/Suno rates are still indicative |
| Per-project soft budget (`creditWarnThreshold`) in the cost modal                  | S       | Warn when `projectCreditsUsage + planned` exceeds a per-project threshold                                                                                                                                                |
| Move `autoLayout.ts` (pure) to `src/shared/` and expose a `tidy_workflow` tool     | S       | Optional leftover from the tool-registry unification — the assistant/MCP can't tidy the canvas yet                                                                                                                       |
| Click-to-focus affordance on node ids in assistant replies                         | S       | Optional transcript polish left out of the sidebar work — `focus_node`/`event:focusNode` already exist                                                                                                                   |

Cleanup (fold into whichever item touches the file first): undo/redo stacks
(`graphHistory.ts`, in-memory, cap 100) and retry budgets reset silently on
restart — acceptable, but document it in the UI (tooltip on the undo button)
or persist if it ever bites.

## 5. Ecosystem & differentiation

Shipped: the MCP surface no longer has write-only gaps — an agent can now
undo any wiring it does (`disconnect_edge`, `reorder_edges` — the order IS
the @Image1/@Image2 semantics), move nodes (`update_node_position`), swap a
model in place (`replace_node_model`, destructive: generations don't survive
a model change), toggle vision QC (`set_qc_enabled`), manage checkpoints and
notes end-to-end (`delete_checkpoint`, `add_annotation`, `delete_annotation`),
check what a deletion breaks (`asset_references`), see the queue
(`queue_state`) and per-project spend (`project_credits_usage`), and drive the
render fully (`render_video` with fps/resolution, `cancel_render`). The
last-frame extraction also moved into main (bundled ffmpeg, right after the
result downloads), so `lastFrame` edges resolve without any window — the one
hard blocker headless had; the renderer's canvas extractor remains as a
backfill for pre-existing rows.

| Proposal                                                                                                                             | Effort | Why                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Position the MCP server as the product's public API**: dedicated docs, client examples (Claude Code, scripts), registry versioning | M      | This is the differentiator: Raccord drivable by any agent. The registry exists, the showcase is missing                                         |
| Community "model packs" (dynamically loaded model definitions, with a validation sandbox)                                            | L      | Turns the registry into a community extension point — kie.ai's model release pace exceeds what one maintainer can track                         |
| "Headless" mode: the Hono server + generation engine without a window, drivable via MCP/HTTP                                         | L      | Opens batch/server use cases (personal render farm) reusing `src/main/services/` as-is — the window-bound last-frame dependency is already gone |
| Docs site (VitePress) generated from `docs/` + model docs generated from the registry                                                | M      | The model docs already exist in-band for LLMs (`mcp/docs.ts`) — publish them for humans too                                                     |

Note: the "agent-drivable render pipeline" pitch is complete end-to-end — the
MCP `render_video` tool closes the loop (brief → graph → generations → MP4
file) for any MCP client, including chained shots (`lastFrame` extraction no
longer needs an open editor window); headless mode would remove the last
constraint (a running window for the app shell itself).

## 6. The iteration loop — "Cursor of AI video" track

Thesis: what made Cursor win is not "AI in an editor" but a near-free
iteration loop — trying costs nothing, proposals are reviewable in seconds,
context is automatic, and every rejection becomes a signal. In AI video the
scarce resource is not generation, it is **iteration**: each try costs
credits and minutes, the user's judgment never re-enters the system, and
nobody looks at the outputs except the user. Guiding metric for this whole
section: **cost (credits + minutes) from brief to the first shot the user
judges good**. Same shared constraints as §4.

The whole loop has shipped: **6.1** draft mode + finalize, **6.2** vision QC
on settle, **6.3** regional feedback (annotate a region or a timecode → a
pre-wired fix node), **6.4** named checkpoints + diff + one-step restore,
**6.5** prompt lint (params panel, run confirm, `lint_node`, folded into the
QC verdict) and **6.6** variants ×N + compare grid. Details in CLAUDE.md and
`docs/mcp.md`; only the ambient layer below is still open, and it is
deliberately last — it feeds on the signals the loop now produces.

Three later steps extended the same track without changing its thesis: **6.8**
recipes (one registry for every pre-configured node, design sheets and shot
presets), **6.9** the prompting doctrine as data plus an assembler, and **6.10**
casting — the film's named identities. The library already stored what a sheet
IS; nothing stored who that is for the film, so "the girl with pink hair" was
re-described in every prompt and drifted a little each time. A role names a
published sheet once, and casting it wires that sheet on every shot with its
identity sentence, in one undo step.

**6.11** closes the brief → film path: the scenario (§6.7) already produced, per
shot, exactly the values a shot preset (§6.8) asks for, but nothing consumed
them — only the assistant went from shot list to graph, freehand, and re-derived
the same decisions differently every time. `build_graph_from_scenario` makes that
step deterministic: a pure matcher reads each shot's camera line to pick its
preset, the shot's own legal duration lands in both the param and the prompt's
beat timeline, and the roles the scenario named are cast on exactly the shots
that name them — one undo step, no model call at the last mile.

**6.12 — the timeline became an editor** (shipped). It used to be a player: no
trim (a 5 s clip with 1.2 s of unusable tail meant re-generating), order read
from the first number in the node's LABEL (reordering = renaming), cuts only,
no titling. Now the shared contract (`src/shared/timeline.ts` + additive node
columns) carries an explicit per-clip order, a clamped trim window and a
per-cut transition, mutated only through the journaled graph service (drag a
clip or use the scissors popover in TimelineV2; agents use
`set_timeline_order` / `set_clip_trim` / `set_clip_transition`) and honoured
by all three consumers — playback, FCPXML (spine in-points) and the MP4
render. The render gained transitions and burned subtitles — the E2E render
spec asserts the trimmed/crossfaded duration with ffprobe.

A second pass (**6.12b**) turned that foundation into a real editing surface:
a curated transition LIBRARY (`src/shared/transitions.ts`, ~10 xfade types —
crossfade, fade to black/white, wipes, slides, circle open, dissolve,
pixelize) with a per-cut length (0.1–2 s), per-clip TEXT LAYERS (node
`overlay` column: text + 9-position grid + size preset, previewed live in the
timeline player, burned at render), a per-render text WATERMARK (corner +
translucency, export dialog and `render_video`), all composited through ONE
libass pass alongside the scenario-dialogue subtitles. UX went with it: the
scissors popover became a full clip inspector (trim / transition + length /
text layer), clips open it on double-click, and the track gained horizontal
zoom (×1.5 steps, scrollable past fit) so a 3-minute edit stays readable.
Defaults stay invisible — nothing configured is a clean cut with no text.
Agents drive every bit of it (`set_clip_transition` with duration,
`set_clip_overlay`, watermark args on `render_video`).

**6.12c — the title track** (shipped): free text layers as a real track
(`text_layers` table), independent of the clips — absolute timeline seconds,
positioned ANYWHERE on the frame (normalized x/y + anchor) with full
typography (any system font, size as % of height, bold/italic, colour). The
UX is direct manipulation: the Type button drops a layer at the playhead, the
text is dragged INTO position on the player itself (the preview position is
the render position), the lane block is dragged to move it in time, and the
inspector owns the typography. Everything is MCP-drivable
(`list/add/update/delete_text_layer`) and burns through the same single
libass pass as the dialogue and the watermark — the E2E render spec asserts
the burn pass runs. Still open, deliberately: per-clip audio gain/ducking
(the §6.7 ambient layer stays last).

Two deviations from the original proposals, both deliberate: a checkpoint
restore replays the raw rows through undo's diff-restore instead of
`importWorkflow(replace)` (which would delete every generation of the video),
and the prompt lint also reports blocking problems (empty prompt, missing
required input) that used to surface only as a run failure.

### 6.7 Later — ambient layer (L)

These feed on the signals the loop above produces; do not start them first.

- **Taste memory**: distill selections/rejections/annotations into a
  per-video "taste memo" injected at-payload beside the style bible
  ("prefers long lenses, rejects fast camera moves") — learned, not
  declared.
- **Ghost nodes** — the "Tab" of video: after a settle, a semi-transparent
  suggested next shot (from storyboard panels not yet covered, or the
  rhythm of previous shots); Tab accepts, Esc dismisses.
- **Video-level audio**: TTS dialogue and SFX lanes as new registry model
  families — Suno alone is a music lane, a full film needs voices.

## 7. Deep audit — August 2026

A five-dimension audit (main services, renderer, shared modules + tests,
security, DX/CI/build) produced ~90 verified findings, every one checked
against the code with file:line references. The batches below are ordered by
leverage — each is roughly one focused session. Items already tracked in §4
(NodeParamsPanel/ModelNode i18n) are expanded here, not duplicated.

### 7.1 Security hardening (S — the two critical ones are ~15 lines total)

| Fix                                                                                                                                                                                                                                                                                                                  | Sev | Where                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------ |
| No `will-navigate` guard: a file dropped outside the canvas navigates the window to `file:///…`, and the loaded page inherits the full `window.api` bridge — including `settings:localApiInfo`, which returns the Bearer token in the clear. Add the guard + global `dragover`/`drop` preventDefault in the renderer | 🔴  | `src/main/index.ts:43-77`                                    |
| `shell.openExternal` without a scheme allowlist, fed by assistant-rendered links (influenceable content): restrict to `http(s)`                                                                                                                                                                                      | 🔴  | `src/main/index.ts:67-70`                                    |
| `render_video`'s `outputPath` is an unvalidated absolute path with `risk: 'write'` — arbitrary file write that bypasses the approval card. Constrain (extension + directory) and/or reclassify `destructive`; same, weaker, for `add_asset_from_file`                                                                | 🟠  | `src/main/mcp/registry.ts:1439-1497`, `render.ts:554`        |
| Backup restore does not confine imported `file_path` rows under `userData/media` — a hostile `.raccord` can make `media://` (and `imageBlockFor` → kie upload) serve arbitrary local files                                                                                                                           | 🟠  | `src/main/services/backup.ts:208-234`, `protocol.ts:66-82`   |
| `RACCORD_KIE_BASE` honoured in packaged builds — an env var redirects every request carrying the kie key. Gate on `!app.isPackaged` like the safeStorage override                                                                                                                                                    | 🟠  | `src/main/services/kie.ts:13-20`                             |
| Local-API token stored unencrypted and shipped inside `.raccord` backups; never rotated on import. Exclude from the snapshot + regenerate after restore                                                                                                                                                              | 🟠  | `src/main/services/settings.ts:189-194`                      |
| `sandbox: false` contradicts SECURITY.md; the preload only uses sandbox-compatible APIs — try `sandbox: true` against the E2E suite                                                                                                                                                                                  | 🟠  | `src/main/index.ts:60`                                       |
| Unbounded remote downloads buffered in RAM (`arrayBuffer()` on results, asset-from-url, render `downloadTo`) — stream to disk with a byte cap, refuse non-http(s)                                                                                                                                                    | 🟠  | `runEngine.ts:480-485`, `assets.ts:165-180`, `render.ts:162` |
| Low-severity batch: deny-all `setPermissionRequestHandler`, `base-uri`/`form-action`/`frame-ancestors` in the CSP, narrow `connect-src https:` to kie hosts, auth or strip `/health`, `timingSafeEqual` on the token, pin actions by SHA in `publish-release.yml`                                                    | 🟡  | various                                                      |

Verified sound (do not "fix"): `media://` has no path traversal, the backup
zip-slip guard is correct (absolute + Windows paths included), ffmpeg/ASS
escaping is right, no kie-key leak path found (25 call sites checked), IPC
validates input **and** output, no `dangerouslySetInnerHTML`, agent loop is
bounded.

### 7.2 Generation reliability (M)

| Fix                                                                                                                                                                                                                                                                                                                                  | Sev | Where                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------------------------------------------------ |
| Queue-slot leak: deleting a node/video/project with a run in flight never releases the slot (`pollGeneration` exits silently on a missing row, `release()` only fires on settle) — two deletions with the default limit of 2 and nothing generates until restart. Cancel before delete, or reconcile `queue.snapshot()` vs live rows | 🔴  | `runEngine.ts:54-59, 658-664`                    |
| Poller timeout (10 min flat) marks possibly-succeeded generations `fail`, and `refreshStatus` never re-queries failed rows — credits spent, result unrecoverable. Kind-dependent cap + a re-queryable `timeout` status                                                                                                               | 🔴  | `runEngine.ts:44-45, 697-706, 889-901`           |
| No graceful shutdown: `closeDatabase()`/`stopLocalApi()` never called on quit, active ffmpeg renders not killed — unchekpointed WAL, orphan processes. One `before-quit` handler                                                                                                                                                     | 🔴  | `src/main/index.ts:141-143`                      |
| `activeRenders.set` before `mkdtempSync` outside the try: a tmpdir failure wedges "render already in progress" until restart                                                                                                                                                                                                         | 🔴  | `render.ts:216-217`                              |
| Sync buffered media I/O freezes main (pollers, IPC, `media://`): whole MP4s through `writeFileSync`/`arrayBuffer`, `readFileSync` uploads, serial asset hashing — switch to streams                                                                                                                                                  | 🔴  | `runEngine.ts:485`, `kie.ts:285`, `assets.ts:21` |
| Settle bus doesn't isolate listeners: one throwing subscriber starves queue release / OS notification / chat wake-up. try/catch per listener                                                                                                                                                                                         | 🟠  | `bus.ts:25-27`                                   |
| A settle only wakes the FIRST watching thread (`return` instead of `continue` in the loop)                                                                                                                                                                                                                                           | 🟡  | `chat.ts:1313-1339`                              |
| Failed result download is invisible: row stays `success` with null `resultPath`, retried only at next startup. Store the error + a "re-download" action                                                                                                                                                                              | 🟡  | `runEngine.ts:553-557`                           |
| Unpurged in-memory state: undo stacks per deleted video, chat `sessions`, `retryCounts` — purge on delete + LRU                                                                                                                                                                                                                      | 🟡  | `graphHistory.ts:40-42`, `chat.ts:872`           |

### 7.3 Product bug quick wins (S)

| Fix                                                                                                                                                                                                  | Sev | Where                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------- |
| ⌘C is dead outside inputs while the editor is mounted: `useShortcut` calls `preventDefault()` before the handler's text-selection guard — selecting assistant-transcript text then ⌘C copies nothing | 🔴  | `useShortcut.ts:42`, `WorkflowEditor.tsx:542`         |
| Space no longer activates focused buttons anywhere in the editor (`playPause` binds bare Space + systematic preventDefault; only `VIDEO` targets are exempt)                                         | 🔴  | `lib/shortcuts.ts:45`, `TimelineV2.tsx:807`           |
| Casting/checkpoints/annotations created by the assistant stay invisible until remount: `event:workflowChanged` never invalidates those query keys. Centralize the list in `data.ts`                  | 🔴  | `main.tsx:56-67`                                      |
| Merged scenario beats inherit `closesOn` (and `screenDirection`) from the FIRST beat — the shot claims an exit frame it no longer closes on, and the raccord warning never fires                     | 🔴  | `shared/scenario.ts:163-193`                          |
| `'4K'` (contracts) ≠ `'4k'` (seedance-2): the video-level 4K default silently never applies to the only model that reaches 4K. Add the enum-vs-models invariant test                                 | 🔴  | `contracts.ts:98`, `models/seedance-2.ts:6`           |
| Unknown `select` value in a recipe injects the literal string `"undefined"` into the prompt (`frag()` should fall back to the default; MCP promises it does)                                         | 🔴  | `designs/registry.ts:528-534`                         |
| MCP surface never validates args against `inputSchema` — `Number("abc")` NaN reaches `trim_start_sec`/text layers (all guards are false for NaN). Validate at entry + `Number.isFinite` in services  | 🟠  | `mcp/registry.ts:1673-1682`, `graph.ts:280`           |
| Window listeners without unmount cleanup (timeline resize/drag, sidebar resize) keep firing `setState`/IPC after unmount mid-drag                                                                    | 🟠  | `TimelineV2.tsx:626,1324`, `AssistantSidebar.tsx:114` |
| Modals (Compare, Annotate, CostPreview, FrameAnchor, Finalize, RestoreConfirm) have no Escape / focus trap / focus restore — a shared `useModal` next to `useDismissable`                            | 🟠  | 6 components                                          |
| Six independent accent-folding implementations (two different Unicode spellings) — export one `foldText()` from `@shared`                                                                            | 🟡  | `assets/search.ts:17` + 5 more                        |
| Dead code: 6 IPC channels with no consumer (incl. `settings:*GenerationConcurrency` — the documented setting has NO UI), `features/projects/useProjects.ts` unused                                   | 🟡  | `ipc/index.ts:314`, others                            |

### 7.4 Package size & startup (M)

- **≈75 MB of dead asar** (DMG is 237 MB): renderer deps (`lucide-react`
  39 MB, `react-dom`, `@xyflow/react`, routers…) are copied into the asar
  _on top of_ the Vite bundle, and `@anthropic-ai/sdk` (10 MB) is only ever
  `import type`. Move them to `devDependencies` (keep `@dagrejs/dagre` — main
  imports it via `graphLayout`). `electron-builder.yml:9-12`,
  `package.json:50`.
- **First paint waits on everything**: window is created only after
  `await startLocalApi()` + sync migrations + backfills + `resumePolling()`
  (two full-scan SELECTs) + `initUpdater()`. Create the window right after
  `registerIpcHandlers()`, defer the rest. `src/main/index.ts:123-130`.
- **Zero `React.lazy` in the renderer** (editor chunk 825 KB, index 1.12 MB):
  lazy-load ExportDialog, AnnotateModal, Checkpoints/Scenario/History panels,
  ChatPanel (react-markdown only serves the assistant).
- `initI18n` blocks `createRoot` on a `settings:getLocale` IPC round-trip,
  and both 40 KB locale JSONs are bundled statically — dynamic-import the
  non-active locale, paint a shell first. `renderer/src/main.tsx:37-39`.
- `files: out/**` also packs stray `out/tsc-*` typecheck output — narrow to
  the three real bundles; add `sourcemap: 'hidden'` (maps are already
  excluded from the package, but a packaged crash is currently unsymbolizable).

### 7.5 Runtime performance (M)

One recurring shape: **broadcasts too wide × queries too heavy**. Every
poller tick emits `event:generationsChanged`; the renderer ignores the
`{videoId, nodeId}` payload and invalidates 7 root query keys; and
`generations:listForVideo` returns every column including multi-MB
`inputSnapshot` blobs (`generations.ts:20-27`) while every `ModelNode` also
runs its own per-node query (30 nodes = 30 IPC per tick). Fixes, in order of
yield: filter invalidations by the payload's videoId, project the SELECT
(drop `inputSnapshot`/`qc_notes`), derive per-node data from the single
per-video query via `select:`. Then: the lint's per-edge node SELECT ×2
multiplied by `planBatch` (`lint.ts:47-54`), `projectsOverview` loading every
generation on disk for a thumbnail (`library.ts:27-41`), serial
`useAssetNodeMedia` (`data.ts:56-75` — `Promise.all` or `assets:getMany`),
settings/safeStorage hit on every poll (`kie.ts:22-30` — cache, invalidate on
write), zod output-parsing of large lists on every invalidation
(`ipc/index.ts:44-48` — keep strict in dev/E2E only).

### 7.6 Test gaps on risk-bearing code (M)

The pure modules are well tested; the services that MOVE the risk are not:

| Gap                                                                                                                                                                                  | Where                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `checkpoints.ts` — the product's only `destructive` op: zero tests, not in `coverage.include`, zero E2E spec (its twin `graphHistory.ts` is at 94.5%)                                | `services/checkpoints.ts:121-167`                                  |
| `lint.ts` `connectionsFor` — the "@Image2 here == @Image2 at payload" promise (edge ordering + per-handle counter) rests on untested sorting                                         | `services/lint.ts:29-60`                                           |
| `estimateNodeRunCredits` (the number shown before spending, draft-aware), `annotations.ts` `createEditNodeFromAnnotations`, `wrapPromptWithStyle` (all 3 branches)                   | `generations.ts:39`, `annotations.ts:96`, `styles/registry.ts:221` |
| The §6.11 `durationSeconds` invariant ("the subtle part") — no test builds a recipe node with an imposed duration and checks param + beat timeline agree                             | `designs/registry.ts:1416-1435`                                    |
| Template test has dead branches asserting the INVERSE doctrine — replace with `no edge has output === 'lastFrame'` across all templates                                              | `templates/registry.test.ts:244-262`                               |
| `transitions.ts` is the only registry without a registry test; board/anchorSafe invariant claimed "registry-tested" but isn't; i18n parity untested for templates/styles/transitions | various                                                            |
| `checkpointDiff` edge key ignores `edge.output` — an output→lastFrame rewire can read `identical: true` before a destructive restore                                                 | `shared/checkpointDiff.ts:41-43`                                   |
| E2E: no checkpoints spec; text-layers covered only by `create`; casting missing the idempotence second pass (`alreadyCast`)                                                          | `e2e/specs/`                                                       |

### 7.7 i18n debt (S)

Both locales are at perfect parity (746 keys each) — the problem is ~50
strings that never enter them: ~35 in `NodeParamsPanel` (the most-used
surface), ~15 in `ModelNode` (extends the existing §4 row), plus main-built
sentences (`casting.ts` skip reasons, `scenarioGraph` notes,
`describeRegion`) displayed raw — those should become code + params
translated renderer-side (the English text stays for prompts/agents). Add a
CI guard (grep capitalized JSX text) so it can't regress. Also: raw hex
colors in React Flow props duplicate the styles.css tokens and are invisible
to the ESLint rule (`WorkflowEditor.tsx:260`, `ModelNode.tsx:337,462`) —
extend the rule to hex literals.

### 7.8 CI chain (S/M)

- `package.yml` **notarizes macOS on every PR** (3-15 min, rate-limited) and
  exposes the `.p12` signing secrets to PR code — restrict packaging to main
  - dispatch, gate secrets on `event_name != 'pull_request'`.
- typecheck/test run 4× per push across `ci.yml`/`package.yml`; `pnpm build`
  runs twice in the same CI run; no Electron/electron-builder cache (~200 MB
  re-downloaded × 5 jobs); no `concurrency` groups; no `timeout-minutes` on
  most jobs; `ci.yml`/`package.yml` lack a `permissions` block.
- `pnpm lint` is laxer than the pre-commit hook (no `--max-warnings 0`, no
  `--cache`); `typecheck` runs two sequential `tsc` with incremental
  explicitly disabled (`--composite false`) — use `tsc -b`.
- E2E runner: spec timeout (8 min × 6 specs) exceeds the job timeout
  (20 min) so a wedged spec is killed by GitHub without diagnostics, and
  SIGKILL hits the wrapper, not the Electron grandchild — orphans poison the
  following specs (`e2e/run.mjs:43-55`: `detached: true` + kill the group,
  listen on `'close'`).

## Suggested order

1. **§7.1 security** — the two critical items are ~15 lines and close the
   widest gap between SECURITY.md's stated model and reality.
2. **§7.2 generation reliability** — the slot leak and the poller timeout
   lose user credits today.
3. **§7.3 quick wins** — ⌘C/Space/invalidations/`closesOn`/`4K` are each
   small and user-visible.
4. **Finish §1** — four GitHub-side actions plus the README visuals.
5. **§7.4–7.8** — size/startup, perf, tests, i18n, CI, in whatever order
   touches files already being edited.
6. **Ecosystem** (§5) — the unified tool registry doubles as MCP-surface
   hardening for the "public API" pitch.
7. **Ambient layer** (§6.7) — now unblocked: the loop produces the signals it
   needs (selections, annotations, QC verdicts).

Growing the E2E suite is not a step of its own any more: a flow worth
protecting gets its spec in `e2e/` as part of the work that introduces it —
§7.6 lists the three specs the audit found missing.
