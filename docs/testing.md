# Tests & coverage

## Running the tests

```bash
pnpm test            # full suite, single pass
pnpm test:watch      # watch mode during development
pnpm test:coverage   # suite + coverage report (blocking thresholds)
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

| Level | Target                                                                                                                              | Tool                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Unit  | pure logic in `src/shared/` (models, flags, i18n), SQLite services (`graph`, `projects`, `videos`), helpers (`media/files`, `lib/`) | Vitest                                                                                                        |
| E2E   | full flows (generation, chat, UI)                                                                                                   | Playwright `_electron` + kie.ai/Anthropic mocks (`RACCORD_KIE_BASE`, `RACCORD_ANTHROPIC_BASE`), see CLAUDE.md |

The generation engine (`runEngine.ts`, `kie.ts`), the chat (`chat.ts`) and the
IPC/MCP wiring are deliberately **outside the unit scope**: their value is in
network/process integration, covered by the mocked E2E harness. Keeping them
out of the coverage computation avoids cosmetic unit tests written only to
"make the number go up".

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
