# Evolution proposals

Working document — nothing below is committed to. Indicative effort:
S (< 1 day), M (a few days), L (a week+).

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
- **Auto-update via electron-updater** (`src/main/services/updater.ts`): the
  packaged channel setting (stable|beta, Settings → Updates) drives both the
  update feed and the flag defaults (`getReleaseChannel`). Remaining work: the
  publish endpoint in `electron-builder.yml` is a placeholder
  (`https://updates.raccord.ai`) — point it at real hosting (or the GitHub
  provider) when releases ship.

## 1. Open-source hygiene — before publishing

| Proposal                                                              | Effort | Why                                                                                           |
| --------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Public README: screenshots, demo GIF, quickstart                      | S      | It is the project's landing page                                                              |
| `CODE_OF_CONDUCT.md` + issue templates (bug / feature / kie.ai model) | S      | Frames the discussions and structures bug reports (version, OS, channel)                      |
| Security policy (`SECURITY.md`)                                       | S      | Private vulnerability reporting channel — the app handles API keys                            |
| Enable secret scanning + push protection on the GitHub repo           | S      | Repo setting, not a file — flip it right after the first push (documented in CONTRIBUTING.md) |

The "audit personal strings/paths in git history" item is resolved by
construction: the repo publishes with a fresh history (no pre-publication
commits), and the working tree was swept before the first push.

## 2. Quality & CI chain

| Proposal                                                                                                                                                 | Effort | Why                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formalized E2E: promote the Playwright drivers + kie/Anthropic mocks from the session scratchpads into a versioned `e2e/` suite, with a dedicated CI job | L      | This is the layer that covers runEngine/chat/IPC, deliberately outside the unit scope. The harness exists (RACCORD_KIE_BASE / RACCORD_ANTHROPIC_BASE), it just isn't versioned |

## 3. Technical robustness

| Proposal                                                  | Effort | Why                                                      |
| --------------------------------------------------------- | ------ | -------------------------------------------------------- |
| Opt-in crash telemetry (Sentry or self-hosted equivalent) | M      | Without crash reports, open-source support will be blind |

## 4. Product

| Proposal                                                                                       | Effort  | Why                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| Grow the model catalogue (Veo, Kling, Flux…)                                                   | S/model | The registry makes adding nearly declarative: one file + one entry in `MODELS`, invariant tests come for free |
| Additional exports: EDL / Premiere XML, ffmpeg concat of the timeline clips into a single file | L       | FCPXML only serves Final Cut; end-to-end render is the natural ask after timeline V2                          |
| Workflow templates (importable starter kits — the JSON export format already exists)           | S       | Onboarding: a new user starts from a working workflow instead of an empty canvas                              |
| Move the remaining hardcoded strings of `NodeParamsPanel` to i18next                           | S       | The Toolbar/HistoryPanel/confirm dialogs are done; the params panel still has hardcoded English labels        |
| More i18n locales (es, de, ja) through community contributions                                 | S       | The i18n infra + parity test makes contributing a locale trivial and safe                                     |
| Verify the per-model credit rates against the kie.ai dashboard                                 | S       | `estimateCredits` ships with indicative rates flagged in each model file — align them with real billing       |

## 5. Ecosystem & differentiation

| Proposal                                                                                                                             | Effort | Why                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Position the MCP server as the product's public API**: dedicated docs, client examples (Claude Code, scripts), registry versioning | M      | This is the differentiator: Raccord drivable by any agent. The registry exists, the showcase is missing                 |
| Community "model packs" (dynamically loaded model definitions, with a validation sandbox)                                            | L      | Turns the registry into a community extension point — kie.ai's model release pace exceeds what one maintainer can track |
| "Headless" mode: the Hono server + generation engine without a window, drivable via MCP/HTTP                                         | L      | Opens batch/server use cases (personal render farm) reusing `src/main/services/` as-is                                  |
| Docs site (VitePress) generated from `docs/` + model docs generated from the registry                                                | M      | The model docs already exist in-band for LLMs (`mcp/docs.ts`) — publish them for humans too                             |

## Suggested order

1. **README + security policy + issue templates** (§1) — the remaining
   blockers for a good first impression at publication.
2. **Versioned E2E suite** (§2) — locks in the runEngine/chat/IPC layer before
   contributors arrive.
3. **Real update feed** — turn the placeholder publish endpoint into actual
   releases (release-please tags + hosted binaries), making the beta channel
   real.
4. The rest as traction comes (the §5 items are the ones that create a
   community rather than just users).
