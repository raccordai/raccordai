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
| Move the remaining hardcoded strings of `NodeParamsPanel` + `ModelNode` to i18next | S       | Node action tooltips, "No output yet", the promote-asset form are hardcoded English — the canvas is only partially localized                                                                                             |
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

## Suggested order

1. **Finish §1** — what is left is four GitHub-side actions a maintainer takes
   in a minute, plus the README visuals.
2. **Ecosystem** (§5) — the unified tool registry shipped with the assistant
   sidebar doubles as MCP-surface hardening for the "public API" pitch.
3. **Ambient layer** (§6.7) — now unblocked: the loop produces the signals it
   needs (selections, annotations, QC verdicts).

Growing the E2E suite is not a step of its own any more: a flow worth
protecting gets its spec in `e2e/` as part of the work that introduces it.
