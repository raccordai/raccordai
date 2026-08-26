# Raccord's MCP server

Raccord exposes its capabilities to external agents through a local **MCP
(Model Context Protocol)** server — the same services the built-in assistant
and the UI use: read/build workflows, write prompts, launch generations,
manage assets.

## Connecting

- **Endpoint**: `http://127.0.0.1:4517/mcp` (Streamable HTTP transport, POST)
- **Auth**: `Authorization: Bearer <token>` — URL and token can be copied from
  **Settings → Integrations → MCP server**
- **Tokenless mode** (opt-in): the "Allow access without a token" toggle in the
  same Settings block drops the Bearer requirement. The server only ever binds
  `127.0.0.1`, but any local process can then drive the app — leave it off
  unless a client cannot send headers. Applies immediately, no restart.
- Requires the app to be running (the local API starts with the app).

The server only binds `127.0.0.1`. Local clients — Claude Code, Claude
Desktop, Codex — talk to it directly: **no tunnel, no HTTPS, nothing exposed
to the network**. The one exception is claude.ai in the browser (last
subsection), whose connectors call in from Anthropic's cloud.

### Claude Code

```sh
claude mcp add raccord --transport http http://127.0.0.1:4517/mcp \
  --header "Authorization: Bearer <token>"
```

With tokenless mode on, the `--header` flag can simply be omitted.

### Claude Desktop

Skip the **custom connectors** screen: those connect from Anthropic's
infrastructure and therefore demand a public HTTPS URL. Claude Desktop's
_local_ mechanism — the stdio servers in `claude_desktop_config.json` — works
with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridging stdio
to the local endpoint, and everything stays on the machine:

```json
{
  "mcpServers": {
    "raccord": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:4517/mcp",
        "--transport",
        "http-only",
        "--allow-http",
        "--header",
        "Authorization: Bearer <token>"
      ]
    }
  }
}
```

The config file lives at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows; restart Claude
Desktop after editing. `--allow-http` is required because the endpoint is
plain HTTP — deliberate, it never leaves `127.0.0.1`. With tokenless mode on,
drop the two `--header` lines.

### Codex CLI

Codex speaks Streamable HTTP natively, localhost included. In
`~/.codex/config.toml` (or a repo-scoped `.codex/config.toml`):

```toml
[mcp_servers.raccord]
url = "http://127.0.0.1:4517/mcp"
bearer_token_env_var = "RACCORD_MCP_TOKEN"
```

Codex reads the token from that environment variable at connect time — export
`RACCORD_MCP_TOKEN` in the shell that launches `codex` instead of pasting the
token into the file. One-liner alternative: `codex mcp add raccord --url
http://127.0.0.1:4517/mcp`. With tokenless mode on, the `url` line alone is
enough.

### claude.ai in the browser

The only client that genuinely needs a tunnel: claude.ai's custom connectors
are called from Anthropic's infrastructure, so the endpoint must be reachable
from the public internet over HTTPS. Expose it with a tunnel (a Cloudflare
Tunnel with a stable hostname is more comfortable than ngrok's rotating URLs),
then add the `https://…/mcp` URL as a custom connector. **Keep the Bearer
token on** — a tunnel makes the registry's destructive tools reachable from
outside, and the token is the only thing gating them. Never combine a tunnel
with tokenless mode.

## Philosophy: exploratory documentation

Tool descriptions are 1–2 lines; the depth lives in the `docs(topic)` tool
that agents call **on demand**:

| Topic            | Content                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `overview`       | Data model, typical session, conventions (positions, labels, intents)                                                        |
| `workflow-json`  | Import/export format specification (version 1)                                                                               |
| `models`         | Compact model index (one line each)                                                                                          |
| `model:<id>`     | Full sheet: edge inputs, outputs, params, prompting notes                                                                    |
| `prompting:<id>` | Long-form prompting guide (anatomy, camera vocabulary, dialogue syntax, pitfalls, examples) — read before writing prompts    |
| `styles`         | Style templates (art directions): style bible, per-media fragments, music hint, recommended params                           |
| `doctrine`       | How a video prompt is built: opening declaration, camera ontology, bracketed timeline, imperfection, optics, anti-AI lexicon |
| `designs`        | Design-sheet recipes: modes, fields, supported models, the prompt they build                                                 |
| `shots`          | Shot presets: the camera move written per model, plus the continuity fields (`opensOn`/`closesOn`/`screenDirection`)         |
| `templates`      | Workflow blueprint index (ready-to-import graphs with `[SLOTS]`)                                                             |
| `template:<id>`  | One blueprint's full workflow JSON, ready for `import_workflow`                                                              |

The `models`, `model:<id>` and `prompting:<id>` topics are **generated from the
model registry** (`src/shared/models/`), `styles` from `src/shared/styles/`,
`designs`/`shots` from `src/shared/designs/`, `doctrine` from
`src/shared/prompting/` and `templates` from `src/shared/templates/` — the docs
cannot drift from the real capabilities. An agent discovering the app pays ~0 tokens of fixed context and
fetches exactly the reference it needs.

A video can carry a **style template** (art direction): `get_workflow` returns
its `styleId`, `set_video_style` changes it, and agents are instructed to append
the style's _bible_ paragraph to every visual prompt (cross-shot consistency).

Two video-level iteration switches (§6) ride the same surface: `set_draft_mode`
makes every run substitute the model's cheap `draftEquivalent` (generations
stamped `draft`; `finalize_video` re-runs the draft keepers on the real models
and promotes them, `plan_only: true` for the draft-vs-final cost preview), and
`review_generation` runs the vision QC on a successful image generation
(automatic at settle when the video's QC option is on — verdict and notes come
back in `get_generations`).

`add_recipe_node` is the preferred way to create any node a **recipe** covers
(§6.8): a design sheet or a shot preset. It builds the prompt for the target
model and the video's style, stamps the markers the app reads (`recipeId`,
`designId` on reference sheets only, `applyVideoStyle`), and in a `from-image` /
`from-video` mode it creates and wires the source node in ONE undo step. The
fields an agent can fill — and the models each recipe runs on — come back from
`docs "designs"` and `docs "shots"`, generated from the same registry the
editor's form reads.

A brief becomes a graph in two deterministic steps (§6.7 → §6.11).
`write_scenario` turns the beats of the script into a shot list that is legal by
construction; `build_graph_from_scenario` then REALIZES that list — one shot
preset per shot, its camera move matched from the shot's own `camera` line
("travelling avant" → push-in), its legal duration carried into both the
`duration` param and the prompt's beat timeline, its opening/closing frames and
screen direction filled in, and the roles each beat named cast onto exactly
those shots. One undo step, no model call, no credit. It is idempotent by node
key, so re-running after extending the scenario only adds the new shots, and
`plan_only: true` reports which preset each shot lands on and why. That is the
path to prefer over hand-writing an `import_workflow` payload for a scenario;
what the presets cannot express stays an explicit import.

The project's **cast** (§6.10) is what turns a sheet into an identity.
`create_casting` names a published design sheet as a role of the film ("Léa IS
this sheet"); `cast_role` then wires that sheet as a reference on every shot of
a video AND writes its identity sentence into each prompt, as ONE undo step. It
is idempotent (a second call reports `alreadyCast` instead of double-wiring),
budget-aware (a shot whose reference handle is full, or whose model has no
reference input at all, comes back in `skipped` with a reason), and
`plan_only: true` is a free dry run. `list_castings` before generating any
character/décor/prop sheet — a role that already exists is cast, not
regenerated. Details: `docs "casting"`.

The project's **Instructions** are the user's own methodology (free markdown,
the project page's Instructions tab): how every video of the project must be
made. `get_project_instructions` returns it, and `get_workflow` reports
`hasProjectInstructions` so a headless agent knows to read it before planning —
over MCP the context is pull-only, whereas the embedded chat gets the block
injected into its system prompt automatically. `set_project_instructions`
replaces it wholesale (the assistant maintains it like the niche's positioning
brief), capped at 20k characters.

Three free tools frame the spend (§6.3/6.4/6.5). `lint_node` applies the app's
prompting doctrine before a run — reference wired but never addressed, design
sheet on a frame anchor, storyboard shot without the anti-grid guard, param
outside the model's enums — and each finding carries the fix an agent can apply
itself. `get_annotations` returns the user's marks on an output (a region of the
frame or a timecode, plus what they said), and `create_edit_node` turns them
into a pre-wired `gpt-image-2-image-to-image` fix node. `create_checkpoint` /
`diff_checkpoint` / `restore_checkpoint` capture, compare and roll back a whole
graph — the restore is `risk: 'destructive'` (it deletes what was created since)
and lands as ONE undo step.

Parallel exploration rides the run tools themselves: `run_node` and `run_batch`
accept `variants: N` (2–4) to claim N candidates of the same node — one queue
slot and one credit charge each, `run_node` returning every `generationIds`.
Dependencies still generate once; only the explicit targets are multiplied. The
user arbitrates the candidates in the app's compare grid, or an agent picks with
`select_generation`.

## Extending the server

Everything lives in `src/main/mcp/`:

- `registry.ts` — **the extension point**. One capability = one `AgentTool`
  entry (name, short description, JSON Schema, `scope`, `risk`, `execute()`
  calling the main services). The server publishes the registry as-is, and the
  embedded assistant consumes the SAME registry through
  `src/main/services/chatToolAdapter.ts`: nothing else to touch.
- `docs.ts` — the in-band documentation topics.
- `server.ts` — MCP plumbing (stateless, one instance per request, JSON
  responses). Almost never changes.

Every tool declares two fields (invariant-tested in `registry.test.ts`):

- `scope`: `'video'` (takes a `videoId`), `'project'` (takes a `projectId`) or
  `'global'` (neither, or addresses rows by their own globally-unique ids).
  The chat adapter injects the session's ids for video-bound sessions; MCP
  clients always pass them explicitly.
- `risk`: `'read'` (no state change), `'write'`, `'destructive'` (permanent
  data loss) or `'spending'` (calls kie.ai, costs credits). Non-`read` tools
  refresh the app UI after running. **Destructive tools are always
  approval-gated on the chat surface**, and **spending tools are gated too
  while the `assistantRunApproval` setting is `'ask'`** (its default) — an
  action card showing the estimated credit cost + a `confirm: true` re-call.
  MCP clients remain the human's own agent and execute directly, whatever the
  setting.

Rules to preserve: short descriptions (depth goes in `docs`), explicit ids in
the schemas (an MCP client has no "current video"), and settings/backup stay
out of the registry — an LLM loop must not touch API keys or relaunch the app.

## Verifying

The endpoint can be tested with raw JSON-RPC (see the session driver):
`initialize` → `tools/list` (one tool per registry entry) → `tools/call`.
Writes made through MCP refresh the UI live (`event:workflowChanged`).
