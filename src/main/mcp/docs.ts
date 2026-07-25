import { MODELS, getModel } from '@shared/models'
import { STYLES, getStyle } from '@shared/styles/registry'
import { WORKFLOW_TEMPLATES, getWorkflowTemplate } from '@shared/templates/registry'
import { DESIGN_RECIPES, buildDesignPrompt, designIntent } from '@shared/designs/registry'

/**
 * In-band, exploratory documentation for agents — served by the `docs` tool.
 * Tool descriptions stay short; agents fetch exactly the reference they need,
 * when they need it. Model topics are GENERATED from the registry, so this
 * documentation can never drift from the actual capabilities.
 */

const OVERVIEW = `Raccord is a node-based AI video studio. Hierarchy:
  Project → Videos (one workflow graph each) + Assets (project-wide media library)
  Video → Nodes (AI model invocations, or 'studio/asset' references) + Edges
  Node → Generations (runs; status pending/running/success/failed)

Edges wire a source node's output into a target node's input:
  - "input"  = the target model's input field name (see docs "model:<id>")
  - "output" = "output" (main result) or "lastFrame" (last frame of a video clip)

Typical session:
  1. list_projects → list_videos → get_workflow (ids of everything)
  2. docs "models" then docs "model:<id>" for the models you plan to use;
     read docs "prompting:<id>" BEFORE writing any prompt for that model.
     CRITICAL: image inputs are either frame ANCHORS (they appear on screen) or
     REFERENCES (they guide without appearing) — docs "models" explains which is which
  3. pick an art direction: docs "styles" → set_video_style. The style bible is
     appended to prompts AT RUN TIME for visual nodes whose params carry
     "applyVideoStyle": true (set it on the visual nodes you create; never paste
     the bible into prompts). Or start from a full blueprint:
     docs "templates" then docs "template:<id>" → import_workflow.
     Need a character/décor/prop sheet or a scene storyboard? docs "designs" has
     ready prompt recipes (wire the resulting node as a REFERENCE, never a frame
     anchor; the storyboard is the review gate before spending video credits)
  4. add_node / connect_nodes / update_node — or import_workflow for a whole plan
  5. run_node (COSTS MONEY — each run calls the kie.ai API); completion is
     asynchronous: poll get_generations until status is success/failed.
  6. Iterating? set_draft_mode makes every run substitute the model's cheap
     draft equivalent (generations stamped "draft"); finalize_video (plan_only
     first for the draft-vs-final cost) re-runs the approved keepers on the
     real models. review_generation runs a vision QC (pass/warn + notes) on a
     successful image generation; with the video's QC option on it runs
     automatically at every image settle.

Conventions:
  - Position nodes left-to-right (x: 0, 420, 840…; y spaced ~350).
  - node "label": short display name. Prefix video clips "Shot 01 — …" to order the timeline.
  - node "intent": expected result in plain language, shown to the user next to the output.
  - Asset nodes: modelId "studio/asset", params {"assetId": "<id from list_assets>"}.
  - Bring media in with add_asset_from_url / add_asset_from_file (project-wide, shared by all videos);
    always set an AI-facing "description" so future agents know what the media depicts.
  - The user sees the graph update live in the app while you work.

Other topics: "workflow-json", "models", "model:<id>", "prompting:<id>", "styles", "designs", "templates", "template:<id>".`

const WORKFLOW_JSON = `Workflow JSON (version 1) — the bulk import/export format (import_workflow / export_workflow):
{
  "version": 1,
  "assets": [{ "key", "name", "kind", "description" }],        // informational manifest (export only)
  "nodes": [{
     "key": "kf01",                  // YOUR stable id, referenced by edges
     "modelId": "<model id or studio/asset>",
     "label": "01 — Establishing",   // optional
     "intent": "expected result",    // optional
     "position": { "x": 0, "y": 0 },
     "params": { ... }               // model params; asset nodes: {"assetKey": "<key>"}
                                     // visual nodes: add "applyVideoStyle": true so the video's
                                     // style bible is appended to the prompt at run time
  }],
  "edges": [{ "from": "kf01", "to": "clip01", "input": "<target input field>", "output": "output" | "lastFrame" }]
}
Rules:
  - import_workflow(replace=true) ERASES the current graph first — explicit user consent required.
  - Asset references use the portable "assetKey" (from list_assets); the importer resolves it to the
    project-local assetId and fails with a helpful error if the asset is missing.
  - Edge "input" names are NOT validated at import — get them right from docs "model:<id>".`

function modelsIndex(): string {
  const lines = MODELS.map(
    (m) =>
      `${m.id}  [${m.kind}]  ${m.label} — ${m.description.split('.')[0]}. (recommended for: ${m.recommendedFor.join(', ')})`
  )
  return `Available models (details: docs "model:<id>"):\n${lines.join('\n')}\nPlus "studio/asset" — a node that outputs a project asset (params: {"assetId"}).

CHOOSING A VIDEO MODEL — image inputs have TWO different semantics; mixing them up is the #1 workflow bug:
  - FRAME ANCHORS (seedance-1.5-pro "input_urls", grok "image_urls"): connected images APPEAR in the
    video literally (first frame / first+last). Wire scene stills, hero shots and previous-clip last
    frames here. NEVER a character sheet, storyboard or style board — it would show up on screen.
  - REFERENCES (seedance-2-fast "reference_*"): connected sources GUIDE identity/style/motion and do
    NOT appear on screen, unless the prompt assigns a frame role ("@Image1 as the first frame").
    Character sheets, storyboards and style boards belong HERE, with an explicit role in the prompt.
Recipes:
  - Continuity: previous clip's "lastFrame" output → next clip's image input. On 1.5/Grok it IS the
    first frame; on Seedance 2 also write "@ImageN as the first frame" in the prompt.
  - Character consistency across shots: key visual → EVERY shot's reference_image_urls on Seedance 2
    ("[character] matches the design @Image1, reference only"); impossible on 1.5 (prompt-only).
  - Style consistency: set_video_style + "applyVideoStyle": true in every visual node's params — the
    app appends the video's style bible (docs "styles") to the prompt at run time; never paste it
    yourself. Keep a strong style keyword in Seedance 2 prompts (prevents photoreal drift).
  - Pre-visualization (Seedance 2): storyboard each scene BEFORE running video — a 9-panel grid built
    from the design sheets (docs "designs", recipe "storyboard"), reviewed by the user, then wired as
    a reference with "follow its panels in order, left to right, top to bottom" PLUS the anti-grid
    guard ("a staging plan only, it must NEVER appear on screen — render one single full-frame shot:
    no 3x3 grid, no panel borders, no panel numbers, no split-screen"); the video prompt then
    describes motion (camera, rhythm, transitions), not the visuals the storyboard already encodes.`
}

function modelDetail(id: string): string {
  const m = getModel(id)
  if (!m) return `Unknown model "${id}". Valid ids: ${MODELS.map((x) => x.id).join(', ')}`
  const inputs =
    m.inputs.length === 0
      ? '  (none — no connections needed)'
      : m.inputs
          .map(
            (h) =>
              `  - "${h.key}" accepts ${h.accepts.join('/')}${h.required ? ' (REQUIRED)' : ''}${h.multiple ? ' (multiple)' : ''}${h.maxCount ? ` (max ${h.maxCount})` : ''}${h.referenceAlias ? ` — sources addressable in the prompt as ${h.referenceAlias}1, ${h.referenceAlias}2… (connection order)` : ''}`
          )
          .join('\n')
  const params = m.paramFields
    .map((f) => {
      const opts = f.options ? ` options: ${f.options.map((o) => o.value).join('|')}` : ''
      const def = f.defaultValue !== undefined ? ` default: ${JSON.stringify(f.defaultValue)}` : ''
      return `  - "${f.key}" (${f.type})${def}${opts}${f.description ? ` — ${f.description}` : ''}`
    })
    .join('\n')
  return `${m.label} — id "${m.id}" [${m.kind}]
${m.description}
Recommended for: ${m.recommendedFor.join(', ')}${
    m.draftEquivalent
      ? `\nDraft equivalent (used automatically in draft mode): ${m.draftEquivalent.modelId}${m.draftEquivalent.params ? ` with ${JSON.stringify(m.draftEquivalent.params)}` : ''}`
      : ''
  }

Edge inputs (edge "input" values targeting this model):
${inputs}
Outputs (edge "output" values from this model): ${m.outputs.map((o) => `"${o.key}"`).join(', ')}

Params:
${params}${m.promptingNotes ? `\n\nPrompting notes:\n${m.promptingNotes}` : ''}${m.promptGuide ? `\n\nFull prompting guide (read it before writing prompts): docs "prompting:${m.id}"` : ''}`
}

function promptingGuide(id: string): string {
  const m = getModel(id)
  if (!m) return `Unknown model "${id}". Valid ids: ${MODELS.map((x) => x.id).join(', ')}`
  if (!m.promptGuide)
    return `${m.label} has no long-form prompting guide; see docs "model:${m.id}" (Prompting notes).`
  return `${m.label} — prompting guide\n\n${m.promptGuide}`
}

function stylesIndex(): string {
  const entries = STYLES.map(
    (s) => `── ${s.id} — ${s.label}
${s.description}
Style bible (appended automatically at run time to flagged nodes):
${s.styleBible}
Image prompts add: ${s.imageFragment}
Video prompts add: ${s.videoFragment}
Music (Suno style field): ${s.musicHint}
Keep out of prompts: ${s.avoid}
Recommended params: ${JSON.stringify(s.recommendedParams)}`
  )
  return `Style templates — reusable art directions. Attach one to a video with set_video_style;
the video's style is returned by get_workflow. The style bible is THE cross-shot consistency
lever: the app appends it to the prompt AT RUN TIME for every visual node whose params carry
"applyVideoStyle": true (the default for template/design/plain-created nodes). Set that flag on
the visual nodes you create; NEVER paste the bible into a prompt — it would be duplicated at run
and a style switch would no longer propagate.

${entries.join('\n\n')}`
}

function designsIndex(): string {
  const entries = DESIGN_RECIPES.map((r) => {
    const prompt = buildDesignPrompt(r, r.defaultModelId, { description: '' })
    const overrides = Object.keys(r.byModel ?? {}).map(
      (id) => `\nPrompt when using ${id} instead:\n${buildDesignPrompt(r, id, { description: '' })}`
    )
    return `── ${r.id} — ${r.label}
${r.description}
Model: ${r.defaultModelId}${r.params ? ` · params: ${JSON.stringify(r.params)}` : ''}
Node intent: ${designIntent(r)}
Prompt (replace ${r.slot} with the subject; set "applyVideoStyle": true in the node params — the video's style bible is appended at run time):
${prompt}${overrides.join('')}`
  })
  return `Design recipes — ready prompts for reusable design sheets (add_node with the recipe's model,
params and prompt; give the node the recipe's intent). CRITICAL: a design node's output is a
REFERENCE — wire it to reference inputs only (e.g. Seedance 2 "reference_image_urls" with a role
in the prompt like "matches the design @Image1, reference only"), NEVER to a frame-anchor input
(seedance-1.5 "input_urls", grok "image_urls") where it would appear on screen.

The pipeline: design sheets (character/decor/prop) → storyboard → video shots. The storyboard is
the pre-visualization gate: build it FROM the sheets (gpt-image-2-image-to-image, sheets wired to
"input_urls" — use the recipe's per-model prompt), let the user review the staging on the 9-panel
grid before any video credits are spent, then wire it on each Seedance 2 shot with the role
"@ImageN is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on
screen: follow its panels in order, left to right, top to bottom" (on multi-shot scenes, say which
panels each shot covers) AND the anti-grid constraint "render one single full-frame shot: no 3x3
grid, no panel borders, no panel numbers, no split-screen or comic-panel layout" — without both,
the model may render the grid itself in the video. The video prompt then describes motion, not
the visuals the storyboard already encodes. Match the storyboard's aspect_ratio to the video's.

The project library: BEFORE generating a new sheet, check list_assets/search_assets for a published
design sheet of the same subject (designId/designSubject are set on those) and reuse it via an
add_node "studio/asset" node ({"assetId": ...}) wired to reference inputs. After the user approves
a freshly generated sheet, publish_design its generation so every video of the project can reuse
it. Published sheets follow the same rule as design nodes: reference only, never a frame anchor.

${entries.join('\n\n')}`
}

function templatesIndex(): string {
  const lines = WORKFLOW_TEMPLATES.map(
    (t) =>
      `${t.id} — ${t.label}\n  ${t.description}\n  style: ${t.styleId} · slots to fill: ${t.slots.map((s) => s.token).join(', ')}`
  )
  return `Workflow templates — ready-to-import graph blueprints (get the JSON with docs "template:<id>",
fill the [SLOTS] with the user's subject, then import_workflow). Every visual node carries
"applyVideoStyle": true, so set the video's style to the template's styleId (set_video_style) and
the matching style bible is appended to each prompt at run time.\n\n${lines.join('\n\n')}`
}

function templateDetail(id: string): string {
  const t = getWorkflowTemplate(id)
  if (!t)
    return `Unknown template "${id}". Valid ids: ${WORKFLOW_TEMPLATES.map((x) => x.id).join(', ')}`
  const style = getStyle(t.styleId)
  return `${t.label} — id "${t.id}" (style: ${style?.label ?? t.styleId})
${t.description}
Slots to replace with the user's subject before running: ${t.slots
    .map((s) => `${s.token} (e.g. "${s.example}")`)
    .join(', ')}
REQUIRED: set the video's style with set_video_style("${t.styleId}") — the blueprint's visual nodes
carry "applyVideoStyle": true, so the bible only reaches the prompts once the style is attached.

Workflow JSON (pass as-is to import_workflow after filling the slots):
${JSON.stringify(t.workflow, null, 2)}`
}

export const DOC_TOPICS =
  'overview | workflow-json | models | model:<id> | prompting:<id> | styles | designs | templates | template:<id>'

export function getDoc(topic: string): string {
  if (topic === 'overview') return OVERVIEW
  if (topic === 'workflow-json') return WORKFLOW_JSON
  if (topic === 'models') return modelsIndex()
  if (topic.startsWith('model:')) return modelDetail(topic.slice('model:'.length))
  if (topic.startsWith('prompting:')) return promptingGuide(topic.slice('prompting:'.length))
  if (topic === 'styles') return stylesIndex()
  if (topic === 'designs') return designsIndex()
  if (topic === 'templates') return templatesIndex()
  if (topic.startsWith('template:')) return templateDetail(topic.slice('template:'.length))
  return `Unknown topic "${topic}". Valid topics: ${DOC_TOPICS}`
}
