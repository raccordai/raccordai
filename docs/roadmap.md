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
asset-import autonomy, model recommendations). See "Shipped". The next step on
that axis is the **assistant sidebar** (§4.10): a full-height, context-aware
assistant shell on every route, backed by a unified tool registry so the
assistant can do everything the interface can.

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

### 4.10 Assistant sidebar — the assistant-first shell (phased, M/L total)

**Goal.** Push §4.7 to its conclusion: a full-height assistant sidebar,
available on every route, aware of what the user is looking at, and able to
do everything the interface can do (with guardrails on destructive and
spending actions). Three distinct requirements, deliberately phased because
they carry different costs and risks:

1. **Spatial ubiquity** — a persistent panel on every route (pure UI).
2. **Context awareness** — the assistant knows the current route / project /
   video / selected node without being told (the product differentiator).
3. **Capability parity** — everything the UI can do, the assistant can do
   (an architecture job — tool-registry unification — more than a feature
   list).

**State of the code this spec is grounded on (July 2026):**

- The chat is mounted in exactly two places: a home overlay
  (`routes/index.tsx`, session `HOME_CHAT_ID`, table `chat_home_session`)
  and a floating island on the editor canvas (`WorkflowEditor.tsx`, one
  session per `videoId`, table `chat_sessions` — FK to `videos`). Project /
  assets / settings pages have no assistant at all. `ChatPanel` itself is
  already context-agnostic (takes `videoId`/`projectId` props) — moving it
  is cheap.
- **Three tool surfaces are kept in sync by hand**: `TOOLS` (video chat),
  `TOOLS_HOME` (derived via `withVideoIdParam`/`withProjectIdParam`) in
  `chat.ts`, and `AGENT_TOOLS` in `mcp/registry.ts`. They have already
  diverged: the chat cannot select a generation ("Use this"), cancel or
  refresh one, undo/redo, estimate a cost, read the kie balance, render an
  MP4, list assets (it can only search), import a local file, or edit asset
  metadata — the MCP has most of those; neither side can rename/delete
  projects or videos, edit video defaults, or run the defaults sweep.
- **The smart run lives on the wrong side.** The dependency-aware
  orchestration (`WorkflowEditor.runNodes`: upstream walk, memoised shared
  deps, parallel branches, reuse of satisfied nodes, cost preview, batch
  summary) is renderer code. It is the single most valuable capability of
  the app and is unreachable from the assistant AND from MCP — and it is a
  de-facto violation of the "business logic in `src/main/services/`" rule.
- `chat:send` carries `{videoId, projectId, text, images}` and nothing
  else: the assistant has zero knowledge of what the user is looking at.
- `stream: false` everywhere; `MAX_ITERATIONS = 15`; history grows without
  bound (no compaction — already latent in per-video sessions, acute once a
  global thread exists); a `busy` session rejects sends instead of queueing.

**Architecture decisions (recorded up front so phases don't relitigate):**

- **Sidebar placement**: right-hand column of `RootLayout` (`__root.tsx`),
  sibling of `<main>`, full height under the header — an app-level shell
  element, NOT an editor island. The editor keeps its params/history islands
  inside the (narrowed) canvas; merging them into the sidebar is explicitly
  out of scope. Known pitfalls to respect: the header toggle must be covered
  by the titlebar no-drag rule (`a, button…` already are); if the sidebar
  ever gets a backdrop-filter and hosts `<video>` previews, the
  `.island video { z-index: 1 }` workaround applies.
- **Session model**: hybrid. The existing `HOME_CHAT_ID` session **becomes
  the global thread** (it is already project-agnostic, persists in its own
  table, and its toolset takes explicit ids — no schema change, no
  migration). The sidebar defaults to it; a conversation switcher exposes
  the existing per-video threads (`chat_sessions`) for reading/resuming.
  Rationale: continuity by default ("open video 2 and apply the same
  style"), bounded blast radius, zero data migration.
- **Phase order**: parity (3) and smart-run (4) land BEFORE the session
  switch (5) — give the assistant full capabilities inside the current
  session model first, then change the session model; two risks that must
  not be stacked.

**Phase 1 — Global sidebar shell (S/M).**

- New `src/renderer/src/features/assistant/AssistantSidebar.tsx` wrapping
  the existing `ChatPanel`; mounted in `__root.tsx` as a flex sibling of
  `<main>` (below the header, right side). Resizable via a drag handle
  (min ~320px, max ~560px); `open` + `width` persisted in localStorage
  (`raccord.assistant.open` / `raccord.assistant.width`).
- Session selection (temporary, until phase 5): derived from the route via
  `useRouterState` — on `/projects/$projectId/videos/$videoId` use that
  video's session; everywhere else `HOME_CHAT_ID` with `projectId: ''`.
- Toggle: permanent header button (replaces the editor's
  `useHeaderActions` assistant button) + a global shortcut (⌘J / Ctrl+J)
  registered at root. The editor's left chat island and the home overlay are
  removed; both entry points route to the sidebar.
- The editor's `askAssistant(prefill)` path ("Fix with the assistant"
  buttons) must reach the sidebar across the component tree: introduce a
  tiny module-level store (useSyncExternalStore — the repo has no state
  library and doesn't need one) with `openAssistant(prefill?)`.
- `scripts/assistant-e2e.mjs` drives the home overlay by its button — update
  its selectors to the header toggle in the same commit.
- i18n: toggle title, collapse/expand, switcher labels (fr + en).

**Phase 2 — Per-turn app context + assistant→UI navigation (M).**

- Contract: `chat:send` input gains an optional
  `context: { route, projectId?, videoId?, selectedNodeId?, selectedGenerationId?, lastError? }`
  (all-optional zod object). The sidebar fills it from the route and from a
  lightweight `AppContextStore` module that `WorkflowEditor` updates
  (selected node id; last surfaced generation error). Keep the store's
  surface minimal — no event firehose, one snapshot per send.
- `chat.ts` prepends an `<app-context>…</app-context>` block to the user
  message content (mirroring the `<system-reminder>` wake-up precedent).
  It is persisted as-sent in the Anthropic history (deterministic replays;
  it was true at that turn) but the transcript item shows only the user's
  text. Extract a pure `formatAppContext(ctx)` helper with unit tests.
- Both SYSTEM prompts document the block ("the current selection is where
  the user is looking — 'this node' means `selectedNodeId`").
- Assistant→UI: new registry-bound tools `focus_node` (broadcasts the
  existing `event:focusNode`; the editor already centers on it) and
  `open_video` (new `event:navigate` push handled at root by the router).
  Node ids/keys in assistant replies get a click-to-focus affordance in the
  transcript (S, optional polish).
- Assistant E2E: extend the scripted mock to assert the `<app-context>`
  block reaches the provider request body.

**Phase 3 — Unified tool registry with a risk taxonomy (M/L).**

- Extend `AgentTool` (`mcp/registry.ts`) with `scope: 'global' | 'project'
| 'video'` and `risk: 'read' | 'write' | 'destructive' | 'spending'`
  (superset of `mutates`). One registry, two adapters:
  - MCP adapter: unchanged (explicit ids, as today).
  - Chat adapter `toAnthropicTools(tools, binding)`: for a video-bound
    session, video/project-scoped tools drop the explicit id params and the
    executor injects them; for the global thread they stay required —
    generalizing today's `withVideoIdParam`/`withProjectIdParam` into the
    registry layer. `chat.ts#executeTool` becomes a thin wrapper around
    `executeAgentTool` plus a small CHAT_ONLY set for tools that need the
    session itself (`present_plan`, `save_attachment_as_asset`) — those two
    stay chat-only by design (MCP has no transcript/attachments).
- Fill the parity gaps as registry entries (each: contract-typed service
  call, 1–2-line description, scope+risk):
  `select_generation`, `cancel_generation`, `refresh_generation_status`,
  `rename_project`/`delete_project`, `rename_video`/`delete_video`,
  `set_video_defaults` + `apply_video_defaults`, `delete_asset`; the chat
  side inherits the MCP-only tools for free (`undo`, `redo`,
  `estimate_cost`, `get_credits`, `render_video`, `list_assets`,
  `update_asset`, `set_asset_tags`, `add_asset_from_file`). Optional S:
  move `autoLayout.ts` (pure) to `src/shared/` and expose `tidy_workflow`.
- **Destructive approval protocol** (chat only; MCP clients remain the
  human's own agent, consistent with today's `remove_node`): a
  `risk: 'destructive'` tool called WITHOUT `confirm: true` does not
  execute — it returns an approval-required result and the chat renders an
  **action card** (generalization of the §4.7 plan card: same
  approve/adjust buttons posting back as user messages, new
  `chatItemSchema` variant `{type: 'action', …}`). On approval the model
  re-calls with `confirm: true`. Deterministic, prompt-independent,
  test-enforceable.
- Settings (API keys, update channel, concurrency) and backup/restore are
  **explicitly out of the registry** — an LLM loop must not be able to
  touch keys or relaunch the app.
- Tests: registry invariant test (every tool declares scope+risk, short
  description); adapter tests (id injection/requirement per binding);
  destructive-without-confirm returns the approval shape and mutates
  nothing. `pnpm test:assistant` after every step (per CLAUDE.md).
  Update `docs/mcp.md`.

**Phase 4 — Smart run as a main service + batch tool (M/L).**

- Split renderer's `runNodes` into:
  - `src/main/services/runPlanner.ts` (**pure**, in `coverage.include`):
    dependency walk from target ids, per-node reuse decision (dependencies
    always reuse; targets reuse only in batch mode), planned-node set,
    per-node credit estimates + total. Unit tests: topo order, shared deps
    planned once, reuse rules, parity with the §4.4 cost-modal maths.
  - batch orchestration (in `runEngine.ts` or a sibling `runBatch.ts`, E2E
    scope like the engine): parallel independent branches via memoised
    per-node promises, settle-aware sequencing on `generationSettled`
    (replacing the renderer's 2s polling), one batch summary notification.
- IPC: `generations:planRun` `{videoId, targetNodeIds, reuseTargets}` →
  planned rows + estimates (the renderer cost modal consumes it —
  ~100 lines of renderer orchestration deleted); `generations:runBatch`
  same input → per-node generation ids. The §4.4 cost gate stays a
  renderer-side modal fed by `planRun`.
- Registry: `run_batch` (`risk: 'spending'`), input `targetNodeIds` or
  `all_videos: true`. Chat flow: `present_plan` → approval → `run_batch`;
  every returned generation id enters `session.watched` so the existing
  wake-up drains the whole batch. MCP gets true "generate everything" for
  free — a big step toward the §5 headless pitch.
- Raise `MAX_ITERATIONS` (15 → ~24): batching lowers tool-call counts, but
  full-project deliveries chain more turns; the wake-up remains the
  completion path (never poll).
- E2E (kie mock): batch of 3 chained shots + shared upstream — assert the
  shared dependency generates once and the batch summary fires.

**Phase 5 — Global thread by default + compaction (M).**

- Sidebar defaults to the `HOME_CHAT_ID` thread on every route (the
  phase-2 context block tells the model which video is current; its
  explicit-id toolset already works everywhere). Conversation switcher:
  global thread + per-video threads (from `chat_sessions`), read/resume.
  Per-video threads stop being auto-created; existing ones remain.
- **Compaction** (`src/main/services/chatCompaction.ts`, pure split/reassembly
  helpers in `coverage.include`): when the serialized history exceeds a
  threshold (~60 messages or ~300 KB), summarize the oldest two-thirds into
  one `<conversation-summary>` block (one model call through the same
  provider path — mockable via `RACCORD_ANTHROPIC_BASE`), keep the last
  third verbatim, and strip base64 image blocks from the summarized span
  (replaced by a note naming the asset key when the attachment was promoted
  via `save_attachment_as_asset` — one more reason that tool exists).
- `chat:send` while `busy` enqueues instead of throwing (drained like the
  settle notes are today) — collisions get frequent once the thread is
  global.
- E2E: scripted two-turn conversation across a navigation (home → editor)
  on the global thread; compaction unit tests on synthetic histories.

**Phase 6 — Streaming (M, fully separable).**

- `stream: true` + SSE parsing on the kie Claude proxy path, incremental
  `event:chatUpdate` deltas (extend `chatStateSchema` with a partial-text
  field), and a streaming variant of the `chatOpenAIFormat.ts` translator
  for the Responses proxies. Pure comfort for a permanently-visible
  sidebar; no other phase depends on it, and the Responses translator makes
  it the riskiest — keep it last.

| Phase | Content                                        | Effort | Value                                   |
| ----- | ---------------------------------------------- | ------ | --------------------------------------- |
| 1     | Global sidebar shell                           | S/M    | Ubiquity immediately                    |
| 2     | Per-turn context + focus/navigate tools        | M      | The differentiator, cheaply             |
| 3     | Unified registry + risk taxonomy + parity gaps | M/L    | Parity; ends triple toolset maintenance |
| 4     | Smart run in main + `run_batch`                | M/L    | Conversational "generate everything"    |
| 5     | Global thread + compaction + send queueing     | M      | Continuity                              |
| 6     | Streaming SSE                                  | M      | Comfort; separable                      |

**Risks to watch across phases:** token growth of a global thread
(mitigated by phase-5 compaction and image stripping — do NOT ship phase 5
without it); double sources of truth while phases 3–4 are in flight (the
renderer keeps its own run orchestration until phase 4 lands — delete it in
the same commit); user confusion between the global thread and legacy
per-video transcripts (the switcher must label them clearly); destructive
tools before phase 3's approval protocol exists (do not add them earlier).

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

1. **Assistant sidebar** (§4.10), phases 1→4 in order — shell, context,
   unified registry, smart-run service. Phases 5–6 (global thread,
   streaming) can trail behind without blocking anything.
2. **OSS hygiene items** (§1) remain the blockers for a good first
   impression at publication; the **versioned E2E suite** (§2) should land
   before contributors arrive — the §4.3 render E2E driver (session
   scratchpad) is ready to be promoted into it. The §4.10 phase-3 registry
   work doubles as MCP-surface hardening for §5's "public API" pitch.
