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

The long-term differentiation — a manual editor that no longer needs papering
over, and the conversational path as the primary one — has since shipped too:
**graph ergonomics** (reference numbering, anchor/reference legibility, canvas
affordances, A/B compare) and **assistant-first flows** (plan approval cards,
asset-import autonomy, model recommendations). See "Shipped".

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
- **Graph ergonomics** (§4.6, July 2026):
  - _Visible, reorderable reference numbering_: the computed `@ImageN` alias
    is rendered on the canvas edges themselves (badge label, same
    `incomingConnectionsFor` ordering as the chips and the run engine), and
    the params panel reorders a multi-reference input's connections with
    up/down arrows through the new journaled `edges:reorder` channel
    (permutation-validated, timestamps redistributed strictly increasing so
    ties can never make numbering ambiguous; `graphHistory` now diff-restores
    changed edge rows so the reorder undoes cleanly).
  - _Anchor/reference made legible_: the native `confirm()` guard became a
    styled two-column modal (anchor "appears ON SCREEN" vs reference "guides
    only") with a one-click **"wire as reference instead"** CTA when the
    target model has a reference input; `frameAnchor: true` handles are
    permanently distinguished (warning-token connector + anchor icon +
    explanatory tooltip), so the distinction is learned, not just policed.
  - _Canvas affordances_: pane right-click opens the add-node catalogue at
    the cursor (the toolbar's combobox was split into a shared
    `AddNodePanel` + `useNodeCreation` hook, nodes spawn at the click
    point); node right-click offers Run / Duplicate / Replace model /
    Delete; image/video/audio files dropped on the canvas are imported
    (`assets:importFromPaths` + preload `getPathForFile`) and appear as
    `studio/asset` nodes at the drop position; Cmd/Ctrl+C/V copies the
    selected nodes (and the edges between them, in creation order) as a
    workflow-JSON v1 fragment pasted through the `importWorkflow` validator
    with fresh keys and an offset — repeat pastes and cross-video paste
    within a project both work.
  - _A/B generation compare_: pick two generations of a node (⫼ toggle on
    the cards) → side-by-side modal with synced play/pause/scrub for videos
    and synced zoom/pan for images, "Use this" (`generations:select`) on
    each side.
- **Assistant-first flows** (§4.7, July 2026):
  - _Brief → plan → execute_: new `present_plan` tool — structured JSON
    (`shots: [{label, description, modelId, estCredits, panels?}], style,
totalCredits`) rendered by the ChatPanel as a persisted approval card
    (per-shot model + cost, grand total) with **Approve** / **Request
    changes** buttons posting back as user messages (only the transcript
    tail is actionable). Both SYSTEM prompts mandate a plan before any
    multi-shot `import_workflow` and before costly run batches — the
    conversational sibling of the storyboard gate. Plan cards persist via
    the extended `chatItemSchema` (`type: 'plan'`).
  - _Asset import autonomy_: `save_attachment_as_asset` promotes a chat
    image attachment into the project library (new
    `assets.importAssetFromBytes`, optional designId/designSubject markers
    validated against the recipe registry) and `import_asset_from_url`
    mirrors the MCP `add_asset_from_url` — the assistant no longer has to
    ask the user to use the Assets tab; both SYSTEM prompts teach the new
    path, and both tools take an explicit `projectId` in the home toolset.
  - _Model recommendation_: declarative `recommendedFor: string[]` tags on
    every `ModelDefinition` (registry test enforces ≥1 kebab-case tag),
    surfaced as badges + a recommended sort in `AddNodeMenu` (tag-matching
    entries rank first, tags are searchable), in the assistant's
    `list_models`, and in the MCP `models`/`model:<id>` docs topics.

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

1. **OSS hygiene items** (§1) remain the blockers for a good first
   impression at publication; the **versioned E2E suite** (§2) should land
   before contributors arrive — the §4.3 render E2E driver (session
   scratchpad) is ready to be promoted into it.
