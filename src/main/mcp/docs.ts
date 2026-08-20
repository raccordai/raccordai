import { MODELS, getModel } from '@shared/models'
import { STYLES, getStyle } from '@shared/styles/registry'
import { WORKFLOW_TEMPLATES, getWorkflowTemplate } from '@shared/templates/registry'
import {
  ANTI_AI_TERMS,
  ANTI_BEAUTY_LOCK,
  CAMERA_MODES,
  CAPTURE_DECLARATIONS,
  FOV_STEPS,
  MAX_CAPS_TRANSIENTS,
  SHOT_SIZES,
  WHITE_BALANCE_KELVIN
} from '@shared/prompting/seedance'
import {
  DESIGN_RECIPES,
  SHOT_RECIPES,
  buildRecipePrompt,
  defaultModeOf,
  recipeFieldsFor,
  recipeIntent,
  type Recipe
} from '@shared/designs/registry'

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
  1a. When get_workflow reports hasProjectInstructions: true, call
     get_project_instructions BEFORE planning anything: it is the user's own
     per-project methodology (markdown) and takes PRIORITY over the generic
     method below. set_project_instructions replaces it (full replacement) —
     only when the user asks to save or change their method.
  1b. Asked for a film from a brief? Write the SCENARIO first — write_scenario turns beats into a
     shot list whose durations the model accepts, chained cut to cut, before any graph exists
     (docs "scenario"). It is the step where the constraints are cheap to respect. Then
     build_graph_from_scenario realizes it: one shot preset per shot, camera move, duration and
     frames already filled in, roles cast — do not retype that shot list as an import_workflow.
  2. docs "models" then docs "model:<id>" for the models you plan to use;
     read docs "doctrine" ONCE (how a video prompt is built: the opening
     declaration, the camera's ontology, the bracketed timeline, imperfection)
     and docs "prompting:<id>" BEFORE writing any prompt for that model.
     CRITICAL: image inputs are either frame ANCHORS (they appear on screen) or
     REFERENCES (they guide without appearing) — docs "models" explains which is which.
     Equally critical: between two shots you CUT to a new angle — never chain one
     clip's lastFrame into the next (it glitches); docs "models" has the recipes.
     Two consecutive shots only read as one sequence if each prompt says what frame
     it OPENS ON and CLOSES ON and keeps the screen direction — docs "continuity"
  3. pick an art direction: docs "styles" → set_video_style. The style bible is
     appended to prompts AT RUN TIME for visual nodes whose params carry
     "applyVideoStyle": true (set it on the visual nodes you create; never paste
     the bible into prompts). Or start from a full blueprint:
     docs "templates" then docs "template:<id>" → import_workflow.
     Need a character/décor/prop sheet or a scene storyboard? docs "designs" has
     ready recipes (wire the resulting node as a REFERENCE, never a frame
     anchor; the storyboard is the review gate before spending video credits)
  4. add_recipe_node FIRST whenever a recipe fits — design sheets (docs "designs")
     and shot presets (docs "shots", the camera move already written for the
     model). add_node / connect_nodes / update_node for the rest — or
     import_workflow for a whole plan
  5. run_node (COSTS MONEY — each run calls the kie.ai API); completion is
     asynchronous: poll get_generations until status is success/failed.
  6. Iterating? set_draft_mode makes every run substitute the model's cheap
     draft equivalent (generations stamped "draft"); finalize_video (plan_only
     first for the draft-vs-final cost) re-runs the approved keepers on the
     real models. review_generation runs a vision QC (pass/warn + notes) on a
     successful image generation; with the video's QC option on it runs
     automatically at every image settle. Unsure which direction to take?
     run_node / run_batch accept variants: N (2–4) to generate N candidates of
     the same node in parallel (cost ×N) — the user arbitrates them in the
     app's compare grid, or select_generation picks the keeper.
  7. Free safety rails, use them: lint_node checks a node BEFORE the spend
     (undeclared reference, sheet on a frame anchor, missing anti-grid guard,
     param outside the model's enums OR its numeric bounds, reference handle
     over its combined-length budget) — run it on every prompt you write.
     Numeric bounds are an API contract: docs "model:<id>" prints the allowed
     range of every number param (a Seedance 2 clip cannot be shorter than 4s).
     A beat shorter than the model's floor is run AT the floor or merged with
     its neighbour — never rounded down into a clip the API will refuse.
     write_scenario does that arithmetic for a whole script (docs "scenario").
     create_checkpoint captures the graph before a structural rework;
     diff_checkpoint shows what a restore would change, restore_checkpoint
     rolls back in one undo step. get_annotations returns what the user
     circled on an output and said about it — create_edit_node turns those
     notes into a pre-wired fix node (images only).

Conventions:
  - Position nodes left-to-right (x: 0, 420, 840…; y spaced ~350). Omitting positions is fine —
    the app lays the graph out itself. Never reuse one coordinate for several nodes (they pile up).
  - node "label": short display name. Prefix video clips "Shot 01 — …" to order the timeline.
  - node "intent": expected result in plain language, shown to the user next to the output.
  - Asset nodes: modelId "studio/asset", params {"assetId": "<id from list_assets>"}.
  - Bring media in with add_asset_from_url / add_asset_from_file (project-wide, shared by all videos);
    always set an AI-facing "description" so future agents know what the media depicts.
  - The user sees the graph update live in the app while you work.

Other topics: "workflow-json", "models", "model:<id>", "prompting:<id>", "doctrine", "scenario", "casting", "continuity", "speech", "timeline", "styles", "designs", "shots", "templates", "template:<id>".`

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

const SCENARIO = `The scenario — what you write BEFORE the plan and the graph.

A brief ("20 s, a courier chased through the city, Blade Runner 2049 look") is not a shot list, and
going straight from one to the other is how the constraints get discovered too late: beats of 2-3 s
that no video model will render, seven 4 s shots that quietly turn a 20 s script into a 28 s film,
and every shot prompt written in isolation so the cuts do not connect.

write_scenario is that missing step. YOU write the beats — the creative work stays yours — and it
returns the shot list made legal and chained:

  beats[] (what the script says)              shots[] (what the model can deliver)
  ├ title        short beat name              ├ key             "shot-01", reusable as the node key
  ├ action       what happens                 ├ seconds         a length the model ACCEPTS
  ├ seconds      what the script asks         ├ requestedSeconds what the script asked
  ├ camera       camera intent                ├ opensOn         explicit, or handed over by shot N-1
  ├ sound        dialogue and sound           ├ closesOn        what shot N+1 will open on
  ├ opensOn      entry frame (optional)       ├ mergedFrom      the beats folded into this shot
  ├ closesOn     EXIT frame — write it        ├ promptScaffold  the continuity paragraph to build on
  ├ screenDirection  which way it travels     └ roles           the cast roles appearing in it
  ├ roles        cast roles in this beat
  ├ boardDriven  a board will be wired here
  └ mergeWithNext  fold into the next beat

What it enforces, so you never have to remember it:
  - DURATIONS. Beats under the model's floor are either run at the floor (shortBeatPolicy
    "stretch", the default — keeps your cut list, adds seconds) or folded into a neighbour
    ("merge" — keeps the film's length, changes the cut list). A beat over the ceiling is split
    into legal parts. Everything is snapped to the model's step (Seedance 1.5: 4/8/12 only).
    Nothing ever comes back as a clip the API refuses.
  - THE TOTAL. Pass targetSeconds and the drift is computed for you. Never hide it: say
    "your 20 s script comes out at 28 s — cut a beat, or accept 28 s" and let the user decide.
  - THE CUTS. Each shot's opensOn is the previous shot's closesOn unless you wrote one. That is
    what makes two clips read as one sequence (docs "continuity"). Write closesOn on every beat:
    a missing one comes back as a warning, because the next shot then has nothing to open on.
  - SCREEN DIRECTION. A subject travelling left-to-right followed by one travelling right-to-left
    is flagged — that reversal reads as a different scene. It is a warning, not a fix: some
    reversals are deliberate.

FROM THE SCENARIO TO THE GRAPH — build_graph_from_scenario, not a hand-written payload.

Everything a shot preset asks for is already in the shot: the camera line, the legal duration,
the opening and closing frames, the screen direction, the sound. build_graph_from_scenario reads
them and creates one shot-preset node per shot — the camera move matched from the \`camera\` line
("travelling avant" → push-in, "gros plan" → reaction close-up), the duration carried into BOTH
the param and the prompt's beat timeline, the frames written in — then casts the roles each shot
named onto exactly those shots. One undo step, no credits, nothing runs.

  - It is DETERMINISTIC. The same scenario builds the same graph, which is the point: the
    decisions were made in the scenario, where they were cheap to change.
  - Write \`camera\` on every beat, in either language. It is what picks the preset; without it
    the builder falls back on the shot's place and length and says so.
  - Write \`roles\` on every beat, naming the roles from list_castings. WHO is in a shot cannot be
    derived from the script. A name the cast does not know comes back in \`unknownRoles\` — it is
    reported, never fatal.
  - Read what comes back: \`reason\` per shot (which words chose the preset), \`notes\` (a preset
    the model cannot run and what replaced it, a missing closing frame), \`skipped\`. Report them.
  - Re-running only adds the shots that do not exist yet, so extending a scenario is safe.
  - Then edit what the plan got wrong (change_node_params / replace the preset) instead of
    rebuilding the graph by hand.

How to use it:
  1. Read the brief. Ask only what you cannot infer (length, ratio, tone).
  2. list_models → pick the video model, note its duration min/max.
  3. write_scenario with the beats — including \`camera\` and \`roles\`. It is stored on the video
     and shown to the user in the editor's Scenario panel, so it survives the conversation.
  4. Report the warnings in plain language and let the user arbitrate anything editorial
     (a total that drifted, a merge that changes the cut list).
  5. build_graph_from_scenario (plan_only first if the user wants to see it) — that is the graph.
     Hand-write an import_workflow payload only for a graph the presets cannot express; when you
     do, write each prompt ON TOP OF the shot's promptScaffold (it carries the cut, the frames,
     the screen direction and — when boardDriven — the anti-grid guard) and reuse each shot's
     \`key\` as the node key so the graph and the scenario stay readable together.
  6. get_scenario reads it back later ("reprends le plan 3"): the scenario stays the reference,
     the graph is its realization. Rewriting it replaces it wholesale.`

const CASTING = `The CAST — persistent named identities, project-wide.

The library already records what a sheet IS (designId: "a character sheet") and what it depicts
(designSubject: "Léa, 20, pink hair"). It never records who that is for the FILM. Without that,
"the girl with pink hair" is re-described from scratch in every prompt, and every re-description is
a chance for the model to drift. The cast is the missing sentence: LÉA IS THIS SHEET.

What a role buys you, that a sheet alone does not:
  - a NAME the prompts carry between shots — a model told "@Image1 is the character sheet" keeps a
    look, a model told "@Image1 is LÉA" keeps a person;
  - ONE place to re-point when the sheet is regenerated (update_casting), instead of hunting the
    shots that referenced the old one;
  - standing direction ("always wears the red scarf") folded into every role sentence, written once.

THE LOOP
1. Generate and get the user to approve a design sheet (docs "designs").
2. publish_design it into the project library.
3. create_casting(projectId, name, assetId, notes?) — do this as soon as the sheet is approved. The
   name is what every later prompt will carry, so use the name the user uses.
4. cast_role(videoId, castingId) on each video the role appears in.

CAST_ROLE, precisely. It wires the role's sheet as a reference on every SHOT of the video and
appends the identity sentence to each prompt, in ONE undo step:
  "@Image1 is LÉA (Léa, 20, pink hair) — the same face, hair, build and proportions as the sheet, in
   this shot and in every other shot LÉA appears in. The sheet is a REFERENCE: it must never appear
   on screen as a frame or a panel."
  - It creates ONE studio/asset node for the sheet and fans it out — and reuses a node already on
    the canvas rather than adding a second one.
  - It is IDEMPOTENT. Calling it twice reports the shots in "alreadyCast" with the alias they
    already answer to; it never double-wires and never appends a second sentence.
  - It skips rather than overruns: a shot whose reference handle is full (Seedance 2.0: 9 images, 2.5: 30), or
    whose model has no reference input at all (Seedance 1.5, Grok — there a role stays consistent
    by re-anchoring every shot on the same clean still), comes back in "skipped" with a reason.
  - Default targets are the video's shots. Name nodeIds explicitly to cast onto a still — a
    storyboard is built FROM the sheets and wants the role too.
  - plan_only: true is a free dry run. Use it to tell the user what would be touched before doing it.

NOT the same thing as link_shots (docs "continuity"). Casting keeps a PERSON identical across cuts;
continuity keeps two consecutive CLIPS reading as one sequence. A film usually wants both, and they
compose: cast every role, then chain only the cuts that need the previous clip's grade.

remove_casting forgets the name only — shots already cast keep their reference and their prompt.
Re-pointing a role at a new sheet does not rewire what is already wired: run cast_role again.`

const SPEECH = `Speech (§8) — ElevenLabs voice-over and dialogue, and the channel's voice personas.

TWO MODELS (both audio nodes, both on the ElevenLabs key set in Integrations):
  - elevenlabs/text-to-speech: ONE voice reads the prompt (Eleven v3). Params: voiceId,
    stability (creative | natural | robust), languageCode. Audio tags in brackets color the read:
    [whispers], [laughs], [excited]. Punctuation is the pacing instrument.
  - elevenlabs/text-to-dialogue: several voices in ONE audio. The prompt is a script — one
    "Name: line" per cue (unprefixed lines continue the previous cue); the voiceMap param maps
    each speaker: one "Name = voice_id" line. Max 10 voices, ≤2000 chars per run — split longer
    scenes into several nodes at natural beats.

Runs are SYNCHRONOUS (a few seconds) and every success stores a TRANSCRIPT on the generation:
the spoken text with per-segment [m:ss] timestamps (speaker labels on dialogue). Read it with
get_transcript(nodeId) and reuse it for subtitles, matching shots to narration beats, trimming
clips to the voice, or the YouTube description.

MAKING A FACE SPEAK — two models, by what you start from:
  - An EXISTING clip whose character must say an exact line: volcengine/video-to-video-lip-sync
    re-animates the speaker's mouth to match a speech track. Wire the clip into video_url and the
    ElevenLabs node's output into audio_url (pure vocals work best — enable separate_vocal if the
    audio carries music/noise). No prompt; the output duration follows the audio (the clip is
    trimmed or looped).
  - A STILL portrait (people, pets, anime): omnihuman-1-5 animates the whole performance from the
    audio, lip-synced. Wire a clean portrait into image_url (a frame anchor — never a design
    sheet) and the speech into audio_url (≤60 s, ≤15 s reads best); the optional prompt only
    directs emotion/gesture/camera.
Details: docs "model:volcengine/video-to-video-lip-sync" and docs "model:omnihuman-1-5".

VOICE PERSONAS — the consistency mechanism. A persona names an ElevenLabs voice app-wide:
"Narrateur IS voice X", optionally pinned to a niche (the YouTube channel). Same doctrine as the
visual cast (docs "casting") but for who SPEAKS instead of who appears:
  1. list_elevenlabs_voices(search?) to find or verify a voice id (custom clones included).
  2. create_voice_persona(name, voice_id, description?, niche_id?) once the user picks it.
  3. Every later video: list_voice_personas first, then write the persona's voice id into the
     TTS voiceId or the dialogue voiceMap ("Léa = <the persona's voice id>"). The name in the
     script should BE the persona name — that is what keeps A/B/C characters recognizable
     across every video of the channel.
delete_voice_persona forgets the name only; nodes keep the ids already written.

RENDER. Speech nodes ride their own timeline lane (audioRole: speech), mixed OVER the Suno
music bed and the clips' own audio — never concatenated after the music. Order/trim them like
any clip (set_timeline_order, set_clip_trim); the transcript's timestamps tell you where to cut.
Per-track gain: set_clip_volume(nodeId, 0–2) on any audio node (preview + render). Free
placement: set_audio_offset(nodeId, seconds) starts a track at an absolute point of the film
(null = chained after the previous track; overlapping tracks mix). At render time,
render_video accepts captionsPreset (classic | pop | karaoke) to burn dynamic captions from
the speech transcripts' REAL timings, and duckMusic: true to lower the music bed inside the
spoken windows — the two staples of a narrated short.

TIP for a narrated YouTube video: write_scenario first, one TTS node per narration block (or one
dialogue node per scene), generate the speech EARLY — the transcript's real timings are better
shot-duration ground truth than any estimate.`

const CONTINUITY = `Making consecutive shots read as ONE sequence — the transition problem.

The symptom: shot 3 is a courier weaving through traffic, shot 4 is a pursuer jumping onto a
scooter. Same character sheet, same style, same storyboard — and the two clips still look like two
different films. Nothing ever told shot 4 what shot 3 ended on.

Four layers, in this order. The first three are free (they are prose and cheap images); only the
last one costs generation time.

1. SHARED REFERENCES — always. The same character/décor/prop sheets wired as @Image references on
   EVERY shot of the sequence, each with its role in the prompt. This is what keeps identity and
   art direction stable. It is necessary and it is never sufficient: it says who and what, never
   where in frame, moving which way, coming from which shot.

2. THE TRANSITION CONTRACT — always, it is only words. Every shot prompt states:
     - the frame it OPENS ON: where the subject sits in frame, which way it is already moving,
       what the previous shot handed over;
     - the frame it CLOSES ON: the state the next shot has to pick up.
   Then shot N+1's opening restates shot N's closing, in its own words. Two rules go with it:
     - SCREEN DIRECTION is continuous across a cut: a subject travelling left-to-right keeps
       travelling left-to-right in the next shot, unless the script explicitly turns it around.
       A reversal reads as a different chase, which is exactly the bike/scooter failure above.
     - The 180° LINE: two shots of the same action stay on the same side of the axis. Crossing it
       makes the two clips read as two unrelated scenes.
   Also name the cut itself when it carries meaning ("hard cut on the impact", "cut on the
   movement — she exits frame right, the next shot picks her up entering frame left").

3. SHOT BOARDS — when a cut keeps coming out wrong, or when the shots are short. docs "designs",
   recipe "shotboard": a 2x2 grid of 4 panels for ONE shot — panel 1 is its exact opening frame,
   panels 2-3 the action, panel 4 its exact closing frame. Board shot N and shot N+1, write shot
   N+1's panel 1 as shot N's panel 4, and the hand-off is decided on a cheap image instead of on
   two video generations. On short clips (4-6 s) this is strictly better than a 9-panel scene
   storyboard, which spares each clip a single panel. Wire it like any board: a reference, with a
   role, plus the anti-grid guard. A scene storyboard and a shot board coexist happily —
   the storyboard covers the sequence, the board covers the cut.

4. THE PREVIOUS CLIP AS AN @Video REFERENCE — the strongest layer, and the one with a bill.
   link_shots wires each clip into the next shot's reference_video_urls and appends the role
   ("@Video1 is the PREVIOUS shot — match its lighting, grade, wardrobe, set and character
   appearance; do NOT continue its action or camera: this shot is a CUT to a new setup"). The
   previous CLIP carries what no still can: grade, texture, wardrobe detail, voice. Costs, say
   them to the user before proposing it:
     - the batch SERIALIZES — shot N cannot start before N-1 has settled;
     - re-rolling a shot invalidates every shot chained after it;
     - the handle has a budget (Seedance 2.0: 3 files / 15 s combined, 2.5: 10 files / 30 s) — link_shots skips the links
       that would overrun it rather than sending a run the provider will refuse.
   Reach for it on the cuts that matter (a continuous action across two clips, a character seen
   twice in a row), not on every pair of a long sequence.

WHAT IS NOT CONTINUITY: wiring a clip's "lastFrame" into the next clip's image input. A generated
closing frame is motion-blurred and compressed; the next clip re-interprets a degraded still and
the seam pops — warping faces, sliding backgrounds, a visible hitch. Between shots you CUT. The
@Video reference above is the supported way to carry a clip forward, precisely because it guides
instead of becoming a frame.

SHOT LENGTH, before any of this: every video model has a floor (docs "model:<id>" prints the
allowed range — Seedance 2 refuses anything under 4 s) and a ceiling (Seedance 2.0 tops out at
15 s; Seedance 2.5 reaches 30 s, so a whole 2-3-shot scene can be ONE generation there — but ~3
cuts per generation is still the consistency limit). A script beat shorter than the floor is
MERGED with its neighbour, or covered by a longer shot that contains it. Never round it down into
a clip the API refuses, and never silently stretch every 2-3 s beat to 4 s without saying what it
does to the total: seven 4 s shots is a 28 s film, not the 20 s the script asked for. State the
resulting total and reconcile it with the brief.`

function modelsIndex(): string {
  const lines = MODELS.map(
    (m) =>
      `${m.id}  [${m.kind}]  ${m.label} — ${m.description.split('.')[0]}. (recommended for: ${m.recommendedFor.join(', ')})`
  )
  return `Available models (details: docs "model:<id>"):\n${lines.join('\n')}\nPlus "studio/asset" — a node that outputs a project asset (params: {"assetId"}).

CHOOSING A VIDEO MODEL — image inputs have TWO different semantics; mixing them up is the #1 workflow bug:
  - FRAME ANCHORS (seedance-1.5-pro "input_urls", grok "image_urls"): connected images APPEAR in the
    video literally (first frame / first+last). Wire clean scene stills and hero shots here.
    NEVER a character sheet, storyboard or style board — it would show up on screen.
  - REFERENCES (seedance-2-fast "reference_*"): connected sources GUIDE identity/style/motion and do
    NOT appear on screen, unless the prompt assigns a frame role ("@Image1 as the first frame").
    Character sheets, storyboards and style boards belong HERE, with an explicit role in the prompt.
    On Seedance 2 the three modes — first frame only, first+last, @ references — are mutually
    exclusive per run.
Recipes:
  - Between shots, CUT — do NOT chain. Wiring a clip's "lastFrame" into the next clip looks like
    continuity and glitches in practice: a generated closing frame is motion-blurred and compressed,
    so the next clip re-interprets a degraded still and the seam pops. Make every new clip a cut to a
    new camera setup (say so in the prompt: "New camera setup: this is a cut, not a continuation")
    and carry consistency through SHARED references instead.
  - Real continuity, when it is genuinely required (a character speaking across two clips, an
    unbroken move): video extend on Seedance 2 — previous CLIP into reference_video_urls (@Video1)
    plus "[cut]"-separated next beats. It carries set, identity and voice; a closing still carries none.
  - Re-anchoring is not chaining: pointing several shots at the SAME clean source still (hero shot,
    scene still) is the right way to keep a subject identical on models without references (1.5, Grok).
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
              `  - "${h.key}" accepts ${h.accepts.join('/')}${h.required ? ' (REQUIRED)' : ''}${h.multiple ? ' (multiple)' : ''}${h.maxCount ? ` (max ${h.maxCount})` : ''}${h.maxTotalSeconds ? ` (≤${h.maxTotalSeconds}s combined)` : ''}${h.frameAnchor ? ' — FRAME ANCHOR: the image appears on screen' : ''}${h.referenceAlias ? ` — sources addressable in the prompt as ${h.referenceAlias}1, ${h.referenceAlias}2… (connection order)` : ''}`
          )
          .join('\n')
  const params = m.paramFields
    .map((f) => {
      const opts = f.options ? ` options: ${f.options.map((o) => o.value).join('|')}` : ''
      const def = f.defaultValue !== undefined ? ` default: ${JSON.stringify(f.defaultValue)}` : ''
      // Numeric bounds are an API contract, not a UI hint: a value outside them
      // is rejected at run time (clips shorter than the model's floor).
      const range =
        f.min !== undefined || f.max !== undefined
          ? ` allowed: ${f.min ?? '-∞'}..${f.max ?? '+∞'}${f.step && f.step > 1 ? ` step ${f.step}` : ''}`
          : ''
      return `  - "${f.key}" (${f.type})${def}${range}${opts}${f.description ? ` — ${f.description}` : ''}`
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

/** One recipe entry: its modes, its fields and the prompt they build. */
function recipeEntry(r: Recipe): string {
  const mode = defaultModeOf(r)
  const prompt = buildRecipePrompt(r, mode.modelId, { values: {}, mode })
  const fields = recipeFieldsFor(r, mode)
    .map(
      (f) =>
        `  ${f.key}${f.required ? ' (required)' : ''} — ${f.type}${
          f.options
            ? `: ${f.options.map((o) => o.value).join(' | ')} (default ${f.defaultValue})`
            : ''
        }`
    )
    .join('\n')
  const modes = r.modes
    .map(
      (m) =>
        `  ${m.id} → ${m.modelId}${
          m.source
            ? ` · needs a source ${m.source.accepts} (wired to the model's ${m.source.role} input)`
            : ''
        }`
    )
    .join('\n')
  const extraFields = r.fields
    .filter((f) => f.modes && !f.modes.includes(mode.id))
    .map(
      (f) =>
        `  ${f.key} (mode ${f.modes!.join('/')}) — ${f.options?.map((o) => o.value).join(' | ')}`
    )
  return `── ${r.id} — ${r.label}
${r.description}
Modes:
${modes}
Fields (values):
${fields}${extraFields.length > 0 ? `\n${extraFields.join('\n')}` : ''}
Supported models: ${r.supportedModels.join(', ')}${r.params ? ` · params: ${JSON.stringify(r.params)}` : ''}
Node intent: ${recipeIntent(r)}
Prompt with no values (${r.slot} is replaced by "description"):
${prompt}`
}

function designsIndex(): string {
  const entries = DESIGN_RECIPES.map(recipeEntry)
  return `Design recipes — reusable design sheets. Create one with add_recipe_node
({"recipeId", "values": {"description": ...}}), NOT by hand: it builds the prompt for the target
model and the video's style, sets the markers the app reads (designId, applyVideoStyle), and in a
"from-image" mode it also creates and wires the source node in one undo step.
CRITICAL: a design node's output is a REFERENCE — wire it to reference inputs only (e.g. Seedance 2
"reference_image_urls" with a role in the prompt like "matches the design @Image1, reference only"),
NEVER to a frame-anchor input (seedance-1.5 "input_urls", grok "image_urls") where it would appear
on screen.

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

function shotsIndex(): string {
  const entries = SHOT_RECIPES.map(recipeEntry)
  return `Shot presets — pre-configured VIDEO nodes: the camera move is already written for the
models that honor it, so you pick a move instead of re-deriving each model's motion vocabulary.
Create one with add_recipe_node ({"recipeId", "values": {"description": ..., "opensOn": ...,
"closesOn": ..., "screenDirection": ...}}). Every preset's prompt already says how the shot moves,
which is what the "video-prompt-without-motion" lint rule asks for.

The values that carry continuity are "opensOn", "closesOn" and "screenDirection": two clips only
read as one sequence if each prompt states the frame it OPENS ON and the one it CLOSES ON and the
screen direction holds across the cut. A scenario (write_scenario) already produces those per shot —
pass them straight through.

Between shots you CUT, never chain: do NOT wire the previous clip's lastFrame into the next shot's
image input (a generated closing frame is motion-blurred and compressed, so the seam glitches).
Consistency comes from the SAME design sheets wired on every shot. When you truly need continuity,
use the "shot-extend" preset (or link_shots): the previous CLIP becomes an @Video reference, which
carries set, identity, grade and voice — at the cost of serializing the batch.

A "from-image" mode wires its source to the model's FRAME ANCHOR: that image literally becomes the
opening frame, so it must be a clean scene still or hero shot — never a design sheet, never a panel
board.

${entries.join('\n\n')}`
}

function doctrineIndex(): string {
  const declarations = CAPTURE_DECLARATIONS.map(
    (d) =>
      `── ${d.id} — ${d.label}\n  register: ${d.mode} · camera: ${d.doctrine} · booster: ${d.boosterId}\n  ${d.text}`
  ).join('\n')
  const brackets = ['handheld', 'controlled', 'aerial', 'specialist', 'kinetic']
    .map(
      (family) =>
        `  ${family}: ${CAMERA_MODES.filter((m) => m.family === family)
          .map((m) => m.bracket)
          .join(' ')}`
    )
    .join('\n')
  const fov = FOV_STEPS.map((f) => `  ${f.degrees}° (${f.mmEquiv}) — ${f.purpose}`).join('\n')
  const lexicon = ANTI_AI_TERMS.map(
    (t) => `  "${t.term}" (hurts in: ${t.modes.join(', ')}) → ${t.instead}`
  ).join('\n')

  return `The prompting doctrine for moving images. Three ideas, in this order: what KIND of footage
this is, WHO is holding the camera, and what is GOING WRONG. Everything below descends from them.

1. THE OPENING DECLARATION is the highest-leverage element of a video prompt. The first 15-40 words
are a domain selector: naming a medium, an era and a provenance pulls one coherent slice of footage,
and grain, motion physics, framing habits, lighting behaviour and wardrobe logic arrive together
already agreeing with each other. YOU DO NOT WRITE IT: the app prepends the declaration of the
video's style at payload time (and appends the matching booster stack), for every visual node whose
params carry "applyVideoStyle": true. Write the BODY — the bracketed timeline — and set the video's
style with set_video_style. Never open a prompt with adjectives of quality.

2. THE CAMERA IS A BODY OR A GHOST, never both, and mixing them is a BLOCKING lint finding
("camera-doctrine-mixed"): the model resolves the contradiction by giving neither.
  - embodied — do not describe the camera, describe the PERSON holding it: their position, their
    motive, their physical state, and what that does to the frame. Give them an arc (composed →
    startled → out of breath), a motive for every move, and let them lag: real operators are always
    half a beat behind. "the operator flinches and the frame drops, then recovers" beats "shaky cam".
  - disembodied — declare the absence of a body ("never a person's viewpoint, never part of the
    scene"), then grant weightlessness, agency (the camera may ABANDON the subject and come back)
    and rhythm. Score impacts as event → named camera answer, varying direction.

3. IMPERFECTION, most to least important: motion (shake, drift, lag, overshoot — the number-one tell
and the one everyone forgets), optical, exposure, sensor, human. Grain on a stabilized clip still
reads as AI. For any human subject in a realism register, state the anti-beauty lock:
"${ANTI_BEAUTY_LOCK}"

THE TIMELINE. Ranges with a bracketed camera mode, ONE camera behaviour and ONE primary subject
action per beat (background life encouraged, a second subject action not). 5s → 2-3 beats, 10s →
3-4, 15s → 4-6. Escalate: establish → develop → turn → payoff → aftermath. Only ONE element may be
fast in a beat. End on an aftermath beat (realism — real footage does not cut on the beat) or a
locked hero frame with residual motion inside it (stylized).

  0-3s: [Close Handheld Tracking] one action. one camera behaviour. one atmospheric detail.
  3-7s: [Unsteady Following Shot] ...

CAMERA MODE BRACKETS (verbatim, and the kinetic family requires the ghost):
${brackets}

OPTICS. FOV in DEGREES from these steps only — never millimetres, never an arbitrary value:
${fov}
Shot sizes: ${SHOT_SIZES.map((s) => `${s.abbr} (${s.inFrame})`).join(', ')}.
White balance in Kelvin (${WHITE_BALANCE_KELVIN.join(' / ')}), fixed within a scene.

MEASURE EVERYTHING. Speeds in km/h. Atmosphere in percent and metres ("fog density 40%, visible at
15 m"), escalating in steps across shots. Scale by human comparison ("as tall as four humans stacked
head to toe"), never "huge". Left/right is from the camera. Emotion through muscle movement, never a
label. Colour as material + light beam + role, never a flat list.

UNCONTROLLED LIFE. Plant at least one event nobody staged per shot — a background incident, a
near-miss the subject physically reacts to, third-party life, weather doing its own thing. AI footage
contains only what was requested, which is why it feels obedient and dead.

MATERIAL PHYSICS. Never awe, always mass: name the materials, the contact events and the
consequences. Destruction is an ORDERED disassembly — a direction, named layers in order, a per-layer
failure mode, a terminal state — held close and tight, never "it explodes".

ANTI-AI LEXICON (register-aware — the lint only complains where the term actually hurts):
${lexicon}
Positive phrasing for action and blocking, always. It relaxes ONLY for grade families and rendering
modes (three short negatives maximum, at the end) and for the camera negation, which is load-bearing.

SPEED RAMPS. Declared as the governing style in the OPENING or they are flattened to one average
speed ("speed-ramps-undeclared"). Four maximum in 15 s, never two in the same direction back to back.
Uppercase marks the INSTANT of change (SNAP IN, CRASH ZOOM, HOLD) — ${MAX_CAPS_TRANSIENTS} maximum,
past that they stop reading as beats.

CONTEXT ISOLATION. Every generation is a blank slate. A prompt is a sealed single-shot document: no
scene numbers, no "as above", no unused tags, no people from a previous shot. To continue a clip,
restate everything — location, weather, grade, character state carried forward physically (wet stays
wet, torn stays torn) — and use the "shot-extend" preset so the previous CLIP rides as @Video1.

CAPTURE DECLARATIONS (one per art direction — docs "styles" maps styles to these):
${declarations}

The shot presets (docs "shots") already obey all of this: they emit a bracketed timeline in the
register of the video's style. Prefer add_recipe_node over writing a shot prompt by hand.`
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

const NICHES = `YouTube niche research (§7) — find under-served topics, watch the channels that own
them, and turn what works into briefs for new Raccord videos and channels.

THE OBJECT. A niche is an app-level watchlist: tracked channels (competitors AND the user's own,
flagged is_mine) plus the videos tracked for both. Its "description" is the positioning brief — a
living document the assistant maintains (update_niche) with the angle, the formats that work, and
channel-identity conclusions.

THE SCORE — three lenses, combined in list_niche_videos's "signal":
1. ratio = views / channel subscribers. ≥ 10 is a strong niche signal (a small channel pulling big
   views means the TOPIC carries, not the brand), ≥ 2 is interesting, null means hidden/zero
   subscribers with views — treat as very strong. Finds SMALL channels breaking out.
2. channel_ratio = views vs the channel's own median over its tracked videos (needs ≥ 3). A ×5 is
   a strong outlier WHATEVER the channel size — this is how you use giant competitors: their ×5+
   videos reveal the topics that overperform even a huge baseline. ≥ 2 is interesting.
3. views_per_day = velocity. Measured between refreshes once snapshots accumulate (every refresh
   stores a time-series point), lifetime average as fallback — a high velocity on a recent video
   means "taking off NOW", the freshest demand signal of the three.
The detector defaults: small channel (≤ 100k subs) + young channel (≤ 12 months) + long-form +
ratio sort. Also stored per video: like/comment counts, the competitor's own SEO tags and
category, the declared language, has_captions, and the SERP rank a paid search found it at.

THE HUNT (niche_keyword_search). DataForSEO scrapes the real YouTube SERP — native filters
included via search_param presets: relevance, views, date, viewsThisYear, viewsMonthLong, and
nicheHunt (sort by views + 4-20 min + this year — the good default). It is billed per 20 results;
the YouTube enrichment behind it is nearly free (1 quota unit per 50 ids). Pass save=true to keep
the hits in the niche (source "search", keyword recorded).

THE ITERATION LOOP. (1) refresh_niche — fresh channel stats, latest uploads, updated view counts
(free, do it at the start of a session). (2) fetch_niche_transcripts — captions of the tracked
videos, most-viewed first. (3) Read: get_niche for per-channel aggregates (avg/median views, upload
cadence), list_niche_videos for the scored list, get_niche_video for full description + transcript.
(4) Compare is_mine channels against the rest: which topics/titles/formats outperform, where the
user's own videos sit against the niche median. (5) Write conclusions into the brief (update_niche).

THE ROADMAP (§7b) — where analysis becomes production. Each niche carries a roadmap of videos to
make (list_roadmap / add_roadmap_item / update_roadmap_item / assign_roadmap_item /
mark_roadmap_published). An item is a GROUNDED idea: YouTube title, one-line angle, evidence
(the tracked videos proving demand — ALWAYS cite ratio and views, an idea without numbers is an
opinion), a YouTube description draft, and a thumbnail_brief (subject + exaggerated emotion +
2-4 word overlay text).

PACKAGING-FIRST (§7c). The pros (MrBeast, Colin & Samir doctrine) write MANY title+thumbnail
pairs BEFORE producing anything: the click is decided at ideation, not in the edit. So every
roadmap item also carries title_variants (5-10 candidates, different PROMISES — not rewordings
of one promise). The user promotes their pick in the UI, and previews the packaging in a mock
YouTube feed built from the niche's real thumbnails (the standard a candidate must beat). After
assignment, generate 2-4 thumbnail variants (run_node with variants) and let the user pick; the
chosen image can be exported to a file for the YouTube upload from the feed preview.

STARTING A NICHE FROM SCRATCH ("I want to launch a channel about X"):
1. create_niche, then map the demand for FREE: youtube_keyword_suggestions on the seed, then on
   the promising suggestions recursively — autocomplete is what people actually type. Cluster the
   results into sub-niches (formats, audiences, intents).
2. Spend niche_keyword_search (paid, per 20 results) ONLY on the best 2-3 keywords, nicheHunt
   preset. From the results, add_niche_channel the recurring strong channels (high ratio, several
   hits) — the SERP told you who owns the niche.
3. refresh_niche → the analysis below takes over. Conclusions (chosen sub-niche, channel identity,
   production profile) go into update_niche.

THE SUGGESTION METHOD, when asked for video ideas:
1. refresh_niche, then fetch_niche_transcripts.
2. get_niche — compare is_mine channels against competitors (aggregates: median views, cadence).
3. list_niche_videos sorted by ratio — the outliers are the demand signal. Read the top ones in
   full (get_niche_video): mine their transcripts for hooks, structure, pacing.
4. GAP ANALYSIS: topics that overperform for competitors and that the user's own channels have
   not covered — that intersection is where new videos go.
5. Write 3-5 add_roadmap_item, each complete (title, angle, evidence, description,
   thumbnail_brief). Update the niche brief (update_niche) with durable conclusions.

THE PRODUCTION PROFILE — "what a video of this niche looks like": style_id (docs "styles"),
aspect_ratio, target_seconds, set once via update_niche. assign_roadmap_item then creates (or
links) the workflow with the profile applied — a 'short' item forces 9:16 AND gets a vertical
9:16 thumbnail node — seeds the thumbnail recipe node from the brief, and stamps the video↔item
back-link: from then on, the editor assistant of that video receives the whole niche context
(brief, angle, evidence, target_seconds, channel voices) in its system prompt automatically.
Next steps on the new video: write_scenario (use the angle + the evidence videos' transcripts as
the brief, respect target_seconds) → build_graph_from_scenario.

CHANNEL IDENTITY (for a new channel in the niche): name/title, channel description, and a
profile-image brief — generated right here (add_recipe_node, styleframe/packshot, square).

COSTS. YouTube Data API: free 10k units/day (a full refresh of a 10-channel niche costs ~15
units). DataForSEO: real money per search — never launch a batch of keyword searches without the
user asking. Transcripts: free, but unofficial (YouTube captions) — some videos have none.`

const TIMELINE = `Timeline editing & export (§6.12/§8) — placing clips, audio and overlays on the
FINAL timeline, then rendering the MP4.

TWO READS. get_workflow returns the RAW editing state per node (timelineOrder, trim, transitions,
segments, speed, look, volume, timelineOffsetSec). get_timeline returns the RESOLVED placement:
each entry's start/end/duration in FINAL-timeline seconds (media probed for real durations, trims
and speed applied, transition overlaps subtracted — durationSource says whether a length was
measured, declared or a default), the film's totalSeconds, and the music/speech lanes with each
track's computed start. Always read get_timeline before placing anything by time.

CLIPS. set_timeline_order fixes the sequence; set_clip_trim cuts a window inside the media
(MEDIA seconds — on a 2x clip the timeline shows half); split_clip razors an entry in two;
set_clip_transition joins two entries (each transition SHORTENS the film by its length);
set_clip_speed / set_clip_look / set_still_motion bake per-clip effects.

AUDIO SYNC (the ElevenLabs workflow). Audio nodes land on their lane by model (music = Suno bed,
speech = voice-over/dialogue). Tracks without an offset chain one after another; set_audio_offset
places a track absolutely on the final timeline. To sync a VO on a shot: get_timeline → find the
shot entry's startSec → set_audio_offset(voNode, startSec). For sub-second work inside the audio,
get_transcript's segments carry raw float start/end (MEDIA time of the audio file): the moment a
sentence starts inside the file must be subtracted when computing the offset, or trimmed away
first with set_clip_trim. set_clip_volume (0-2) balances a track; the render can also duck the
whole music bed under speech (duckMusic).

OVERLAYS. add_text_layer / add_image_layer live in absolute FINAL-timeline seconds (get_timeline
tells you where a shot starts); set_clip_overlay burns a text on ONE clip instead.

EXPORT (render_video). Options: quality draft|standard|high, codec h264|hevc, fps, resolution,
burnSubtitles (scenario's quoted dialogue), captionsPreset (classic|pop|karaoke, needs speech
transcripts), duckMusic, watermark. Returns the output path, the real durationSeconds and the
skipped slots. The preview, the FCPXML export and the MP4 all follow the same timeline resolution
— what get_timeline reports is what renders.`

export const DOC_TOPICS =
  'overview | workflow-json | models | model:<id> | prompting:<id> | doctrine | scenario | casting | continuity | speech | timeline | niches | styles | designs | shots | templates | template:<id>'

export function getDoc(topic: string): string {
  if (topic === 'overview') return OVERVIEW
  if (topic === 'workflow-json') return WORKFLOW_JSON
  if (topic === 'models') return modelsIndex()
  if (topic === 'scenario') return SCENARIO
  if (topic === 'casting') return CASTING
  if (topic === 'continuity') return CONTINUITY
  if (topic === 'speech') return SPEECH
  if (topic === 'timeline') return TIMELINE
  if (topic === 'niches') return NICHES
  if (topic.startsWith('model:')) return modelDetail(topic.slice('model:'.length))
  if (topic.startsWith('prompting:')) return promptingGuide(topic.slice('prompting:'.length))
  if (topic === 'styles') return stylesIndex()
  if (topic === 'designs') return designsIndex()
  if (topic === 'shots') return shotsIndex()
  if (topic === 'doctrine') return doctrineIndex()
  if (topic === 'templates') return templatesIndex()
  if (topic.startsWith('template:')) return templateDetail(topic.slice('template:'.length))
  return `Unknown topic "${topic}". Valid topics: ${DOC_TOPICS}`
}
