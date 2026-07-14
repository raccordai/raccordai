# Raccord

AI video studio as a desktop app (Electron) — production-grade successor to video-studio.

## Stack

- **Electron** + **electron-vite** (main / preload / renderer), packaged with **electron-builder**
- **React 19** + **TanStack Router** (hash history, file-based routes) + **TanStack Query**
- **Tailwind CSS v4**
- **SQLite** (better-sqlite3) + **Drizzle ORM**, versioned migrations applied on startup
- **Hono**: local HTTP API in the main process (`127.0.0.1:4517` by default — port and token persisted in settings), mount point of the MCP server
- **i18next**: FR/EN, resources shared between main and renderer, typed keys

## Commands

```bash
pnpm dev          # development (HMR)
pnpm build        # build main + preload + renderer
pnpm typecheck    # tsc over tsconfig.node.json and tsconfig.web.json
pnpm lint         # ESLint (flat config, includes the no-raw-colors rule)
pnpm format       # Prettier over the whole repo
pnpm test         # unit tests (Vitest through Electron's embedded Node)
pnpm db:generate  # generate a Drizzle migration after editing src/main/db/schema.ts
pnpm dist:mac     # package for macOS (dmg)
```

## Architecture

```
src/
  main/       # main process: db/, services/, server/ (Hono), ipc/, mcp/
  preload/    # contextBridge bridge, IPC channel whitelist
  shared/     # zod IPC contracts, feature-flag registry, i18n locales, model registry
  renderer/   # React: routes/ (TanStack Router), features/, lib/
drizzle/      # generated SQL migrations (bundled as extraResources when packaging)
```

Structural rules:

- **The renderer never touches SQLite or Node**: everything goes through `invoke()` (`renderer/src/lib/ipc.ts`), typed and validated on both sides by the zod contracts in `shared/ipc/contracts.ts`.
- **Business logic lives in `main/services/`**: consumed by the IPC handlers and by the Hono routes — never duplicated.
- **Additive migrations only**: user databases must survive every update.
- **Feature flags** (`shared/flags/registry.ts`): defaults per release channel (dev/beta/stable), overrides persisted in the database, toggleable from the app.
- **Feature-scoped code** in `renderer/src/features/` — no catch-all folders.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR guidelines and
[docs/testing.md](docs/testing.md) for the test & coverage strategy.

## License

[MIT](LICENSE)
