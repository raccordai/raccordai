# Evolution proposals

Working document — nothing below is committed to. Indicative effort:
S (< 1 day), M (a few days), L (a week+).

North star: **be the most intuitive tool to create AI videos through
workflows**. The July 2026 audit (renderer UX, workflow building blocks,
generation lifecycle) found the capabilities largely in place — templates,
design recipes, storyboard pre-viz, a full-project assistant, dependency-aware
runs, undo/redo, gapless timeline, rendered MP4 export — and the remaining
friction concentrated in two moments of the user journey. The first — **the
first fifteen minutes** (no onboarding, nothing pushing the user to configure
the kie.ai key without which the app is inert) — is now addressed by the
first-run onboarding + template slot form (see "Shipped"). The remaining one:

- **Trust while generating** — queue position, automatic retries and
  aggregate cost are invisible; errors surface as native `alert()`s.

The assistant currently exists to paper over manual-editor friction. The
long-term differentiator is to invert that: make the conversational path the
primary one (§4.7) on top of a manual editor that no longer needs papering
over (§4.4–4.6).

## Shipped

Landed in July 2026 (see CHANGELOG once releases start):

- **MIT license** (`LICENSE`, `license` field in package.json).
- **ESLint + Prettier + lefthook**: flat config with a custom rule banning raw
  Tailwind color classes (tokens only), format baseline on the whole repo,
  pre-commit hooks (lint + prettier on staged files), lint/format gates in CI.
  Note: typescript-eslint runs on its own TS 5.x via `.pnpmfile.cjs` until the
  TS 7 programmatic API lands (7.1).
- **Conventional commits + release-please**: commitlint at commit-msg,
  release-please workflow maintains the release PR / CHANGELOG / tags.
- **Dependabot + CodeQL**: weekly npm & actions updates (Electron majors
  excluded — ABI), CodeQL analysis. Secret scanning + push protection remains
  a one-time repo setting to flip after the GitHub push (see CONTRIBUTING.md).
- **Multi-OS packaging in CI** (`.github/workflows/package.yml`): mac/win/linux
  matrix, unsigned builds, `--publish=never`, binaries as 7-day artifacts.
  electron-builder targets added for Windows (NSIS) and Linux (AppImage/deb).
- **Full backup/export `.raccord`** (`src/main/services/backup.ts`): streamed
  ZIP of a `VACUUM INTO` db snapshot + the media store; import validates the
  manifest before touching live data, keeps the previous db as `.bak-<ts>`,
  merges media and relaunches. UI in Settings → Backup.
- **Auto-update via electron-updater** (`src/main/services/updater.ts`): GitHub
  provider on raccordai/raccordai releases, channel setting (stable|beta,
  Settings → Updates) drives both the update feed and `getReleaseChannel()`.
  macOS builds are signed + notarized in the publish workflow.
- **First-run onboarding + template slot form** (§4.1 + §4.2, July 2026):
  `onboardingCompleted` setting (back-filled at startup when a kie key already
  exists), three-step overlay from `__root.tsx` (language / kie key with live
  validation via the new `settings:testKieApiKey` channel / starter project
  seeded from `product-commercial` with example fills), persistent missing-key
  banner with CTA to Settings. Templates now declare slot metadata
  (`slots: {token, i18nKey, example}[]` + shared `SLOTS` vocabulary) rendered
  as a per-slot field form in the new-video dialog; `fillTemplateSlots` (pure,
  unit-tested) string-replaces across the whole blueprint, blank fields keep
  their token (assistant-fillable). Registry test enforces token↔blueprint
  parity in both directions and fr/en label resolution; the MCP `templates`
  docs topics expose tokens + examples. Verified end-to-end (fresh profile,
  invalid/valid key, starter project with zero remaining `[SLOT]` markers,
  back-fill, banner).
- **Rendered MP4 export** (§4.3, July 2026): `render:export` IPC + MCP
  `render_video` → `src/main/services/render.ts` (orchestration) +
  `renderPlan.ts` (pure decisions, unit-tested). ffmpeg-static/ffprobe-static
  binaries (asarUnpack'd), probe → lossless concat or per-clip normalize →
  Suno lane muxed over; still fallback for failed shots; progress island +
  cancel driven by `event:renderProgress`. The timeline helpers moved to
  `src/shared/timeline.ts` and the dead `Timeline.tsx` component was removed
  (§4.9). Verified end-to-end against the kie mock (heterogeneous clips +
  music, cancellation).

## 1. Open-source hygiene — before publishing

| Proposal                                                              | Effort | Why                                                                                                                                                      |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public README: screenshots, demo GIF, quickstart                      | S      | It is the project's landing page                                                                                                                         |
| `CODE_OF_CONDUCT.md` + issue templates (bug / feature / kie.ai model) | S      | Frames the discussions and structures bug reports (version, OS, channel)                                                                                 |
| Security policy (`SECURITY.md`)                                       | S      | Private vulnerability reporting channel — the app handles API keys                                                                                       |
| Enable secret scanning + push protection on the GitHub repo           | S      | Repo setting, not a file — flip it right after the first push (documented in CONTRIBUTING.md)                                                            |
| Confirm mac notarization covers the asarUnpack'd ffmpeg/ffprobe       | S      | One-time check on the next publish run — electron-builder signs `app.asar.unpacked` by default, but only the signed pipeline (repo secrets) can prove it |

The "audit personal strings/paths in git history" item is resolved by
construction: the repo publishes with a fresh history (no pre-publication
commits), and the working tree was swept before the first push.

## 2. Quality & CI chain

| Proposal                                                                                                                                                 | Effort | Why                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formalized E2E: promote the Playwright drivers + kie/Anthropic mocks from the session scratchpads into a versioned `e2e/` suite, with a dedicated CI job | L      | This is the layer that covers runEngine/chat/IPC/render, deliberately outside the unit scope. The harness exists (RACCORD_KIE_BASE / RACCORD_ANTHROPIC_BASE), it just isn't versioned. Ready to promote: the MP4-render driver (heterogeneous clips + Suno music + cancellation, MCP-driven to bypass the save dialog; suno mock endpoints documented in the verify skill) |

## 3. Technical robustness

| Proposal                                                  | Effort | Why                                                      |
| --------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Opt-in crash telemetry (Sentry or self-hosted equivalent) | M      | Without crash reports, open-source support will be blind |

## 4. Product — intuitiveness track

Each item below is specced against the code as of July 2026. Shared
constraints that every spec must respect: renderer→main goes through a zod
contract in `src/shared/ipc/contracts.ts` + handler in `src/main/ipc/index.ts`;
business logic in `src/main/services/` (shared by IPC and Hono routes);
SQLite migrations are **additive only**; every user-visible string gets an
i18next key in `fr/common.json` **and** `en/common.json`; graph mutations go
through the graph service so `withGraphHistory` journals them; colors through
the tokens in `styles.css`.

### 4.1–4.3 First-run & onboarding, template slot filling, rendered MP4 export — shipped (see "Shipped"; §4.3 follow-ups folded into §2, §4.4, §4.5)

### 4.4 Generation feedback layer — effort S/M (best ratio of the roadmap)

**Problem.** The engine (`runEngine.ts`, `genQueue.ts`) is sophisticated —
slot-based queue (limit = `maxConcurrentGenerations`), smart retry
(`maybeScheduleRetry`, 3×, `isRetryableGenerationError`), startup resume —
but almost none of it is visible: `pending` renders identically to `running`
("Generating…"), `queue.snapshot()` is consumed nowhere, retries only leave a
`console.warn` and a "(after N automatic retries)" suffix on the final error,
there is no completion notification, and every error/confirmation goes
through native `alert()`/`confirm()`.

**Spec — four independent sub-items.**

1. **Toast + modal system (S/M)** — one renderer toast stack (island style,
   token colors, auto-dismiss for info, sticky for errors) and one styled
   confirm modal. Replace every native call site: node/asset delete and
   frame-anchor guard in `WorkflowEditor.tsx`, run failures in
   `runWithDeps`/`handleRunAllVideos`, refresh/cancel in `ModelNode.tsx`,
   export errors in `useWorkflowIO.ts` (incl. the MP4 render failure and
   skipped-clips alerts), model-replace confirm. All strings
   through i18n (several of these are currently hardcoded English — folds in
   part of §4.9).
2. **Queue & retry visibility (S)** — new read-only channel
   `generations:queueState` exposing `queue.snapshot()` (running ids, queued
   ids in order, limit) + `event:queueChanged` broadcast on
   enqueue/adopt/release. `ModelNode` renders three distinct states:
   "Queued (position N)" / "Generating…" / "Retrying (attempt K/3)". Retry
   state: have `maybeScheduleRetry` broadcast the attempt counter with the
   generation-changed event (in-memory is fine; persisting a `retry_count`
   column is optional and additive if we want it to survive restart).
3. **Completion notifications (S)** — Electron `Notification` from main on
   `generationSettled` when the window is unfocused, and a summary
   notification when a run-all batch fully settles (all watched generations
   of the batch done: "4 succeeded, 1 failed"). Toggle in Settings → General
   (`notifyOnCompletion`, default on). Clicking focuses the window on the
   node (reuse HistoryPanel's `focusNode` path).
4. **Cost preview & budget (S/M)** — `runWithDeps` already topo-resolves the
   exact node set before running: before a multi-node run or "Generate
   videos (N)", show a confirm modal with the per-node breakdown
   (`estimateCreditsFor`), the total, and the current balance (HeaderCredits
   data), with "don't ask under X credits" remembered. Optional per-project
   soft budget: `creditWarnThreshold` setting; when
   `projectCreditsUsage + planned > threshold`, the modal warns. Also add an
   explicit **Retry** button on failed `GenerationCard`s (today the user
   must guess that re-clicking ▶ works) — it simply re-runs the node.

**Acceptance.** Zero `alert(`/`confirm(` calls left in the renderer; with
limit 2 and 4 queued nodes, two show "Queued"; killing the mock mid-run shows
"Retrying (1/3)" live; a run-all on the mock ends with an OS notification and
a cost modal was shown before it started.

### 4.5 Video-level settings & style propagation — effort M

**Problem.** Aspect ratio and resolution are set per node with no
video-level default — nothing guarantees a coherent sequence, and there is no
"make the whole video 9:16" gesture. Separately, the style bible
(`getStyle().styleBible`) is **copied verbatim into every prompt** by
convention (templates via `bible(styleId)`, assistant by instruction): a
style change propagates to nothing, and prompts are 80% boilerplate.

**Spec.**

- **Video defaults** — additive `videos` columns (or a JSON `settings`
  column): `default_aspect_ratio`, `default_resolution`. Editable from a
  small "Video settings" section (params panel when no node selected, or the
  Style menu). Semantics chosen for predictability (no silent behavior change
  at generation time): (a) node creation pre-fills matching params from the
  defaults (`defaultParamsFor` merge point); (b) changing a default offers an
  explicit **"Apply to N existing nodes"** action — a bulk
  `nodes:updateParams` through the graph service, so it is journaled and
  undoable in one step. No hidden fallback-at-runtime.
- **Style bible at payload time** — stop baking the bible into stored
  prompts. New node meta `applyVideoStyle: boolean` (default true for new
  nodes created while a style is set; absent = false for pre-existing nodes,
  whose prompts already contain the bible — this is the whole back-compat
  story, no migration needed). `prepareRun` (runEngine.ts) appends the
  current style bible to the prompt when the flag is set, **before** the
  input snapshot is persisted — so retries and re-queues stay deterministic,
  and `get_workflow` can show the effective prompt. Update: templates drop
  `bible(...)` from their prompt strings (they set the flag instead), both
  chat SYSTEM prompts and the `workflow-json`/`designs` docs topics stop
  instructing verbatim copying, `registry.test.ts` invariants adjusted.
  The params panel shows the business prompt in the textarea and the style
  suffix as a read-only collapsed section ("Style: anime — applied at run").
- **Follow-up unlocked by the defaults**: MP4 export presets per destination
  (9:16, 1:1, 16:9) on top of the render pipeline's existing fps/resolution
  overrides (`render:export` already accepts them; only the preset UI is
  missing once the video-level aspect ratio exists).

**Acceptance.** Switching a video's style then re-running a node uses the new
bible with no prompt edit; changing the default ratio and applying updates
all video nodes in one undo step; old workflows (bible embedded in prompts)
run byte-identical payloads.

### 4.6 Graph ergonomics — effort S–M per sub-item

**Problem set** (all confirmed in code):

- `@Image1/@Image2` numbering depends on **edge creation order** — invisible
  and fragile (`importWorkflow` even has to validate strictly-increasing
  numbering to protect templates).
- The anchor-vs-reference distinction — the documented #1 pitfall — is
  guarded only by a native `confirm()` in `onConnect`.
- No right-click menus (pane or node), no media-file drop on the canvas, no
  node copy/paste. The toolbar combobox is the sole creation path.
- No side-by-side comparison of two generations of a node (stacked list +
  one-at-a-time lightbox only).

**Spec.**

1. **Visible, reorderable reference numbering (M)** — render the computed
   alias (`@Image2`) as a badge on the edge label and on the existing
   reference chips in `ModelNode`. In `NodeParamsPanel`, list the
   connections of a multi-reference input with up/down reorder → new
   `edges:reorder` channel (graph service, journaled). The number the model
   sees becomes the number the user sees.
2. **Anchor/reference made legible (S/M)** — replace the `confirm()` guard
   with a styled modal (two illustrated columns: "will appear on screen" vs
   "guides only, never on screen", CTA "wire as reference instead" when the
   target model has a reference input). Permanently distinguish
   `frameAnchor: true` handles with a dedicated token color + icon so the
   distinction is learned, not just policed. (Derives from `InputHandle.
frameAnchor` — already the single source of truth for tests and the
   guard.)
3. **Canvas affordances (S each)** — pane right-click → add-node menu at
   cursor position (reuse `AddNodeMenu`, spawn at click coords instead of
   viewport center); node right-click → Run / Duplicate / Replace model /
   Delete (same actions as the header icons); drop image/video files on the
   canvas → import via the existing assets import path + create a
   `studio/asset` node at the drop position; copy/paste of selected nodes
   (serialize the subgraph as a workflow-JSON v1 fragment, paste through the
   `importWorkflow` validator with fresh keys and an offset).
4. **A/B generation compare (M)** — from a node's generation list, pick two
   → side-by-side panel (synced play/pause/scrub for videos, synced zoom for
   images) with "Use this" on each side (`generations:select`). This is the
   core iteration gesture; today it requires memory and scrolling. (Note:
   TimelineV2's "A/B player" is double-buffering for gapless playback, not
   comparison — naming worth clarifying in code comments.)

### 4.7 Assistant-first flows — effort M/L

**Problem.** The assistant (per-video + home personas, `chat.ts`) can already
deliver a full project — create project/video, set style, one-shot
`import_workflow` of a multi-scene graph, run and self-resume on
`generationSettled`. But it works as a repair layer over manual friction,
its plans are only visible as prose, and it has exactly one autonomy gap:
it cannot import assets (it must ask the user to use the Assets tab).

**Spec.**

1. **Brief → plan → execute (M/L)** — new tool `present_plan` whose input is
   structured JSON (`shots: [{label, description, modelId, estCredits,
panels?}], style, totalCredits`). The ChatPanel renders it as a card list
   (per-shot model + cost, grand total vs balance) with **Approve** /
   **Request changes** buttons that post back as user messages. Both SYSTEM
   prompts instruct: always `present_plan` before `import_workflow` on any
   multi-shot build, and before any run batch whose total exceeds the
   §4.4 confirmation threshold. This is the conversational sibling of the
   storyboard gate: a validation step before spending. Plan cards persist in
   the transcript (chatStore) like tool chips do.
2. **Asset import autonomy (S)** — chat image attachments already exist
   (≤4, ≤5MB): add a `save_attachment_as_asset` tool that promotes an
   attachment from the current turn into the project asset library (name,
   description, optional designId markers), plus `import_asset_from_url`
   for remote images the user pastes. Keep the MCP registry in sync (both
   toolsets, per convention).
3. **Model recommendation (S)** — no recommendation engine exists; users
   choose among 13 models from descriptions. Add declarative
   `recommendedFor: string[]` tags on `ModelDefinition` (e.g.
   "character-consistency", "cheap-draft", "photorealism", "first-frame
   animation") surfaced as badges + a "recommended" sort in `AddNodeMenu`,
   in `list_models`, and in the `models` docs topic. Declarative data on the
   registry keeps it test-covered and MCP-visible for free.

### 4.8 Catalogue & smaller product items

| Proposal                                                                           | Effort  | Why                                                                                                                        |
| ---------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Grow the model catalogue (Veo, Kling variants, Flux…)                              | S/model | The registry makes adding nearly declarative: one file + one entry in `MODELS`, invariant tests come for free              |
| Move the remaining hardcoded strings of `NodeParamsPanel` + `ModelNode` to i18next | S       | Node action tooltips, "No output yet", Replace-model dialog are hardcoded English — the canvas is only partially localized |
| More i18n locales (es, de, ja) through community contributions                     | S       | The i18n infra + parity test makes contributing a locale trivial and safe                                                  |
| Verify the per-model credit rates against the kie.ai dashboard                     | S       | `estimateCredits` ships with indicative rates flagged in each model file — align them with real billing                    |

### 4.9 Cleanups (fold into whichever item touches the file first)

- Remove the stale `TODO(phase-3)` comments in `WorkflowEditor.tsx` — the
  engine is wired (`generationRuntime.ts` invokes `generations:run`,
  `generationEngineReady = true`); the comments now actively mislead readers.
- Undo/redo stacks (`graphHistory.ts`, in-memory, cap 100) and retry budgets
  reset silently on restart — acceptable, but document it in the UI (tooltip
  on the undo button) or persist if it ever bites.

## 5. Ecosystem & differentiation

| Proposal                                                                                                                             | Effort | Why                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Position the MCP server as the product's public API**: dedicated docs, client examples (Claude Code, scripts), registry versioning | M      | This is the differentiator: Raccord drivable by any agent. The registry exists, the showcase is missing                 |
| Community "model packs" (dynamically loaded model definitions, with a validation sandbox)                                            | L      | Turns the registry into a community extension point — kie.ai's model release pace exceeds what one maintainer can track |
| "Headless" mode: the Hono server + generation engine without a window, drivable via MCP/HTTP                                         | L      | Opens batch/server use cases (personal render farm) reusing `src/main/services/` as-is                                  |
| Docs site (VitePress) generated from `docs/` + model docs generated from the registry                                                | M      | The model docs already exist in-band for LLMs (`mcp/docs.ts`) — publish them for humans too                             |

Note: with §4.3 shipped, the "agent-drivable render pipeline" pitch is
complete end-to-end — the MCP `render_video` tool already closes the loop
(brief → graph → generations → MP4 file) for any MCP client; headless mode
would remove the last constraint (a running window).

## Suggested order

1. **Feedback layer** (§4.4) — mostly wiring existing engine state to the
   UI; lowest effort-to-trust ratio on the list. Also absorbs the render
   error/skipped `alert()`s left interim by §4.3.
2. **Video-level settings + style-at-payload** (§4.5) — removes the two main
   sources of sequence incoherence, and unlocks the §4.3 follow-up (export
   presets per destination).
3. **Graph ergonomics** (§4.6) then **assistant-first** (§4.7) — the
   long-term differentiation.
4. **OSS hygiene items** (§1) remain the blockers for a good first
   impression at publication; the **versioned E2E suite** (§2) should land
   before contributors arrive — the §4.3 render E2E driver (session
   scratchpad) is ready to be promoted into it.
