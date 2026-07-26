# Contributing to Raccord

Thanks for your interest! This document describes how to open a Pull Request
(PR) that has a good chance of being merged quickly.

## Prerequisites & setup

- Node.js ≥ 22, pnpm (version pinned in `package.json` → `packageManager`,
  use `corepack enable`)
- `pnpm install` — the postinstall step rebuilds `better-sqlite3` for
  Electron's ABI; this is expected and required
- `pnpm dev` starts the app in development mode

## Workflow

1. **Open an issue first** for any feature or behavior change — describe the
   need before writing code. Obvious bug fixes can go straight to a PR. There
   are three forms (bug, feature, new kie.ai model); usage questions and
   open-ended ideas go to Discussions instead.
2. Branch off `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>` or
   `chore/<topic>`.
3. Open the PR using the default template and fill in every section.

## Commits & hooks

- **Conventional commits are enforced** (`feat: …`, `fix: …`, `chore: …`,
  optional scope: `feat(timeline): …`). Versioning and the changelog are
  generated from them by release-please — a malformed message breaks the
  release notes.
- `pnpm install` installs the git hooks (lefthook): ESLint + Prettier run on
  staged files at pre-commit, commitlint checks the message at commit-msg.
  Don't bypass them with `--no-verify`; CI runs the same checks anyway.

## Golden rules for a PR

- **One PR = one intent.** No opportunistic refactoring mixed into a feature.
  If you spot a cleanup, open a separate PR.
- **Small is better.** Beyond ~400 lines of effective diff, split it if
  possible; review will be faster and better.
- **Green locally before opening**: `pnpm typecheck && pnpm test && pnpm build`.
- **Screenshot or screencast required** for any visible UI change (the app is
  a visual editor — review happens with the eyes too).
- **Honest description**: what works, what isn't covered, debatable choices.
  A disclosed limitation is a discussion point; a limitation discovered in
  review is one more round-trip.

## Project conventions (blocking in review)

These rules structure the codebase — a PR that bypasses them will be sent
back, even if it works:

| Area              | Rule                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPC               | All renderer→main communication goes through a channel declared in `src/shared/ipc/contracts.ts` (zod input/output schemas), handler in `src/main/ipc/index.ts`                                                      |
| Business logic    | In `src/main/services/`, never in an IPC handler or a Hono route — both consume the same services                                                                                                                    |
| Database          | Edit `src/main/db/schema.ts` then `pnpm db:generate`. **Additive migrations only** — user databases must survive every update                                                                                        |
| Feature flags     | There is no flag system — features ship enabled for everyone. Land a feature when it is ready rather than hiding it behind a switch                                                                                  |
| i18n              | Every user-visible string goes through i18next: key added to `fr/common.json` **and** `en/common.json` (a parity test fails otherwise)                                                                               |
| Colors            | Only through the tokens in `src/renderer/src/styles.css` — never raw color classes. `danger` = error states and destructive hover only, never a solid button background                                              |
| Editor layout     | UI as floating islands (`island` utility) above the canvas — any new panel follows this pattern                                                                                                                      |
| MCP               | Any new app capability is added to the `src/main/mcp/registry.ts` registry in the same PR                                                                                                                            |
| New kie.ai models | One file in `src/shared/models/` + append to `MODELS` — the UI, the payload and the LLM docs derive from it. The invariant tests cover the new model automatically; add a dedicated test if its payload has branches |

## Tests & coverage

The full strategy lives in [`docs/testing.md`](docs/testing.md). The essentials:

- `pnpm test` runs the suite through Electron's embedded Node — **never run
  `vitest` directly** (better-sqlite3 is compiled for Electron's ABI).
- Every new logic module ships **with its tests in the same PR** and enters
  the coverage scope (`coverage.include` in `vitest.config.ts`).
- Coverage thresholds are blocking in CI. **Never lower a threshold and never
  remove a file from the scope** to get a PR through — that is an immediate
  rejection.
- A test verifies observable behavior, not executed lines. "Cosmetic" tests
  written to inflate the number will be rejected.

## What the pipeline checks

`lint` → `format:check` → `typecheck` → `test:coverage` (blocking thresholds)
→ `build`. A PR with a red pipeline is not reviewed.

## Review

- One maintainer approval is enough.
- Answer review comments with additional commits (no force-push during
  review, unless explicitly asked); squash happens at merge time.
- A PR with no activity after two pings will be closed — reopen anytime.

## Code of conduct

Participation in this project — issues, PRs, reviews, discussions — is covered
by the [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
Report unacceptable behavior to <romainmanniez@gmail.com>.

## Security

Do not report vulnerabilities through a public issue — [SECURITY.md](SECURITY.md)
describes the private channels (GitHub advisory, or email) and what to expect.
Never commit an API key (kie.ai/Anthropic keys live encrypted via
`safeStorage`, never in the clear in code or config).

Automated checks: Dependabot (`.github/dependabot.yml`) and CodeQL
(`.github/workflows/codeql.yml`) run on GitHub. **Secret scanning + push
protection** is a repository setting, not a file — a maintainer must enable it
once in _Settings → Security → Code security_ after the repo is pushed to
GitHub (free for public repos).
