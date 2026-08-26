# Raccord

**Generative video, under your direction.**

Raccord is a desktop orchestrator for AI video: compose multiple models into
workflows while keeping frame-level control — and drive it from the desktop,
from agents, or from the built-in assistant.

Anyone can generate. You're here to create.

Free and open source. Website: [raccord.ai](https://raccord.ai)

## Features

**Direct**

- **The canvas** — shots as composable, inspectable nodes on a node graph.
- **Scenario → graph** — write the beats, get a shot list that is legal by
  construction, build the graph from it in one deterministic, credit-free
  step.
- **Recipes** — pre-configured nodes for design sheets (characters, décors,
  props, storyboards…) and shot presets (push-in, orbit, POV handheld…) with
  the camera move already written.
- **Casting** — name a design sheet as a role of the film, then wire it as a
  reference across every shot in one step.
- **Style consistency** — pick an art direction once; every prompt gets its
  capture declaration and style bible at run time, never baked into your
  nodes.
- **Same shot, another model** — swap the model behind a shot in one click.

**Generate**

- **One key, every model** — generation runs through a single
  [KIE.ai](https://kie.ai) API key (image, video, music), at rates 30%+
  cheaper than going direct. Cost is estimated before you confirm.
- **Draft mode & QC** — iterate on cheap draft models, then finalize the
  keepers on the real ones; optional vision QC reviews each image as it
  lands.
- **Variants** — claim 2–4 candidates of a shot at once and arbitrate them in
  a synced compare grid.
- **Inline diagnostics** — errors, queue state and smart retries surface
  right on the node.
- **History, checkpoints, undo** — compare every generation of a shot; every
  graph mutation is one undo step; named checkpoints diff and roll back the
  whole graph.
- **Speech** — ElevenLabs voices and multi-speaker dialogue, with real
  transcripts to cut against; named voice personas per channel.

**Edit & ship**

- **The timeline** — renders land in it the moment they complete: trim,
  split, ~25 transitions, per-clip speed/looks/volume, title and sticker
  tracks, dynamic captions from real speech timings, music ducking.
- **Export** — render an MP4 (quality/codec options, burned subtitles,
  watermark) or export FCPXML to finish in a real NLE.

**Research**

- **Niches** — track YouTube niches (real SERP + Data API), outlier scoring
  across three lenses, competitor transcripts.
- **Roadmap** — grounded video ideas with evidence, packaging-first titles
  and thumbnail briefs, a feed preview against the niche's real thumbnails.

**Drive it from anywhere**

- **The assistant** — a native studio agent built on the same tools; ask for
  a full project in one message.
- **MCP server** — plug Claude Code, Claude Desktop, Codex or claude.ai
  straight into your projects ([connection guides](docs/mcp.md#connecting)).

## Quickstart

1. **Install.** Grab the build for your OS from the [download
   table](#download) below, or [run from source](#run-from-source).
2. **Get a kie.ai API key** at [kie.ai](https://kie.ai) — one key covers
   image, video and music generation, the credit balance and the assistant.
3. **Follow the first-run setup**: language → paste the key (it is validated
   live against kie.ai and stored encrypted through the OS keychain) → create
   the example project ("Product ad": a hero visual, 3 shots cut together and
   music, prompts already filled in).
4. **Run your first shot.** Select a node on the canvas, check the prompt in
   the right-hand params panel, hit Run. The cost is shown before you confirm;
   the result lands on the node and in the timeline the moment it completes.
5. **Export.** _Render MP4_ concatenates the timeline (music lane muxed in) —
   or export FCPXML to finish in a real NLE.

Then, in any order: describe what you want to the built-in **assistant**
instead of wiring nodes by hand, pick a **style** so every shot matches, or
plug an external agent into the **MCP server** (Settings → Integrations has
the URL and token):

```sh
claude mcp add raccord --transport http http://127.0.0.1:4517/mcp \
  --header "Authorization: Bearer <token>"
```

The server is local-only — Claude Desktop and Codex connect to it without any
tunnel or HTTPS; [docs/mcp.md](docs/mcp.md#connecting) has the copy-paste
config for each client (claude.ai in the browser is the one that needs a
tunnel).

Optional integrations, added later in Settings → Integrations: an
**ElevenLabs** key for speech, a **YouTube Data API** key and **DataForSEO**
credentials for niche research.

No account, no cloud backend: projects, media and settings live in a local
SQLite database and a local media store — and the whole app state exports as
one `.raccord` backup archive.

## Download

| Platform                  | Package                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 12+ (Apple Silicon) | [Raccord-mac.dmg](https://github.com/raccordai/raccordai/releases/latest/download/Raccord-mac.dmg)                                                                                                                        |
| Windows 10 & 11 (x64)     | [Raccord-windows.exe](https://github.com/raccordai/raccordai/releases/latest/download/Raccord-windows.exe)                                                                                                                |
| Linux (x64)               | [Raccord-linux.AppImage](https://github.com/raccordai/raccordai/releases/latest/download/Raccord-linux.AppImage) · [Raccord-linux.deb](https://github.com/raccordai/raccordai/releases/latest/download/Raccord-linux.deb) |

Updates install themselves (stable or beta channel, Settings → Updates).

## Stack

- **Electron** + **electron-vite** (main / preload / renderer), packaged with **electron-builder**
- **React 19** + **TanStack Router** (hash history, file-based routes) + **TanStack Query**
- **Tailwind CSS v4**
- **SQLite** (better-sqlite3) + **Drizzle ORM**, versioned migrations applied on startup
- **Hono**: local HTTP API in the main process (`127.0.0.1:4517` by default — port and token persisted in settings), mount point of the MCP server
- **ffmpeg / ffprobe** bundled (`ffmpeg-static`, `@ffprobe-installer/ffprobe`): MP4 render, transitions, subtitle burn, frame extraction — no system install needed
- **i18next**: FR/EN, resources shared between main and renderer, typed keys

## Run from source

Node.js ≥ 22 and pnpm (`corepack enable` picks the pinned version):

```bash
git clone https://github.com/raccordai/raccordai.git
cd raccordai
pnpm install      # postinstall rebuilds better-sqlite3 for Electron's ABI
pnpm dev
```

Packaging for your own platform: `pnpm dist:mac`, `pnpm dist:win` or
`pnpm dist:linux` (output in `dist/`). Self-built macOS artifacts are
unsigned — Gatekeeper will ask.

### Commands

```bash
pnpm dev          # development (HMR)
pnpm build        # build main + preload + renderer
pnpm typecheck    # tsc over tsconfig.node.json and tsconfig.web.json
pnpm lint         # ESLint (flat config, includes the no-raw-colors rule)
pnpm format       # Prettier over the whole repo
pnpm test         # unit tests (Vitest through Electron's embedded Node)
pnpm e2e          # end-to-end suite (built app + mocked kie.ai — no credits)
pnpm db:generate  # generate a Drizzle migration after editing src/main/db/schema.ts
pnpm dist:mac     # package for macOS (dmg)
```

## Architecture

```
src/
  main/       # main process: db/, services/, server/ (Hono), ipc/, mcp/
  preload/    # contextBridge bridge, IPC channel whitelist
  shared/     # zod IPC contracts, model/style/template/design registries, i18n locales, pure logic
  renderer/   # React: routes/ (TanStack Router), features/, lib/
drizzle/      # generated SQL migrations (bundled as extraResources when packaging)
```

Structural rules:

- **The renderer never touches SQLite or Node**: everything goes through `invoke()` (`renderer/src/lib/ipc.ts`), typed and validated on both sides by the zod contracts in `shared/ipc/contracts.ts`.
- **Business logic lives in `main/services/`**: consumed by the IPC handlers and by the Hono routes — never duplicated.
- **Additive migrations only**: user databases must survive every update.
- **Declarative registries in `shared/`**: a model, a style, a workflow template or a design recipe is one entry in a registry — the UI, the run payload and the agent-facing docs all derive from it, with no code to wire up elsewhere.
- **Feature-scoped code** in `renderer/src/features/` — no catch-all folders.
- **No feature flags**: features ship enabled for everyone.

## Contributing

Issues and PRs are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) —
setup, the conventions that are blocking in review, and what a mergeable PR
looks like — then [docs/testing.md](docs/testing.md) for the test & coverage
strategy.

Good first contributions: [adding a kie.ai
model](docs/models.md) (one declarative file, invariant tests come for free),
a new locale (the i18n parity test keeps it honest), or anything in
[docs/roadmap.md](docs/roadmap.md).

- 🐛 [Report a bug](https://github.com/raccordai/raccordai/issues/new?template=bug_report.yml)
  · ✨ [Request a feature](https://github.com/raccordai/raccordai/issues/new?template=feature_request.yml)
  · 🎬 [Ask for a model](https://github.com/raccordai/raccordai/issues/new?template=model_request.yml)
- Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security**: never report a vulnerability in a public issue — see
  [SECURITY.md](SECURITY.md).

## Documentation

| Doc                                | What's in it                                                              |
| ---------------------------------- | ------------------------------------------------------------------------- |
| [docs/mcp.md](docs/mcp.md)         | The MCP server: connecting, the tool registry, the in-band docs topics    |
| [docs/models.md](docs/models.md)   | Adding a kie.ai model, and how the app consumes a `ModelDefinition`       |
| [docs/testing.md](docs/testing.md) | Test strategy, coverage scope and thresholds                              |
| [e2e/README.md](e2e/README.md)     | The end-to-end suite: what it guarantees, how to run and extend it        |
| [docs/roadmap.md](docs/roadmap.md) | Open proposals — nothing committed to, but that's where the work is going |

## License

[MIT](LICENSE)
