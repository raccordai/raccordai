# Tests & coverage

## Running the tests

```bash
pnpm test            # unit suite, single pass
pnpm test:watch      # watch mode during development
pnpm test:coverage   # unit suite + coverage report (blocking thresholds)
pnpm build && pnpm e2e   # E2E suite (built app + mocked kie.ai, no credits)
```

Tests run inside **Electron's embedded Node** (`ELECTRON_RUN_AS_NODE`, see
`scripts/run-vitest.mjs`): `better-sqlite3` is compiled for Electron's ABI by
the postinstall step and would not load under the system Node. Do not run
`vitest` directly.

## Test architecture

```
vitest.config.ts          config + coverage thresholds
scripts/run-vitest.mjs    launcher (Electron run-as-node)
tests/mocks/electron.ts   minimal stub of the electron module (aliased for all tests)
tests/helpers/db.ts       in-memory SQLite + real drizzle migrations, injected
                          into the singleton via setDatabaseForTests()
src/**/*.test.ts          tests colocated with the code under test
e2e/                      E2E suite — runner, harness, specs (see e2e/README.md)
```

Principles:

- **No database mocking**: service tests use a real in-memory SQLite database,
  migrated with the migrations in `drizzle/`. A passing test also guarantees
  the migrations produce the expected schema (cascades, unique indexes…).
- **The `electron` module is the only global mock** (alias in
  `vitest.config.ts`). It fails loudly on any API that isn't stubbed.
- **Colocated tests** (`foo.test.ts` next to `foo.ts`): typechecked by
  `pnpm typecheck`, never included in the bundle (electron-vite only follows
  the entry points).

## Test pyramid

| Level | Target                                                                                                                       | Tool                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit  | pure logic in `src/shared/` (models, i18n), SQLite services (`graph`, `projects`, `videos`), helpers (`media/files`, `lib/`) | Vitest                                                                             |
| E2E   | full flows: generation + poller, assistant, IPC/MCP, `media://`, MP4 render                                                  | Playwright `_electron` + the kie.ai mock (`RACCORD_KIE_BASE`), see `e2e/README.md` |

The generation engine (`runEngine.ts`, `kie.ts`), the chat (`chat.ts`), the
render process wrapper (`render.ts`) and the IPC/MCP wiring are deliberately
**outside the unit scope**: their value is in network/process integration,
covered by the E2E suite. Keeping them out of the coverage computation avoids
cosmetic unit tests written only to "make the number go up".

`pnpm e2e` runs each spec in its own process against the **built** app, so
`pnpm build` comes first. Every spec launches Electron with a throwaway
`--user-data-dir` and its own local-API port: the suite never reads or writes
the developer's real install, and it has a dedicated CI job. Everything
kie.ai-shaped — generations, Suno, uploads, credit balance and the Claude
proxy the assistant talks to — is served by one local mock, so a run costs no
credits and touches no network.

## Coverage strategy

Coverage is measured on an **explicit scope** (`coverage.include` in
`vitest.config.ts`) with blocking thresholds in CI:

- lines / statements / functions: **80%**
- branches: **75%**

Rules:

1. **The scope never shrinks.** Files can be added, never removed (except
   deleted code). Removing a file from the scope to get CI passing is a red
   flag in review.
2. **Every new logic module enters the scope** with its tests, in the same
   PR. A new kie.ai model is covered automatically by the invariant tests in
   `models.test.ts` (schema ↔ paramFields, unique handles, buildPayload) —
   but add a dedicated test if its payload has branches (see `suno-music`).
3. **Ratcheting thresholds**: when real coverage durably exceeds a threshold
   by ~5 points, raise the threshold. Never lower one to get a PR through.
4. **Coverage is a floor, not a goal.** A test must verify behavior
   (input → observable output), not execute lines. Prefer invariants (fr/en
   parity, model id uniqueness, export/import round-trip) that protect the
   project's rules.

## Guardrail tests for project rules

Some tests encode rules from CLAUDE.md — breaking them means a project rule
is being violated, not that the test is too strict:

- `src/shared/i18n/resources.test.ts` — every i18n key exists in fr **and**
  en, with the same `{{…}}` placeholders.
- `src/shared/models/models.test.ts` — model registry invariants (single
  source of truth for the UI, the kie.ai payload and the LLM docs), including
  the backward-compatibility aliases for saved workflows.
- `src/main/services/graph.test.ts` — runs on the real migrations: also
  verifies the schema stays backward compatible (cascades, per-video key
  uniqueness).
