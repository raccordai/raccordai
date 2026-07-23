# Evolution proposals

Working document — nothing below is committed to. Indicative effort:
S (< 1 day), M (a few days), L (a week+).

North star: **be the most intuitive tool to create AI videos through
workflows**. The July 2026 audit (renderer UX, workflow building blocks,
generation lifecycle) found the capabilities largely in place — templates,
design recipes, storyboard pre-viz, a full-project assistant, dependency-aware
runs, undo/redo, gapless timeline, rendered MP4 export — and the remaining
friction concentrated in two moments of the user journey. Both are now
addressed (see "Shipped"): **the first fifteen minutes** by the first-run
onboarding + template slot form, and **trust while generating** by the
generation feedback layer (queue/retry visibility, cost preview, OS
notifications, toasts/modals instead of native `alert()`s).

The assistant currently exists to paper over manual-editor friction. The
long-term differentiator is to invert that: make the conversational path the
primary one (§4.7) on top of a manual editor that no longer needs papering
over (§4.6).

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
- **Generation feedback layer** (§4.4, July 2026): renderer-wide toast stack +
  styled confirm modal (`components/feedback/Feedback.tsx`, mounted in
  `__root.tsx`) — zero native `alert()`/`confirm()` left in the renderer, all
  replaced call sites i18n'd (fr+en). Queue & retry visibility: `GenerationQueue`
  snapshot (running/queued ids) + `onChange` broadcast, `generations:queueState`
  channel + `event:queueChanged`, nodes show "Queued (#N)" / "Generating…" /
  "Retry K/3" (badge, border and preview states). Completion notifications:
  `services/notifications.ts` (Electron `Notification` on `generationSettled`
  when unfocused, localized from the shared i18n resources; click focuses the
  window and centers the node via `event:focusNode`; batch summary "N succeeded,
  M failed" through `notifications:batchSummary`), `notifyOnCompletion` setting
  (default on, toggle in Settings → General). Cost preview: multi-node runs
  compute the planned node set, show a per-node estimate breakdown + total vs
  the live kie.ai balance before spending, with "don't ask under X credits"
  remembered; failed generations get an explicit **Retry** button. The stale
  `TODO(phase-3)` comments went with it (§4.9).
- **Video-level settings & style propagation** (§4.5, July 2026): additive
  `videos.default_aspect_ratio`/`default_resolution` columns, edited from the
  Style menu; new nodes pre-fill matching params (per-model enum check via the
  shared `videoDefaultParams`), and an explicit **"Apply to N existing nodes"**
  runs one journaled `nodes:applyVideoDefaults` sweep — undoable in a single
  step, no silent behavior change. Style-at-payload: the `applyVideoStyle`
  params marker (default on plainly-created/template/design visual nodes;
  absent on pre-existing nodes = full back-compat, old prompts run
  byte-identical) makes `prepareRun` append the video's CURRENT style bible to
  the prompt before the input snapshot is persisted (deterministic retries) —
  templates and design recipes no longer bake the bible into prompts, both
  chat SYSTEM prompts and the docs topics teach the flag instead of verbatim
  copying, and the params panel shows the suffix as a read-only collapsed
  "Style: … — applied at run" section. Follow-up shipped with it: **MP4
  export presets per destination** (16:9 / 9:16 / 1:1 fixed dims through the
  render pipeline's existing resolution override, File menu). Verified
  end-to-end against the kie mock (pre-fill, payload = business prompt +
  bible with the marker stripped, clean stored prompt, one-step undo of the
  bulk apply).

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

| Proposal                                                                           | Effort  | Why                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Grow the model catalogue (Veo, Kling variants, Flux…)                              | S/model | The registry makes adding nearly declarative: one file + one entry in `MODELS`, invariant tests come for free                            |
| Move the remaining hardcoded strings of `NodeParamsPanel` + `ModelNode` to i18next | S       | Node action tooltips, "No output yet", the promote-asset form are hardcoded English — the canvas is only partially localized             |
| More i18n locales (es, de, ja) through community contributions                     | S       | The i18n infra + parity test makes contributing a locale trivial and safe                                                                |
| Verify the per-model credit rates against the kie.ai dashboard                     | S       | `estimateCredits` ships with indicative rates flagged in each model file — align them with real billing                                  |
| Per-project soft budget (`creditWarnThreshold`) in the §4.4 cost modal             | S       | Left out of the shipped feedback layer (optional in the spec): warn when `projectCreditsUsage + planned` exceeds a per-project threshold |

### 4.9 Cleanups (fold into whichever item touches the file first)

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

1. **Graph ergonomics** (§4.6) then **assistant-first** (§4.7) — the
   long-term differentiation.
2. **OSS hygiene items** (§1) remain the blockers for a good first
   impression at publication; the **versioned E2E suite** (§2) should land
   before contributors arrive — the §4.3 render E2E driver (session
   scratchpad) is ready to be promoted into it.
