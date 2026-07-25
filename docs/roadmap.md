# Evolution proposals

Working document — nothing below is committed to. Indicative effort:
S (< 1 day), M (a few days), L (a week+).

North star: **be the most intuitive tool to create AI videos through
workflows**. Everything shipped through July 2026 — onboarding + template
slots, rendered MP4 export, generation feedback layer, video-level defaults +
style-at-payload, graph ergonomics, assistant-first flows, and the full
assistant sidebar (global shell, per-turn app context, unified tool registry
with risk taxonomy, smart batch runs in main, global thread + compaction,
SSE streaming, @-mentions) — is recorded in git history and CLAUDE.md; only
open work remains below.

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

### 6.1 Draft mode — draft → final pipeline (M)

Make exploring 5–10× cheaper by treating generations as drafts until the
user finalizes.

- `draftEquivalent?: { modelId, params? }` on `ModelDefinition` (seedance-2 →
  seedance-2-fast, nano-banana-pro → nano-banana-2-lite, resolution floored);
  registry test enforces the id exists in `MODELS` and the params pass the
  target model's schema.
- Video-level toggle (additive `videos.draft_mode` column, Style menu +
  toolbar badge). Substitution happens in `prepareRun` — same mechanic as
  style-at-payload: stored prompts/params stay untouched, the input snapshot
  records the substituted model (deterministic retries), and the generation
  row is stamped `draft` (additive column) so cards/timeline badge it.
- **Finalize**: `runPlanner` plans every node whose selected generation is a
  draft → cost preview (draft vs final estimate side by side) → re-run on
  the real models via `runBatch`. Registry tools: `set_draft_mode`,
  `finalize_video` (`risk: 'spending'`); both SYSTEM prompts teach
  "explore in draft, finalize once approved".

### 6.2 Vision QC on settle — the generation "linter" (M)

The run engine knows a generation _succeeded_, never whether it is _good_ —
QC is 100 % human today. Give the assistant eyes.

- Opt-in per video (additive `videos.qc_enabled`). On a successful
  `generationSettled`, run one cheap vision check through the existing kie
  client: does the output match the prompt? is the character consistent with
  the wired design-sheet references? does a storyboard have 9 legible panels
  and no grid bleed-through?
- Verdict stored additively (`generations.qc_verdict/qc_notes`), rendered as
  a badge on generation cards (✓ / ⚠ + issues) with a "Fix with assistant"
  prefill carrying the notes.
- Registry tool `review_generation` (chat **and** MCP); batch summaries list
  non-conforming shots; the wake-up note includes the verdict — enabling
  "generate the whole film and only wake me for what's wrong". Synergy with
  6.1: QC the drafts, finalize only what passes.

### 6.3 Regional feedback — the "select + fix" gesture (M/L)

Today a bad generation can only be regenerated or re-prompted by hand; the
user's judgment ("the hand is wrong", "remove that logo") stays in their
head. Transpose Cursor's select + Cmd+K:

- Image generations: draw a region on the preview + a comment → builds a
  pre-wired `gpt-image-2-image-to-image` edit node from that generation
  (prompt composed from comment + region), or prefills the assistant with
  both. Video generations: timecode markers + comment feeding the
  regeneration prompt.
- Annotations persist additively (`generation_annotations` table) — they are
  the raw signal for the taste memory (6.7).

### 6.4 Named checkpoints + project diff (M)

The safety net that authorizes boldness (Cursor's Composer checkpoints).
`graphHistory` already computes per-mutation before/after — half the work.

- Persisted named snapshots per video (additive `video_checkpoints` table:
  workflow-JSON v1 export + selected generation ids). Restore validates
  through the `importWorkflow` path, is journaled as ONE undo step, and
  never resurrects deleted generations (consistent with undo).
- Diff view checkpoint ↔ current: nodes added/removed, prompts changed,
  selections changed — pure helper in `src/shared/`, unit-tested.
- Registry tools: `create_checkpoint`, `diff_checkpoint`,
  `restore_checkpoint` (`risk: 'destructive'` → approval card).

### 6.5 Prompt lint (S/M)

The prompting knowledge already exists (`seedance2-prompting.ts`,
`docs/models.md` invariants) — it only speaks _after_ a bad run. Make it
speak before:

- Pure `lintPrompt(model, params, prompt, connections)` in `src/shared/`
  (unit-tested): reference wired but no `@ImageN` role declared in the
  prompt; video prompt describing visuals instead of motion; storyboard
  wired on a frame anchor; storyboard-driven shot missing the anti-grid
  guard; params outside the model's enums.
- Surfaced as warnings + one-click fixes in the params panel and in the run
  confirm; exposed to the assistant/MCP as `lint_node` and folded into 6.2's
  QC report.

### 6.6 Variants ×N (S)

Parallel exploration is the norm in creative work; today it is N clicks and
a manual compare. "Generate 3 variants" on a node → N queue slots, grid
compare (extension of the shipped A/B modal) with one-click promote
(`generations:select`). `run_node`/`run_batch` gain `variants?: number`
(small cap; the cost preview multiplies accordingly).

### 6.7 Later — ambient layer (L, after 6.1–6.3 are live)

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

1. **Iteration loop** (§6): 6.1 draft mode then 6.2 vision QC — together
   they change the economics and make `run_batch` genuinely autonomous;
   6.6 variants is a cheap follow-up, 6.3/6.4/6.5 as they come.
2. **OSS hygiene** (§1) — the blockers for a good first impression at
   publication.
3. **Versioned E2E suite** (§2) — should land before contributors arrive;
   the MP4-render driver is ready to be promoted.
4. **Ecosystem** (§5) — the unified tool registry shipped with the assistant
   sidebar doubles as MCP-surface hardening for the "public API" pitch.
5. **Ambient layer** (§6.7) — only once the loop produces the signals it
   needs.
