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

| Proposal                                                              | Effort | Why                                                                                                                                                      |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public README: screenshots, demo GIF, quickstart                      | S      | It is the project's landing page                                                                                                                         |
| `CODE_OF_CONDUCT.md` + issue templates (bug / feature / kie.ai model) | S      | Frames the discussions and structures bug reports (version, OS, channel)                                                                                 |
| Security policy (`SECURITY.md`)                                       | S      | Private vulnerability reporting channel — the app handles API keys                                                                                       |
| Enable secret scanning + push protection on the GitHub repo           | S      | Repo setting, not a file — flip it right after the first push (documented in CONTRIBUTING.md)                                                            |
| Confirm mac notarization covers the asarUnpack'd ffmpeg/ffprobe       | S      | One-time check on the next publish run — electron-builder signs `app.asar.unpacked` by default, but only the signed pipeline (repo secrets) can prove it |

## 2. Quality & CI chain

| Proposal                                                                                                                                                 | Effort | Why                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formalized E2E: promote the Playwright drivers + kie/Anthropic mocks from the session scratchpads into a versioned `e2e/` suite, with a dedicated CI job | L      | This is the layer that covers runEngine/chat/IPC/render, deliberately outside the unit scope. The harness exists (RACCORD_KIE_BASE / RACCORD_ANTHROPIC_BASE), it just isn't versioned. Ready to promote: the MP4-render driver (heterogeneous clips + Suno music + cancellation, MCP-driven to bypass the save dialog; suno mock endpoints documented in the verify skill) |

## 3. Technical robustness

| Proposal                                                  | Effort | Why                                                      |
| --------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Opt-in crash telemetry (Sentry or self-hosted equivalent) | M      | Without crash reports, open-source support will be blind |

## 4. Product — smaller items

Shared constraints: renderer→main goes through a zod contract in
`src/shared/ipc/contracts.ts` + handler in `src/main/ipc/index.ts`; business
logic in `src/main/services/`; SQLite migrations are **additive only**; every
user-visible string gets an i18next key in fr **and** en; graph mutations go
through the graph service (`withGraphHistory`); colors through the
`styles.css` tokens.

| Proposal                                                                           | Effort  | Why                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Grow the model catalogue (Veo, Kling variants, Flux…)                              | S/model | The registry makes adding nearly declarative: one file + one entry in `MODELS`, invariant tests come for free                |
| Move the remaining hardcoded strings of `NodeParamsPanel` + `ModelNode` to i18next | S       | Node action tooltips, "No output yet", the promote-asset form are hardcoded English — the canvas is only partially localized |
| More i18n locales (es, de, ja) through community contributions                     | S       | The i18n infra + parity test makes contributing a locale trivial and safe                                                    |
| Verify the per-model credit rates against the kie.ai dashboard                     | S       | `estimateCredits` ships with indicative rates flagged in each model file — align them with real billing                      |
| Per-project soft budget (`creditWarnThreshold`) in the cost modal                  | S       | Warn when `projectCreditsUsage + planned` exceeds a per-project threshold                                                    |
| Move `autoLayout.ts` (pure) to `src/shared/` and expose a `tidy_workflow` tool     | S       | Optional leftover from the tool-registry unification — the assistant/MCP can't tidy the canvas yet                           |
| Click-to-focus affordance on node ids in assistant replies                         | S       | Optional transcript polish left out of the sidebar work — `focus_node`/`event:focusNode` already exist                       |

Cleanup (fold into whichever item touches the file first): undo/redo stacks
(`graphHistory.ts`, in-memory, cap 100) and retry budgets reset silently on
restart — acceptable, but document it in the UI (tooltip on the undo button)
or persist if it ever bites.

## 5. Ecosystem & differentiation

| Proposal                                                                                                                             | Effort | Why                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Position the MCP server as the product's public API**: dedicated docs, client examples (Claude Code, scripts), registry versioning | M      | This is the differentiator: Raccord drivable by any agent. The registry exists, the showcase is missing                 |
| Community "model packs" (dynamically loaded model definitions, with a validation sandbox)                                            | L      | Turns the registry into a community extension point — kie.ai's model release pace exceeds what one maintainer can track |
| "Headless" mode: the Hono server + generation engine without a window, drivable via MCP/HTTP                                         | L      | Opens batch/server use cases (personal render farm) reusing `src/main/services/` as-is                                  |
| Docs site (VitePress) generated from `docs/` + model docs generated from the registry                                                | M      | The model docs already exist in-band for LLMs (`mcp/docs.ts`) — publish them for humans too                             |

Note: the "agent-drivable render pipeline" pitch is complete end-to-end — the
MCP `render_video` tool closes the loop (brief → graph → generations → MP4
file) for any MCP client; headless mode would remove the last constraint (a
running window).

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

1. **OSS hygiene** (§1) — the blockers for a good first impression at
   publication.
2. **Versioned E2E suite** (§2) — should land before contributors arrive;
   the MP4-render driver is ready to be promoted.
3. **Ecosystem** (§5) — the unified tool registry shipped with the assistant
   sidebar doubles as MCP-surface hardening for the "public API" pitch.
4. **Ambient layer** (§6.7) — now unblocked: the loop produces the signals it
   needs (selections, annotations, QC verdicts).
