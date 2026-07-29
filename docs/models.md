# Models — adding one, and how the app consumes them

A "model" is one kie.ai generation capability (an image, video or audio
generator) described declaratively in **one file** under `src/shared/models/`.
That single `ModelDefinition` object drives _everything_: the node UI, the
params form, the run payload, credit estimates, the timeline, the assistant
and the MCP docs. There is no other place to wire a model — if it's in the
registry, the whole app knows it.

Reference implementation to copy from: `seedance-15-pro.ts` (video, every
feature used). Simplest one: `gpt-image-2-t2i.ts` (image, no inputs).
Special-provider example: `suno-music.ts` (dedicated Suno API).

## Checklist for a new model

1. **Create `src/shared/models/<model-name>.ts`** exporting a
   `ModelDefinition<Params>` (fields detailed below).
2. **Register it**: append the export to the `MODELS` array in
   `src/shared/models/index.ts`. Order matters only for display (Add-node menu,
   docs listing).
3. **Align `estimateCredits` with <https://kie.ai/pricing>** — indicative
   per-run rates, declared in the model file itself (see the comment style in
   `seedance-15-pro.ts`).
4. **Write `promptingNotes`** (always) and a **`promptGuide`** (for any model
   where prompt quality matters, i.e. all of them) — this is what the embedded
   assistant and external MCP agents read before writing prompts. Distill the
   provider's official prompt guide, don't improvise.
5. **Tests**: `models.test.ts` already runs registry-wide invariants on every
   entry (unique ids/handles, defaults parse, payload builds). Add
   model-specific cases when the model has non-trivial logic: value snapping,
   conditional schema (see the suno describe block), payload shape.
6. **Run** `pnpm typecheck && pnpm test && pnpm build`.
7. **Verify at runtime without credits**: point `RACCORD_KIE_BASE` at a local
   mock (see CLAUDE.md "Credit-free E2E tests") and run the node from the UI —
   check the payload the mock receives.

No IPC, no migration, no flag, no i18n key is needed: model labels/descriptions
are intentionally not localized (they are product names and provider
vocabulary).

If the model **replaces** an existing one, don't delete the old id: add an
entry to `MODEL_ALIASES` in `index.ts` (old id → new id) so saved workflows
keep running, and remove the old definition. Add an alias test in
`models.test.ts` (see the grok 1.0 → 1.5 case).

## The `ModelDefinition`, field by field

```ts
export const myModel: ModelDefinition<Params> = {
  id, label, description, kind,          // identity
  provider?,                             // 'jobs' (default) | 'suno'
  paramsSchema, paramFields,             // parameters (zod + form)
  inputs, outputs,                       // graph handles
  buildPayload,                          // params+inputs → kie.ai body
  estimateCredits?,                      // indicative cost
  draftEquivalent?,                      // cheap stand-in for draft mode (§6.1)
  promptingNotes?, promptGuide?,         // agent-facing guidance
}
```

### Identity

- `id` — the **exact kie.ai model identifier** (e.g.
  `bytedance/seedance-1.5-pro`). It is sent verbatim to
  `POST /api/v1/jobs/createTask` and stored on every node; never rename it
  without an alias.
- `kind: 'image' | 'video' | 'audio'` — drives the Add-node menu grouping,
  the timeline (only `video` nodes become clips; `audio` nodes go to the audio
  lane), the project "clip count", and FCPXML export.
- `provider` — omit for the unified jobs API. `'suno'` routes through the
  dedicated Suno endpoints in `kie.ts` (flat body, different status polling).
  A new provider = new client functions in `src/main/services/kie.ts` + a
  branch in `checkRemoteStatus`/`submitGeneration` (`runEngine.ts`) — avoid
  unless the API family truly differs.

### Parameters: `paramsSchema` + `paramFields` (keep them in sync)

Two views of the same params, and both matter:

- **`paramsSchema` (zod)** is the _contract_. It validates at run time
  (`prepareRun` rejects the run with a user-visible error), on JSON workflow
  import, and for credit estimation. Give **every field a `.default()`** so
  partial params (imported JSON, older nodes) still parse. Store numbers as
  numbers even when the API wants strings — snap/convert in `buildPayload`
  (see `duration` in seedance: stored `8`, sent `"8"`), because the timeline
  reads `params.duration` (seconds, number) and `params.resolution` /
  `params.aspect_ratio` (strings) directly.
- **`paramFields`** is the _form_ rendered in the node params panel, in
  declaration order. Types: `text`, `textarea` (prompts), `number`
  (min/max/step), `select` (options), `boolean`. `defaultValue` here is what
  `defaultParamsFor()` seeds new nodes with — keep it identical to the zod
  default. `description` becomes the field's help text.

Constraints the API enforces (allowed durations, max prompt length, image
count/size limits) must appear **three times**: in the zod schema (validation),
in the field `description` (human), and in `promptingNotes` (agent).

For a `number` field that means `min`/`max` (and `step` when the API only takes
discrete values) — **not optional**, a registry test fails without them. Those
three numbers are the whole enforcement chain: the params panel clamps typed
values through `clampParamToField`, the prompt lint raises `param-out-of-range`
before the spend, `list_models` and `docs "model:<id>"` publish the range so an
agent never plans a clip the API refuses, and `describeParamsError` turns a run
failure into "Duration (s) must be between 4 and 15" instead of a zod dump.
Same idea for handles: `maxCount` bounds the connections and `maxTotalSeconds`
declares a combined-length budget (Seedance 2: 15 s of reference video), which
the lint checks against the sources' declared durations. A prompt
that is required at run time still gets `.default('')` + a UI default of `''`
— use `.min(1)` so the run fails validation with a clear message instead of
burning credits (see `gpt-image-2-t2i.ts`).

### Image-input semantics: frame anchors vs references (read this twice)

Video models take images in one of two modes, and confusing them is the #1
workflow bug (a storyboard visibly leaking into a clip's opening frames):

| Mode             | Models/handles                                                                                              | Behavior                                                                                                                           | What to wire                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Frame anchor** | seedance-1.5-pro `input_urls`, grok `image_urls`, seedance-2/-fast/-mini `first_frame_url`+`last_frame_url` | The image **appears in the video** (first frame, or first+last)                                                                    | Clean scene stills and hero shots — **never** a previous clip's `lastFrame` |
| **Reference**    | seedance-2/-fast/-mini `reference_image_urls` (+video/audio)                                                | The source **guides** identity/style/motion, never shown — unless the prompt assigns a frame role (`"@Image1 as the first frame"`) | Character sheets, storyboards, style boards, camera-movement videos         |

On the Seedance 2.x family, kie.ai documents **three mutually exclusive modes
per run**: first frame only, first + last frame, and multimodal @ references.
Wire one mode or the other; inside reference mode a frame role in the prompt
(`"@Image1 as the first frame"`) is the documented way to get a first/last-frame
effect, with the dedicated inputs reserved for when the match must be strictly
guaranteed. The family's shared prompt guide lives in
`src/shared/models/seedance2-prompting.ts` (official ByteDance guide + the
"Top 10 Seedance 2.0 Tricks" e-book: lip-sync via blank voice-over videos,
video extend, character swap, in-between technique, omni-reference).

Rules that follow:

- A character design sheet must NEVER be wired to a frame-anchor handle — on
  Seedance 1.5 it becomes the literal first frame. Character consistency across
  shots = Seedance 2 with the key visual wired to every shot's references.
- Templates and assistant-generated workflows must match the wiring to the
  model (see `anime-sequence` vs `product-commercial` in
  `src/shared/templates/registry.ts`: the anime key visual is a _reference_;
  the product hero shot is an _intended_ first frame).
- Every new video model must state its mode explicitly in the handle
  `description` AND in `promptingNotes` — both the UI and the agents read them.
- **Between shots you CUT — never chain.** Wiring a clip's `lastFrame` into the
  next clip's image input reads as continuity on paper and glitches in practice:
  a generated closing frame is motion-blurred and compressed, so the next clip
  re-interprets a degraded still and the seam pops (warping faces, sliding
  backgrounds, a visible hitch). Every shot gets a new camera setup, and
  consistency comes from **shared references** wired on all of them. Two
  exceptions: genuine continuity (dialogue across clips, an unbroken move) uses
  **video extend** — the previous _clip_ into `reference_video_urls` — and on
  models without references (1.5, Grok) several shots may **re-anchor on the same
  clean source still**, which is a pristine image, not a generated frame. No
  template ships a `lastFrame` chain; the handle stays available for manual use.
- Reference numbering (`@Image1`, `@Image2`, …) follows **edge creation order**;
  `importWorkflow` stamps strictly increasing `createdAt` so the template edge
  array order IS the numbering. Keep role-critical edges (character sheet before
  storyboard) ordered accordingly.
- **Transitions are their own problem** (`src/shared/shotContinuity.ts`, docs
  topic `continuity`). Shared references keep identity stable and still leave
  two consecutive clips reading as two different films, because nothing tells
  shot N+1 what shot N ended on. Four layers, cheapest first: shared references
  → the written contract (every prompt states the frame it OPENS ON and the one
  it CLOSES ON, screen direction continuous across the cut, no crossing the
  180° line) → a 4-panel **shot board** per shot (recipe `shotboard`: panel 1 =
  opening frame, panel 4 = closing frame, so the hand-off is decided on a cheap
  image) → the previous CLIP wired as an `@Video` reference (`link_shots`),
  which carries grade/wardrobe/voice but serializes generation and invalidates
  downstream shots on a re-roll. The last one is proposed, never applied by
  default.
- **Storyboard = the pre-visualization step** between design sheets and video
  (Seedance 2.x): one 3x3 grid of 9 numbered panels showing the scene beat by
  beat, built FROM the sheets with `gpt-image-2-image-to-image` (recipe
  `storyboard` in `src/shared/designs/registry.ts`) so identity is locked at
  the storyboard stage, generated at the video's aspect ratio, and reviewed by
  the user before any video credits are spent. It is a _reference_ like any
  design sheet, with its own role in the prompt ("@Image2 is the 9-panel
  storyboard — follow its panels in order, left to right, top to bottom"; on
  multi-shot scenes each shot says which panels it covers) — the video prompt
  then describes motion, not the visuals the grid already encodes. Blueprint:
  `storyboard-sequence` in `src/shared/templates/registry.ts`.

### Graph wiring: `inputs` / `outputs`

- `inputs` — one `InputHandle` per kie.ai _URL_ input field. `key` is both the
  React Flow handle id and the key of `inputs[...]` received by
  `buildPayload`. `accepts` restricts what can be connected (image/video/
  audio). `required: true` blocks the run when unconnected; `maxCount` bounds
  connections (run rejected above it); `multiple` allows several edges.
- `referenceAlias` (e.g. `'@image'`) enables prompt references: the n-th
  connected source becomes `@image<n>` (connection order = edge creation
  time). The UI shows the numbering on the node; the run engine records the
  alias map in the generation's input snapshot. Only for models whose API
  understands such references (grok).
- `frameAnchor: true` — declare it on every image input whose connected images
  APPEAR in the output literally (seedance-1.5 `input_urls`, grok
  `image_urls`). It is machine-readable semantics for the pitfall above: the
  template tests derive the frame-anchor set from it, and the editor warns
  when a design node (`src/shared/designs/registry.ts`) is wired to one.
- `outputs` — usually one `{ key: 'output', kind }`. Video models should also
  declare `{ key: 'lastFrame', label: 'Last frame', kind: 'image' }`: the
  renderer extracts the final frame of every successful video generation in
  the browser (`useLastFrameExtractor`) and `lastFrame` edges resolve against
  that file — this is THE clip-to-clip continuity mechanism, don't omit it.

At run time (`prepareRun` in `runEngine.ts`), each connected source is
resolved to a **public URL** (kie CDN result URL, or the local file uploaded
on demand to kie's File Upload API) and handed to `buildPayload` as
`inputs[handleKey]: string[]`.

### `buildPayload({ params, inputs })`

Returns the exact JSON body for `createTask` (`input` field). Rules learned
the hard way:

- Convert/snap here, not in the schema (schema stays ergonomic, payload stays
  API-exact — string enums, value snapping).
- Always send array inputs as arrays, defaulting to `[]`
  (`inputs.input_urls ?? []`).
- Omit optional fields rather than sending empty strings when the API treats
  presence as intent (see suno's conditional payload).

### `estimateCredits(params)`

Indicative, per-run, derived from the params that drive cost (duration ×
resolution for video). Stamped on every generation as `creditsEstimated` and
summed per project (`projects:creditsUsage`). Keep the rates as named
constants with a comment pointing at <https://kie.ai/pricing>; the kie
dashboard is the authority, this is an order of magnitude. Omit entirely if no
reliable rate is known — the UI then shows nothing (never guess).

The signature takes **params only** — never the wired inputs. When a model
prices a run differently depending on what is connected (the Seedance 2 family
bills a video-input run as `price × (input + output)` seconds at a lower unit
price), quote the no-video rate: it is the higher per-output-second of the two,
so the preview never under-sells the run.

### `draftEquivalent` — draft mode (§6.1)

Optional cheap stand-in used while the video's **draft mode** is on:
`prepareRun` swaps the run to `{ modelId, params?, inputs? }` and stamps the
generation `draft` (the input snapshot records the substituted model, so
retries replay it). Rules, all registry-test enforced:

- the target must exist, have the **same `kind` and `provider`** (polling and
  result handling depend on them), and not chain into another draft;
- `params` overlays the node's params; enum values the target doesn't accept
  fall back to the target's defaults ("resolution floored"). `modelId` may be
  the model's own id when the draft is just cheaper params (Kling `std`,
  gpt-image `1K`);
- every input handle must land on a target handle with the same `accepts` and
  `frameAnchor` semantics — declare `inputs: { originalKey: draftKey }` when
  the target names a handle differently (nano-banana → lite's `image_urls`);
  arrays are clamped to the target handle's `maxCount`.

The pure substitution logic lives in `src/shared/models/draft.ts`
(`resolveDraftRun` / `remapDraftInputs`, unit-tested). A self-substitution
that changes nothing returns null so already-cheap runs are never stamped
draft (finalize would pointlessly re-run them).

### `promptingNotes` and `promptGuide` — the quality lever

These two fields are how agents (embedded assistant + any MCP-connected agent)
learn to use the model _well_; treat them as part of the model, not as an
afterthought.

- `promptingNotes` (short, ~5 lines): what makes this model different — input
  semantics (1 image = first frame…), reference syntax if any, the parameters
  that change behavior, continuity wiring (`lastFrame`). Shown in the node
  params panel AND in the `model:<id>` doc topic.
- `promptGuide` (long form): anatomy of a good prompt in the provider's
  recommended order, camera/audio vocabulary the model actually parses,
  dialogue syntax, multi-shot syntax, pitfalls, one full example. Served
  on demand as the docs topic `prompting:<id>` (`src/main/mcp/docs.ts`) —
  agents are instructed to read it before writing any prompt. Distill the
  provider's official guide and note the source in a comment (see the
  ByteDance reference above seedance's guide).

## How a model flows through the app (map)

| Consumer         | What it reads                                                                  | Where                                                                     |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Add-node menu    | `id`, `label`, `kind` (grouping/icon)                                          | `Toolbar.tsx`                                                             |
| Node rendering   | `inputs`/`outputs` (handles), `label`, `referenceAlias` badges                 | `ModelNode.tsx`                                                           |
| Params panel     | `paramFields`, `promptingNotes`                                                | `NodeParamsPanel.tsx`                                                     |
| Node creation    | `defaultParamsFor()` (paramField defaults)                                     | `graph.ts` / `Toolbar.tsx`                                                |
| Model swap       | params intersected by key, edges re-mapped by `accepts`/`kind`, else dropped   | `replaceNodeModel` in `graph.ts`                                          |
| Run              | `paramsSchema.parse`, `required`/`maxCount` checks, `buildPayload`, `provider` | `prepareRun`/`submitGeneration` in `runEngine.ts`                         |
| Credits          | `estimateCredits` → `creditsEstimated` → per-project totals                    | `runEngine.ts`, `projects:creditsUsage`                                   |
| Draft mode       | `draftEquivalent` → substituted run + `draft` stamp; finalize re-runs          | `shared/models/draft.ts`, `prepareRun`, `runBatch.ts` (`planFinalize`)    |
| Timeline         | `kind === 'video'`/`'audio'`, `params.duration`, `params.resolution`           | `Timeline.tsx` (`collectTimelineClips`, `clipDuration`), `TimelineV2.tsx` |
| Continuity       | `lastFrame` output ← browser-side frame extraction                             | `useLastFrameExtractor.ts`                                                |
| Assistant (chat) | `MODELS` (list_models tool), notes/guides                                      | `chat.ts`                                                                 |
| MCP docs         | `models`, `model:<id>`, `prompting:<id>` topics — all generated                | `mcp/docs.ts`                                                             |
| Library/export   | `kind` (clip counts, FCPXML roles), `label` (clip names)                       | `library.ts`, `exportFcpxml.ts`                                           |

Consequence of the map: **a model file is pure data + pure functions** (shared
module — no Electron, no network, no imports from `main/` or `renderer/`), so
the registry stays testable and usable from both processes.

## Quality bar (review checklist)

- [ ] `id` copied exactly from the kie.ai playground/docs page of the model.
- [ ] Every zod field has a `.default()`; schema parses `{}` plus a prompt.
- [ ] `paramFields` defaults ≡ zod defaults (the invariant test catches most
      drift, but check enums manually).
- [ ] API-side constraints (lengths, enums, counts, sizes) encoded in schema
      **and** written in `description`s **and** `promptingNotes`.
- [ ] `duration` stored as a number of seconds if the model is video (timeline
      dependency), converted in `buildPayload` if the API wants a string.
- [ ] Video model declares the `lastFrame` output.
- [ ] `estimateCredits` cross-checked against kie.ai pricing, with the rates
      as commented constants.
- [ ] `promptGuide` distilled from the provider's official guide (source noted
      in a comment), not invented.
- [ ] Model-specific tests for any snapping/conditional logic in
      `models.test.ts`.
- [ ] Credit-free runtime check against the kie mock (payload inspected).
