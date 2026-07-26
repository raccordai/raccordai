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

Two video-level iteration switches (§6) ride the same surface: `set_draft_mode`
makes every run substitute the model's cheap `draftEquivalent` (generations
stamped `draft`; `finalize_video` re-runs the draft keepers on the real models
and promotes them, `plan_only: true` for the draft-vs-final cost preview), and
`review_generation` runs the vision QC on a successful image generation
(automatic at settle when the video's QC option is on — verdict and notes come
back in `get_generations`).

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
