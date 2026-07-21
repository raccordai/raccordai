# Raccord's MCP server

Raccord exposes its capabilities to external agents through a local **MCP
(Model Context Protocol)** server — the same services the built-in assistant
and the UI use: read/build workflows, write prompts, launch generations,
manage assets.

## Connecting

- **Endpoint**: `http://127.0.0.1:4517/mcp` (Streamable HTTP transport, POST)
- **Auth**: `Authorization: Bearer <token>` — URL and token can be copied from
  **Settings → Integrations → MCP server**
- Requires the app to be running (the local API starts with the app).

Example — wiring up Claude Code:

```sh
claude mcp add raccord --transport http http://127.0.0.1:4517/mcp \
  --header "Authorization: Bearer <token>"
```

## Philosophy: exploratory documentation

Tool descriptions are 1–2 lines; the depth lives in the `docs(topic)` tool
that agents call **on demand**:

| Topic            | Content                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `overview`       | Data model, typical session, conventions (positions, labels, intents)                                                     |
| `workflow-json`  | Import/export format specification (version 1)                                                                            |
| `models`         | Compact model index (one line each)                                                                                       |
| `model:<id>`     | Full sheet: edge inputs, outputs, params, prompting notes                                                                 |
| `prompting:<id>` | Long-form prompting guide (anatomy, camera vocabulary, dialogue syntax, pitfalls, examples) — read before writing prompts |
| `styles`         | Style templates (art directions): style bible, per-media fragments, music hint, recommended params                        |
| `templates`      | Workflow blueprint index (ready-to-import graphs with `[SLOTS]`)                                                          |
| `template:<id>`  | One blueprint's full workflow JSON, ready for `import_workflow`                                                           |

The `models`, `model:<id>` and `prompting:<id>` topics are **generated from the
model registry** (`src/shared/models/`), `styles` from `src/shared/styles/` and
`templates` from `src/shared/templates/` — the docs cannot drift from the real
capabilities. An agent discovering the app pays ~0 tokens of fixed context and
fetches exactly the reference it needs.

A video can carry a **style template** (art direction): `get_workflow` returns
its `styleId`, `set_video_style` changes it, and agents are instructed to append
the style's _bible_ paragraph to every visual prompt (cross-shot consistency).

## Extending the server

Everything lives in `src/main/mcp/`:

- `registry.ts` — **the extension point**. One capability = one `AgentTool`
  entry (name, short description, JSON Schema, `execute()` calling the main
  services, `mutates` to refresh the UI). The server publishes the registry
  as-is: nothing else to touch.
- `docs.ts` — the in-band documentation topics.
- `server.ts` — MCP plumbing (stateless, one instance per request, JSON
  responses). Almost never changes.

Rules to preserve: short descriptions (depth goes in `docs`), explicit ids in
the schemas (an MCP client has no "current video"), `mutates: true` on
everything that writes.

## Verifying

The endpoint can be tested with raw JSON-RPC (see the session driver):
`initialize` → `tools/list` (one tool per registry entry) → `tools/call`.
Writes made through MCP refresh the UI live (`event:workflowChanged`).
