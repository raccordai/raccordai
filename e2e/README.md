# E2E suite

The layer the unit suite deliberately leaves out: the generation engine
(`runEngine.ts`, `kie.ts`), the assistant (`chat.ts`), the IPC/MCP wiring, the
`media://` protocol and the MP4 render. Their value is in network and process
integration, so they are covered here — against mocks, never against kie.ai.

**No credits are ever spent and no network call ever leaves the machine.**

```bash
pnpm build          # the suite runs the built app (out/main/index.js)
pnpm e2e            # every spec, sequentially
pnpm e2e render     # one spec (prefix match)
node e2e/specs/render.e2e.mjs   # the same spec, standalone (debugging)
E2E_VERBOSE=1 pnpm e2e          # stream the app's main/renderer logs
```

## What it guarantees

| Spec                     | Flow                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation.e2e.mjs`     | run a node → kie submission → **poller** → local download → `media://` Range serving → canvas. Plus the style-at-payload rule.                                                                                          |
| `assistant.e2e.mjs`      | one brief to the home assistant → scripted agent (project → video → style → workflow import) → the rows and graph really exist.                                                                                         |
| `render.e2e.mjs`         | heterogeneous clips + Suno music → MCP `render_video` → ffprobe on the file, music audible over the silent clip, cancellation.                                                                                          |
| `recipes.e2e.mjs`        | recipe nodes (§6.8): the typed IPC channel, the `add_recipe_node` agent tool, video-format inheritance, source wiring in ONE undo step.                                                                                 |
| `casting.e2e.mjs`        | casting (§6.10): sheet → promote → name a role → `cast_role` on every shot, the skip on an anchor-only model, idempotence, ONE undo step.                                                                               |
| `scenario-graph.e2e.mjs` | scenario → graph (§6.11): `write_scenario` → free plan → build (presets matched from the camera lines, durations, frames, roles cast), rebuild adds only, ONE undo step, and the same build from the Scenario island.   |
| `speech.e2e.mjs`         | speech (§8): voice persona → ElevenLabs TTS through the synchronous provider branch (file:// staging → media store) with the timed transcript stored, dialogue script resolved against the voice map, `get_transcript`. |

## Isolation

Every spec launches the app with its own `--user-data-dir` (own SQLite
database, own media store, own single-instance lock) and its own local-API port
(`RACCORD_LOCAL_API_PORT`). The developer's real install is never read or
written, so a spec needs no cleanup step and a crashed run leaves nothing
behind but a temp directory.

The launch also sets `RACCORD_E2E=1`, which lets an **unpackaged** app fall
back to safeStorage's in-memory password (`src/main/index.ts`): without an OS
keyring — headless Linux, i.e. CI — safeStorage refuses to encrypt and the
seeded kie key could not be stored at all. A packaged build ignores it.

## Layout

```
e2e/run.mjs               runner (one process per spec)
e2e/harness/app.mjs       launch + seeding + invoke/goto/collectEvent/mcp helpers
e2e/harness/kie-mock.mjs  every kie.ai surface: jobs, Suno, upload, credit, Claude proxy, media
e2e/harness/fixtures.mjs  synthetic media generated with the bundled ffmpeg (cached in .fixtures/)
e2e/harness/spec.mjs      reporting, assertions, waitFor, deferred teardown
e2e/specs/*.e2e.mjs       the scenarios
```

## Adding a spec

1. Drop a `<name>.e2e.mjs` in `specs/`, wrapped in `spec(name, async () => …)`.
2. `defer()` the mock and the app right after creating them — teardown runs
   even when the spec fails.
3. **Drive through IPC, assert through the UI and the filesystem.**
   `app.invoke(channel, input)` reaches every typed channel, which keeps specs
   readable; the assertions are what must go through the real surfaces.
4. Never `sleep()` on an app state — `waitFor()` polls until it is true. Bare
   sleeps are how an E2E suite starts failing only in CI.
5. Anything the app sends to kie.ai is recorded in `mock.recorded`
   (`createTask`, `suno`, `claude`, `uploads`): assert the request too, not
   just the visible outcome.
