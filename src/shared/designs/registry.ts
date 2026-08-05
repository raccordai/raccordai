import type { StyleTemplate } from '../styles/registry'
import {
  clampParamToField,
  defaultParamsFor,
  getModel,
  getModelOrThrow,
  videoDefaultParams,
  type InputHandle,
  type MediaKind
} from '../models'
import { SCREEN_DIRECTIONS, type ScreenDirection } from '../scenario'
import {
  FOV_STEPS,
  SHOT_SIZES,
  WHITE_BALANCE_KELVIN,
  beatCountFor,
  beatRanges,
  bracketFor,
  buildSeedanceBody,
  getCaptureDeclaration,
  getShotSize,
  snapFov,
  type CameraDoctrine,
  type PromptMode,
  type SeedanceBeat
} from '../prompting/seedance'

/**
 * Recipes — the pre-configured nodes of the app. Two kinds share one registry
 * because they share one machine (a form of typed fields → a prompt built for
 * the target model and the video's style):
 *
 *  - `reference` recipes (the historical "design recipes") produce a design
 *    sheet — character, décor, prop, style frame, panel boards. Their output is
 *    a REFERENCE: it guides downstream shots and must never be wired to a frame
 *    anchor. They carry `params.designId` so the editor, the lint and the
 *    design library keep recognizing them.
 *  - `shot` recipes produce a VIDEO node: a camera move and a shot grammar
 *    already written, so the user picks "push-in" instead of learning each
 *    model's motion vocabulary. They deliberately do NOT carry `designId` —
 *    that marker means "this output is a reference sheet" and would fire the
 *    frame-anchor lint and the library promotion on a clip.
 *
 * Everything here is pure data + pure functions (no Electron import): the
 * renderer builds the form, `main/services/recipes.ts` creates the node, the
 * MCP docs are generated from it, and the registry test enforces i18n parity.
 *
 * All agent-facing content is English (prompts perform best in English);
 * UI display names live in i18n under `designs.<id>` and `recipeFields.<key>`.
 */

// ─── Fields ─────────────────────────────────────────────────────────────────

export type RecipeFieldType = 'text' | 'textarea' | 'select'

export interface RecipeFieldOption {
  value: string
  /**
   * The prompt fragment this option injects. It is what makes the form
   * testable: one option = one deterministic sentence, never model-specific
   * jargon the user would have to know.
   */
  fragment: string
}

export interface RecipeField {
  key: string
  type: RecipeFieldType
  /** Blocks creation when empty (only `description` is required today). */
  required?: boolean
  /** Present on `select` fields only. */
  options?: RecipeFieldOption[]
  defaultValue?: string
  /**
   * Restricts the field to the listed mode ids — `preserve` only makes sense
   * when the node is built FROM a source image.
   */
  modes?: string[]
}

/** Field values as the form (or an agent) submits them: key → raw string. */
export type RecipeValues = Record<string, string>

/** Fragment for a screen direction, keyed by the scenario's own vocabulary. */
const SCREEN_DIRECTION_FRAGMENTS: Record<ScreenDirection, string> = {
  'left-to-right': 'the subject travels from left to right across the frame',
  'right-to-left': 'the subject travels from right to left across the frame',
  'toward-camera': 'the subject moves toward the camera',
  'away-from-camera': 'the subject moves away from the camera',
  static: 'the subject holds its position in the frame'
}

/**
 * THE shared field vocabulary. Fields are reused across recipes (a "time of
 * day" is a time of day whether it is a décor or a shot), so their labels and
 * option names live under ONE i18n prefix — `recipeFields.<key>` — and the
 * registry test enforces parity in both directions.
 */
export const RECIPE_FIELDS = {
  description: { key: 'description', type: 'textarea', required: true },

  views: {
    key: 'views',
    type: 'select',
    defaultValue: 'turnaround',
    options: [
      {
        value: 'turnaround',
        fragment:
          'full-body turnaround with three aligned views of the SAME character — front, three-quarter and profile — in a neutral standing pose'
      },
      {
        value: 'five-view',
        fragment:
          'full-body turnaround with five aligned views of the SAME character — front, three-quarter, profile, back three-quarter and back — in a neutral standing pose'
      },
      {
        value: 'bust',
        fragment:
          'bust portrait of the SAME character from three aligned angles — front, three-quarter and profile, shoulders up'
      }
    ]
  },
  wardrobe: { key: 'wardrobe', type: 'text' },
  /** Thumbnail overlay text — 2-4 punch words burned into the image. */
  overlayText: { key: 'overlayText', type: 'text' },
  background: {
    key: 'background',
    type: 'select',
    defaultValue: 'neutral-light',
    options: [
      { value: 'neutral-light', fragment: 'Plain light neutral background' },
      { value: 'neutral-dark', fragment: 'Plain dark neutral background' },
      { value: 'grid', fragment: 'Plain neutral background with a faint proportion grid' }
    ]
  },
  emotions: { key: 'emotions', type: 'text' },
  variants: { key: 'variants', type: 'text' },

  timeOfDay: {
    key: 'timeOfDay',
    type: 'select',
    defaultValue: 'day',
    options: [
      { value: 'day', fragment: 'flat midday daylight' },
      { value: 'golden-hour', fragment: 'low golden-hour sun with long warm shadows' },
      { value: 'blue-hour', fragment: 'blue hour, cold ambient light and lit practicals' },
      { value: 'night', fragment: 'night, lit only by its own practical sources' }
    ]
  },
  weather: {
    key: 'weather',
    type: 'select',
    defaultValue: 'clear',
    options: [
      { value: 'clear', fragment: 'clear air' },
      { value: 'rain', fragment: 'rain, wet reflective surfaces' },
      { value: 'fog', fragment: 'fog thickening with depth' },
      { value: 'snow', fragment: 'falling snow settling on surfaces' }
    ]
  },
  scale: {
    key: 'scale',
    type: 'select',
    defaultValue: 'establishing',
    options: [
      {
        value: 'establishing',
        fragment:
          'wide establishing view showing the whole location — its layout, architecture, materials and key lighting mood'
      },
      {
        value: 'interior',
        fragment:
          'interior view showing the usable space of the location — its walls, furniture, materials and light sources'
      },
      {
        value: 'detail',
        fragment:
          'tight view of the signature corner of the location — the materials and textures that identify it'
      }
    ]
  },

  angles: {
    key: 'angles',
    type: 'select',
    defaultValue: 'three-angle',
    options: [
      {
        value: 'three-angle',
        fragment:
          'the object shown large on a plain neutral background from three angles — front, three-quarter and back — plus one close-up detail inset'
      },
      {
        value: 'exploded',
        fragment:
          'the object shown large on a plain neutral background in one assembled view plus one exploded view naming its parts by shape only'
      },
      {
        value: 'single-hero',
        fragment:
          'the object shown large and alone on a plain neutral background in one three-quarter hero view, plus one close-up detail inset'
      }
    ]
  },
  material: { key: 'material', type: 'text' },

  framing: {
    key: 'framing',
    type: 'select',
    defaultValue: 'medium',
    options: [
      { value: 'wide', fragment: 'wide framing, the subject small in its environment' },
      { value: 'medium', fragment: 'medium framing, the subject from the waist up' },
      { value: 'close-up', fragment: 'close-up framing on the subject' },
      { value: 'extreme-close-up', fragment: 'extreme close-up on a single detail' }
    ]
  },
  lighting: {
    key: 'lighting',
    type: 'select',
    defaultValue: 'soft-key',
    options: [
      { value: 'soft-key', fragment: 'soft key light with a gentle fill' },
      { value: 'hard-key', fragment: 'hard directional key light with crisp shadows' },
      { value: 'backlit', fragment: 'strong backlight separating the subject with a rim' },
      { value: 'low-key', fragment: 'low-key lighting, deep shadows and small pools of light' }
    ]
  },
  lensLook: {
    key: 'lensLook',
    type: 'select',
    defaultValue: 'standard',
    options: [
      { value: 'wide-angle', fragment: 'wide-angle lens look, deep field and slight edge stretch' },
      { value: 'standard', fragment: 'standard lens look, natural perspective' },
      { value: 'telephoto', fragment: 'telephoto lens look, compressed depth and soft background' },
      { value: 'macro', fragment: 'macro lens look, razor-thin focus on the texture' }
    ]
  },
  palette: { key: 'palette', type: 'text' },
  surface: {
    key: 'surface',
    type: 'select',
    defaultValue: 'seamless-white',
    options: [
      { value: 'seamless-white', fragment: 'on a seamless white sweep with a soft contact shadow' },
      {
        value: 'dark-gradient',
        fragment: 'on a dark gradient backdrop with a crisp specular edge'
      },
      { value: 'lifestyle', fragment: 'on a simple lifestyle surface with shallow depth of field' },
      { value: 'floating', fragment: 'floating against a plain backdrop, no support visible' }
    ]
  },

  coverage: { key: 'coverage', type: 'text' },
  /** Optics — the two levers that define "how it is shot". */
  shotSize: {
    key: 'shotSize',
    type: 'select',
    defaultValue: 'ms',
    options: SHOT_SIZES.map((size) => ({
      value: size.id,
      fragment: `${size.abbr} — ${size.inFrame}`
    }))
  },
  /**
   * FOV in DEGREES, only from the anchor table. Millimetres and arbitrary
   * values ("23°") are not written into a prompt — the discrete steps are what
   * the model reads reliably.
   */
  fov: {
    key: 'fov',
    type: 'select',
    defaultValue: '47',
    options: FOV_STEPS.map((step) => ({
      value: String(step.degrees),
      fragment: `${step.degrees}° (${step.mmEquiv}) — ${step.purpose}`
    }))
  },
  /** White balance is set in Kelvin to the scene mood, and fixed within a scene. */
  whiteBalance: {
    key: 'whiteBalance',
    type: 'select',
    defaultValue: '5600',
    options: WHITE_BALANCE_KELVIN.map((kelvin) => ({
      value: String(kelvin),
      fragment: `${kelvin}K white balance, fixed for the whole scene`
    }))
  },
  /** Atmosphere is stated in percent and metres, never as "light fog". */
  atmosphere: { key: 'atmosphere', type: 'text' },
  /**
   * Law 6 — uncontrolled life. Real footage contains events nobody staged; AI
   * footage contains only what was requested, which is why it feels obedient
   * and dead. One unrequested event per shot.
   */
  life: { key: 'life', type: 'text' },
  opensOn: { key: 'opensOn', type: 'text' },
  closesOn: { key: 'closesOn', type: 'text' },
  sound: { key: 'sound', type: 'text' },
  screenDirection: {
    key: 'screenDirection',
    type: 'select',
    defaultValue: 'static',
    options: SCREEN_DIRECTIONS.map((value) => ({
      value,
      fragment: SCREEN_DIRECTION_FRAGMENTS[value]
    }))
  },
  pace: {
    key: 'pace',
    type: 'select',
    defaultValue: 'steady',
    options: [
      { value: 'slow', fragment: 'The move is slow and deliberate' },
      { value: 'steady', fragment: 'The move is steady and even' },
      { value: 'fast', fragment: 'The move is fast and urgent' }
    ]
  },

  /**
   * The golden formula of image editing, made selectable: an image-to-image
   * recipe that never says what to PRESERVE drifts, every time.
   */
  preserve: {
    key: 'preserve',
    type: 'select',
    defaultValue: 'identity',
    modes: ['from-image'],
    options: [
      {
        value: 'identity',
        fragment:
          'Preserve the identity of the source exactly — face, body shape, hair, proportions and likeness. Keep everything else the same.'
      },
      {
        value: 'identity-and-outfit',
        fragment:
          'Preserve the identity AND the outfit of the source exactly — face, hair, proportions, garments and colors. Keep everything else the same.'
      },
      {
        value: 'geometry',
        fragment:
          'Preserve the geometry, layout, materials and colors of the source exactly. Keep everything else the same.'
      },
      {
        value: 'subject-only',
        fragment:
          'Keep only the subject of the source image and its exact design; the background, framing and lighting are rebuilt by this sheet.'
      }
    ]
  }
} satisfies Record<string, RecipeField>

export type RecipeFieldKey = keyof typeof RECIPE_FIELDS

/** Field descriptors by key — the form and the registry test read this. */
export const recipeFieldsByKey: Record<string, RecipeField> = RECIPE_FIELDS

// ─── Modes ──────────────────────────────────────────────────────────────────

/**
 * How the source media reaches the model. Never a hardcoded handle key: the
 * same recipe runs on models that name their inputs differently (Seedance 1.5
 * `input_urls` vs Seedance 2 `first_frame_url`), so the role is declared and
 * `resolveRecipeHandle` derives the key from the model registry.
 */
export type RecipeSourceRole = 'anchor' | 'reference'

export interface RecipeSource {
  role: RecipeSourceRole
  accepts: MediaKind
  required: boolean
}

export interface RecipeMode {
  /** `text` | `from-image` | `from-video` — i18n under `recipeModes.<id>`. */
  id: string
  modelId: string
  /** Omitted on `text` modes: nothing is wired. */
  source?: RecipeSource
  /** Mode-level param overrides, merged over the recipe's. */
  params?: Record<string, unknown>
}

/**
 * The input handle a mode's source must be wired to, derived from the model's
 * declared handle semantics (`frameAnchor`, `accepts`) — never from an id.
 */
export function resolveRecipeHandle(
  modelId: string,
  source: RecipeSource
): InputHandle | undefined {
  const model = getModel(modelId)
  if (!model) return undefined
  const candidates = model.inputs.filter((h) => h.accepts.includes(source.accepts))
  return source.role === 'anchor'
    ? candidates.find((h) => h.frameAnchor === true)
    : candidates.find((h) => h.frameAnchor !== true)
}

// ─── Recipes ────────────────────────────────────────────────────────────────

export type RecipeKind = 'reference' | 'shot'

export interface RecipePromptArgs {
  /** Raw field values, keyed by `RecipeField.key`. */
  values: RecipeValues
  /** The video's style template, when one is set. */
  style?: StyleTemplate
  /** The mode the node is being created in — decides the from-source wording. */
  mode?: RecipeMode
  /**
   * Clip length in seconds, when the caller owns it (a scenario shot's legal
   * duration, §6.11) instead of taking the preset's default. A shot prompt is a
   * TIMELINE — its beat brackets are computed from this — so the number that
   * lands in `params.duration` and the number the beats are written against
   * must be the same one, or a 4 s clip ships with 8 s of bracketed action.
   */
  durationSeconds?: number
}

export interface Recipe {
  id: string
  /** `reference` sheets guide shots; `shot` recipes ARE the shot. */
  kind: RecipeKind
  /** Agent-facing English name; UI display names live in i18n under `designs.<id>`. */
  label: string
  description: string
  /** Placeholder kept in the prompt when no description is given, e.g. "[CHARACTER]". */
  slot: string
  /**
   * True for recipes that produce a PANEL GRID (the 3x3 scene storyboard, the
   * 2x2 shot board, the expression sheet). Machine-readable so the prompt lint
   * can require the anti-grid guard on any shot they feed, without hardcoding
   * recipe ids.
   */
  board?: true
  /**
   * True for sheets that may legitimately BE a frame: a style frame or a
   * pack-shot is routinely wired as the opening frame of a shot. Without this,
   * "produced by a recipe" and "must never appear on screen" are the same flag,
   * and the frame-anchor guard fires an error on a correct, common wiring.
   * Panel boards are never anchor-safe (registry-tested).
   */
  anchorSafe?: true
  /**
   * True when the node's frame IS the film's frame: shots, panel boards, style
   * frames and pack-shots must follow the video's aspect ratio / resolution
   * defaults (a 9:16 project cannot have 16:9 shots). Sheets that are pure
   * reference material — a turnaround, a prop, a wardrobe row — keep the
   * format the recipe chose for legibility.
   */
  followsVideoFormat?: true
  /** Creation modes, most common first — `modes[0]` is the default. */
  modes: RecipeMode[]
  /** The fields the form asks for, in display order. `description` comes first. */
  fields: RecipeField[]
  /** Recipe param overrides, merged over the model's defaults (never over `prompt`). */
  params?: Record<string, unknown>
  /**
   * Param overrides that only apply on some models — the case where a model
   * exposes REAL control for what the prompt otherwise has to ask for in
   * words. Seedance 1.5 locks the camera with `fixed_lens: true`, and its own
   * guide says that is the way to do it, not prompt words: a locked-off preset
   * running there sets the boolean instead of hoping.
   */
  paramsByModel?: Record<string, Record<string, unknown>>
  /**
   * Models this recipe is written for. `modes[0].modelId` is the default; the
   * others are offered as alternatives (a shot preset that reads the same on
   * Seedance 2 Fast and on the full tier). Registry-test enforced.
   */
  supportedModels: string[]
  /** Default prompt builder — must work for any model in `supportedModels`. */
  buildPrompt(args: RecipePromptArgs): string
  /** Per-model overrides for models whose prompt idioms diverge; falls back to buildPrompt. */
  byModel?: Record<string, (args: RecipePromptArgs) => string>
}

/**
 * Kept as the historical name of the reference half — the add-node menu's
 * "Designs" group, the MCP `docs "designs"` topic and the design library all
 * mean this subset.
 */
export type DesignRecipe = Recipe

// ─── Prompt helpers ─────────────────────────────────────────────────────────

/** Joins the non-empty fragments into one prompt paragraph, whitespace-normalized. */
const join = (...fragments: Array<string | undefined | false>): string =>
  fragments
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')

/**
 * The image-specific style fragment baked into the prompt at creation. The
 * style BIBLE is deliberately not baked in: recipe nodes carry
 * `applyVideoStyle: true`, so the run engine appends the video's current
 * bible at payload time (style switches propagate without prompt edits).
 */
const styled = (style?: StyleTemplate): string => (style ? style.imageFragment : '')

/**
 * Blank-line-separated block assembly. `join` collapses every run of
 * whitespace, which is right for a paragraph and fatal for a bracketed
 * timeline — the shot builders use this instead.
 */
const block = (...parts: Array<string | undefined | false>): string =>
  parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n')

/** Free-text value of a field, or undefined when blank. */
const text = (values: RecipeValues, key: string): string | undefined => {
  const raw = values[key]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}

/** The prompt fragment of a `select` field, falling back to its default option. */
const frag = (values: RecipeValues, key: string): string | undefined => {
  const field = recipeFieldsByKey[key]
  if (!field?.options) return undefined
  const raw = text(values, key) ?? field.defaultValue
  return field.options.find((o) => o.value === raw)?.fragment
}

/** The subject line — the description, or the recipe's slot when it is blank. */
const subjectOf = (values: RecipeValues, slot: string): string =>
  text(values, 'description') ?? slot

/**
 * The preservation clause of a from-source mode. An image-to-image node that
 * does not state what must NOT change drifts on every iteration — this is the
 * official GPT Image formula ("Change only X. Keep everything else the same."),
 * turned into a field.
 */
const fromSource = (args: RecipePromptArgs): string | undefined => {
  if (!args.mode?.source) return undefined
  const kind = args.mode.source.accepts === 'video' ? 'source clip' : 'connected source image'
  return join(`Build this from the ${kind}.`, frag(args.values, 'preserve'))
}

// ─── Reference recipes ──────────────────────────────────────────────────────

const F = RECIPE_FIELDS
const IMAGE_T2I = 'gpt-image-2-text-to-image'
const IMAGE_I2I = 'gpt-image-2-image-to-image'
const SHOT_MODEL = 'bytedance/seedance-2-fast'
/** Seedance 2 tiers share one schema and one @ reference system. */
const SEEDANCE2 = ['bytedance/seedance-2-fast', 'bytedance/seedance-2', 'bytedance/seedance-2-mini']

/** The two image modes every reference recipe offers, unless it needs a source. */
const imageModes: RecipeMode[] = [
  { id: 'text', modelId: IMAGE_T2I },
  {
    id: 'from-image',
    modelId: IMAGE_I2I,
    source: { role: 'reference', accepts: 'image', required: true }
  }
]

const NO_TEXT = 'no text labels, no watermarks.'

const REFERENCE_RECIPES: Recipe[] = [
  {
    id: 'character',
    kind: 'reference',
    label: 'Character design sheet',
    description:
      'Full-body turnaround of one character (front, three-quarter, profile) — the identity reference to wire into every shot. From an image, it turns an existing portrait or illustration into a usable sheet.',
    slot: '[CHARACTER]',
    modes: imageModes,
    fields: [F.description, F.views, F.wardrobe, F.background, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Character design sheet of ${subjectOf(args.values, '[CHARACTER]')}:`,
        `${frag(args.values, 'views')}.`,
        fromSource(args),
        text(args.values, 'wardrobe') && `Wardrobe: ${text(args.values, 'wardrobe')}.`,
        'Identical proportions, outfit, hairstyle and colors across all views.',
        `${frag(args.values, 'background')}, no scenery, ${NO_TEXT}`,
        'Clear silhouette reading — this sheet is the identity reference for video generation.',
        styled(args.style)
      )
  },
  {
    id: 'decor',
    kind: 'reference',
    label: 'Environment design',
    description:
      'View of one location — architecture, materials, lighting mood — reusable as the set reference. From an image, it turns a scouting photo into a styled set.',
    slot: '[PLACE]',
    modes: imageModes,
    fields: [F.description, F.scale, F.timeOfDay, F.weather, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Environment design of ${subjectOf(args.values, '[PLACE]')}:`,
        `${frag(args.values, 'scale')}.`,
        fromSource(args),
        `Lit by ${frag(args.values, 'timeOfDay')}, ${frag(args.values, 'weather')}.`,
        'Readable as a film set with clear foreground, midground and background.',
        `No characters, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'prop',
    kind: 'reference',
    label: 'Prop design sheet',
    description:
      'One object shown from several angles on a neutral background — the prop reference for consistent shots.',
    slot: '[PROP]',
    modes: imageModes,
    fields: [F.description, F.angles, F.material, F.preserve],
    params: { aspect_ratio: '1:1' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Prop design sheet of ${subjectOf(args.values, '[PROP]')}:`,
        `${frag(args.values, 'angles')}.`,
        fromSource(args),
        text(args.values, 'material') && `Materials: ${text(args.values, 'material')}.`,
        'Identical materials, colors and proportions across views.',
        `No hands, no scene, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'styleframe',
    kind: 'reference',
    anchorSafe: true,
    followsVideoFormat: true,
    label: 'Style frame',
    description:
      'One fully composed frame that locks the look of the film — palette, lighting, atmosphere, framing.',
    slot: '[SCENE]',
    modes: imageModes,
    fields: [F.description, F.framing, F.lighting, F.lensLook, F.palette, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Cinematic style frame of ${subjectOf(args.values, '[SCENE]')}:`,
        'one fully composed frame that establishes the visual grammar of the film.',
        fromSource(args),
        `${frag(args.values, 'framing')}, ${frag(args.values, 'lighting')}, ${frag(args.values, 'lensLook')}.`,
        text(args.values, 'palette') && `Color palette: ${text(args.values, 'palette')}.`,
        `Production-design quality, coherent light sources, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'thumbnail',
    kind: 'reference',
    // A thumbnail IS the image that ships — never a "sheet that must not appear".
    anchorSafe: true,
    label: 'YouTube thumbnail',
    description:
      'One high-CTR YouTube thumbnail — a single dominant subject, exaggerated emotion, optional 2-4 word overlay. Generate variants (×N) and pick the strongest.',
    slot: '[SUBJECT]',
    modes: imageModes,
    fields: [F.description, F.emotions, F.overlayText, F.palette, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `YouTube thumbnail of ${subjectOf(args.values, '[SUBJECT]')}:`,
        'one bold, instantly readable composition designed to stay legible at 200 pixels wide — a single dominant subject filling most of the frame, strong contrast, clean separation from the background.',
        fromSource(args),
        text(args.values, 'emotions') &&
          `Facial expression / emotional tone, exaggerated for the small size: ${text(args.values, 'emotions')}.`,
        text(args.values, 'overlayText')
          ? `Bold overlay text, thick sans-serif with a strong outline, 2-4 words maximum: "${text(args.values, 'overlayText')}". No other text.`
          : NO_TEXT,
        text(args.values, 'palette') && `Color palette: ${text(args.values, 'palette')}.`,
        'Saturated colors, rim light separating the subject, no clutter, no watermark.',
        styled(args.style)
      )
  },
  {
    id: 'expressions',
    kind: 'reference',
    label: 'Expression sheet (6-panel grid)',
    board: true,
    description:
      'Six numbered head-and-shoulders panels of the SAME character, one per emotion — the acting reference for close-ups, where identity drifts the most. Build it from the character sheet.',
    slot: '[CHARACTER]',
    modes: imageModes,
    fields: [F.description, F.emotions, F.background, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Expression sheet of ${subjectOf(args.values, '[CHARACTER]')}:`,
        'a single grid of 6 head-and-shoulders panels of the SAME character, read left to right, top to bottom, a small panel number in the corner of each panel.',
        fromSource(args),
        `One emotion per panel: ${text(args.values, 'emotions') ?? 'neutral, joy, anger, fear, sadness, determination'}.`,
        'Identical face, hairstyle, wardrobe, lighting and camera distance in every panel — only the expression changes.',
        `${frag(args.values, 'background')}, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'wardrobe',
    kind: 'reference',
    label: 'Wardrobe / variant sheet',
    board: true,
    description:
      'The SAME character in several outfits or states, side by side — built FROM an approved character sheet so identity is inherited instead of re-rolled.',
    slot: '[CHARACTER]',
    // Source-only on purpose: a variant sheet with no original is just another
    // character sheet, and re-rolling identity is exactly what it must avoid.
    modes: [
      {
        id: 'from-image',
        modelId: IMAGE_I2I,
        source: { role: 'reference', accepts: 'image', required: true }
      }
    ],
    fields: [F.description, F.variants, F.background, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Wardrobe sheet of ${subjectOf(args.values, '[CHARACTER]')}:`,
        'a single row of numbered full-body panels of the SAME character, one variant per panel, identical pose and camera distance in every panel.',
        fromSource(args),
        `One variant per panel: ${text(args.values, 'variants') ?? '[VARIANTS]'}.`,
        `${frag(args.values, 'background')}, no scenery, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'packshot',
    kind: 'reference',
    anchorSafe: true,
    followsVideoFormat: true,
    label: 'Product pack-shot',
    description:
      'The hero product image an ad is built on. From an image, it relights and re-stages the client’s own product photo instead of inventing a look-alike.',
    slot: '[PRODUCT]',
    modes: imageModes,
    fields: [F.description, F.surface, F.lighting, F.framing, F.preserve],
    params: { aspect_ratio: '1:1' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Product pack-shot of ${subjectOf(args.values, '[PRODUCT]')}:`,
        `the product is the hero of the frame, ${frag(args.values, 'surface')}.`,
        fromSource(args),
        `${frag(args.values, 'framing')}, ${frag(args.values, 'lighting')}.`,
        'Immaculate surfaces, clean speculars, accurate proportions and materials.',
        `No hands, no clutter, no invented branding, ${NO_TEXT}`,
        styled(args.style)
      )
  },
  {
    id: 'shotboard',
    kind: 'reference',
    followsVideoFormat: true,
    label: 'Shot board (4-panel grid)',
    board: true,
    description:
      "The pre-visualization of ONE shot, down to its two hand-off frames: a 2x2 grid of 4 panels covering a single camera setup — panel 1 is the exact opening frame, panels 2-3 the action, panel 4 the exact closing frame the next shot has to cut away from. This is what makes two consecutive clips read as the same sequence: shot N+1 opens on shot N's panel 4. Use it on short shots (4-6 s), where a scene storyboard only spares one panel per clip, and on any cut the model keeps getting wrong.",
    slot: '[SHOT]',
    modes: imageModes,
    fields: [F.description, F.opensOn, F.closesOn, F.screenDirection, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Shot board of ${subjectOf(args.values, '[SHOT]')}:`,
        'a single 2x2 grid of 4 sequential panels covering ONE continuous camera setup, read left to right, top to bottom, a small panel number in the corner of each panel.',
        fromSource(args),
        text(args.values, 'opensOn')
          ? `Panel 1 is the exact opening frame: ${text(args.values, 'opensOn')}.`
          : 'Panel 1 is the exact opening frame of the shot.',
        'Panels 2 and 3 are the action beats in between.',
        text(args.values, 'closesOn')
          ? `Panel 4 is the exact closing frame: ${text(args.values, 'closesOn')}.`
          : 'Panel 4 is the exact closing frame the shot must end on.',
        'Same character, wardrobe, props, set, lens and lighting in all four panels — this is one shot progressing, not four different cuts.',
        `Across the four panels ${frag(args.values, 'screenDirection')}, and the horizon and camera axis stay consistent.`,
        `Clear readable compositions over dense detail. No speech bubbles, no captions, ${NO_TEXT}`,
        styled(args.style)
      ),
    byModel: {
      // Preferred path: the connected sheets (and the previous shot's board)
      // lock identity and the entry frame at the board stage.
      [IMAGE_I2I]: (args) =>
        join(
          `Create a shot board of ${subjectOf(args.values, '[SHOT]')}:`,
          'a single 2x2 grid of 4 sequential panels covering ONE continuous camera setup, read left to right, top to bottom, a small panel number in the corner of each panel.',
          text(args.values, 'opensOn')
            ? `Panel 1 is the exact opening frame: ${text(args.values, 'opensOn')}.`
            : 'Panel 1 is the exact opening frame of the shot.',
          'Panels 2 and 3 are the action beats in between.',
          text(args.values, 'closesOn')
            ? `Panel 4 is the exact closing frame: ${text(args.values, 'closesOn')}.`
            : 'Panel 4 is the exact closing frame the shot must end on.',
          'Keep every character, outfit, prop and set exactly consistent with the connected references (Image 1, Image 2, …).',
          'Same lens and lighting in all four panels — this is one shot progressing, not four different cuts.',
          `Across the four panels ${frag(args.values, 'screenDirection')}.`,
          `Clear readable compositions over dense detail. No speech bubbles, no captions, ${NO_TEXT}`,
          styled(args.style)
        )
    }
  },
  {
    id: 'storyboard',
    kind: 'reference',
    followsVideoFormat: true,
    label: 'Storyboard (9-panel grid)',
    board: true,
    description:
      'The pre-visualization step between design sheets and video: one 3x3 grid of 9 numbered panels showing how the scene unfolds — review the staging before spending video credits, then wire it as a shot reference (Seedance 2). Build it from the design sheets with gpt-image-2-image-to-image to lock identity at the storyboard stage.',
    slot: '[SCENE]',
    modes: imageModes,
    fields: [F.description, F.coverage, F.screenDirection, F.preserve],
    params: { aspect_ratio: '16:9' },
    supportedModels: [IMAGE_T2I, IMAGE_I2I],
    buildPrompt: (args) =>
      join(
        `Storyboard of ${subjectOf(args.values, '[SCENE]')}:`,
        'a single 3x3 grid of 9 sequential panels telling the scene beat by beat, read left to right, top to bottom, a small panel number in the corner of each panel.',
        fromSource(args),
        text(args.values, 'coverage') && `Panel coverage: ${text(args.values, 'coverage')}.`,
        'Same characters, outfits, location, lighting and art style in every panel; framing varies like a film — establishing wide, mediums, close-ups — so each panel implies its camera move.',
        `Consecutive panels must CONNECT: what leaves the frame on one side enters the next panel from the matching side, ${frag(args.values, 'screenDirection')} throughout, and every panel shares the geography of the one before it.`,
        `Clear readable compositions over dense detail. No speech bubbles, no captions, ${NO_TEXT}`,
        styled(args.style)
      ),
    byModel: {
      // Preferred path: the connected design sheets lock identity at the storyboard stage.
      [IMAGE_I2I]: (args) =>
        join(
          `Create a storyboard of ${subjectOf(args.values, '[SCENE]')}:`,
          'a single 3x3 grid of 9 sequential panels telling the scene beat by beat, read left to right, top to bottom, a small panel number in the corner of each panel.',
          'Keep every character, outfit, prop and set exactly consistent with the connected design sheets (Image 1, Image 2, …) across all panels.',
          text(args.values, 'coverage') && `Panel coverage: ${text(args.values, 'coverage')}.`,
          'Framing varies like a film — establishing wide, mediums, close-ups — so each panel implies its camera move.',
          `Consecutive panels must CONNECT: what leaves the frame on one side enters the next panel from the matching side, ${frag(args.values, 'screenDirection')} throughout, and every panel shares the geography of the one before it.`,
          `Clear readable compositions over dense detail. No speech bubbles, no captions, ${NO_TEXT}`,
          styled(args.style)
        )
    }
  }
]

// ─── Shot recipes ───────────────────────────────────────────────────────────

/**
 * A shot preset = a camera move written once, correctly, for the models that
 * honor it. This is the layer that turns "type a prompt and hope" into "pick a
 * move": the motion sentence is guaranteed to satisfy the lint's motion rule by
 * construction (registry-tested), which is exactly the bar a preset must clear
 * to earn its place — a preset that does not turn a lint warning green is
 * decorative.
 *
 * Deliberately short list. A move the model does not honor is worse than no
 * preset at all: it burns credits and trust.
 */
/**
 * A shot preset = a camera move written once, correctly, for the models that
 * honor it — and written in the THREE registers the doctrine recognizes
 * (§6.9, `prompting/seedance.ts`), because the same move is a different
 * sentence depending on who is holding the camera:
 *
 *   - `architect` — the camera is an instrument. Say the move.
 *   - `flow`      — the camera is a BODY. Never describe the camera: describe
 *                   the person holding it, their position, their motive and
 *                   what their body does to the frame. This is the strongest
 *                   dynamism lever in the realism register and almost nobody
 *                   uses it.
 *   - `kinetic`   — the camera is a GHOST. Grant it moves no body could make.
 *
 * The register is not a per-node choice: it comes from the video's art
 * direction (`StyleTemplate.captureId` → the capture declaration's mode), which
 * is what keeps one film in one universe. The realism and stylized registers
 * run on opposite camera doctrines and mixing them inside one piece produces
 * neither.
 *
 * The prompt a preset stores is the BODY of the sandwich — bracketed timeline
 * beats only. The opening declaration and the booster stack are added at
 * payload time from the video's current style, exactly like the style bible.
 */
interface ShotPresetSpec {
  id: string
  label: string
  description: string
  /**
   * Default clip length, in seconds. A preset that ships the model's own
   * default (15 s on Seedance 2) is not a preset: an insert is 4 s and a
   * reaction is 5 s, and getting that right is half of what a preset buys.
   * Must stay inside every supported model's bounds (registry-tested).
   */
  seconds: number
  /** Default shot size and FOV step — both overridable by the form. */
  shotSize: string
  fov: number
  /** Camera-mode id used as the beat bracket under a physical camera. */
  bracket: string
  /** Camera-mode id used as the beat bracket under the ghost. */
  bracketKinetic: string
  /** MODE A — the instrument. MUST contain motion vocabulary (registry-tested). */
  motion: string
  /** MODE B — the body: position, motive, and what it does to the frame. */
  operator: string
  /** MODE C — the ghost: the move no operator could execute. */
  ghost: string
  /** Extra modes beyond text + from-image (video extend declares its own). */
  modes?: RecipeMode[]
  supportedModels?: string[]
}

const SHOT_PRESETS: ShotPresetSpec[] = [
  {
    id: 'shot-establishing',
    seconds: 8,
    label: 'Establishing shot',
    description:
      'Opens a scene: a wide frame with a slow camera move that lets the location read before the action starts.',
    shotSize: 'ews',
    fov: 84,
    bracket: 'dolly-push-in',
    bracketKinetic: 'snap-zoom-open',
    motion:
      'the camera holds wide at 84° and pushes in very slowly, letting the whole location read before the action starts',
    operator:
      'the operator stands back with the camera on their shoulder, letting the place read before they commit, then eases forward as they find the subject',
    ghost:
      'the camera snaps open from a wide vantage and glides in without a body, the whole location arriving in one impossible move',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-tracking',
    seconds: 6,
    label: 'Tracking shot',
    description:
      'The camera travels alongside the subject at its own speed — the workhorse of movement, and the shot where screen direction matters most.',
    shotSize: 'ms',
    fov: 47,
    bracket: 'lateral-tracking',
    bracketKinetic: 'orbital-arc',
    motion:
      'the camera tracks laterally alongside the subject at 47°, matching its speed and keeping it at the same point in the frame',
    operator:
      'the operator moves alongside the subject to stay with them, half a beat behind, overshooting slightly and correcting',
    ghost:
      'the camera rips sideways with the subject and arcs around them, holding them dead centre through the turn',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-push-in',
    seconds: 5,
    label: 'Push-in',
    description:
      'A slow dolly toward the subject — the cheapest way to raise intensity without a cut.',
    shotSize: 'mcu',
    fov: 29,
    bracket: 'dolly-push-in',
    bracketKinetic: 'crash-push-in',
    motion:
      'the camera dollies slowly straight in toward the subject at 29°, tightening the frame without cutting',
    operator:
      'the operator steps in closer because they want to read the face, the frame tightening and settling as they stop',
    ghost: 'the camera CRASHES in on the face, stopping dead at the moment of realization',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-pull-back',
    seconds: 6,
    label: 'Pull-back reveal',
    description:
      'Starts tight and pulls back to disclose the context — the reveal shot of an edit.',
    shotSize: 'ws',
    fov: 63,
    bracket: 'pull-back-reveal',
    bracketKinetic: 'camera-abandons-hero',
    motion:
      'the camera starts tight on the subject and pulls back steadily to 63°, revealing the surrounding context',
    operator:
      'the operator backs away to take in what is around the subject, the frame widening as they retreat and find their footing',
    ghost:
      'the camera tears backwards away from the subject, the context arriving all at once in one weightless move',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-orbit',
    seconds: 6,
    label: 'Orbit',
    description:
      'The camera arcs around the subject — the product and hero shot, and the clearest way to show an object in three dimensions.',
    shotSize: 'ms',
    fov: 47,
    bracket: 'slow-orbit',
    bracketKinetic: 'orbital-arc',
    motion:
      'the camera orbits smoothly around the subject on a level arc at 47°, keeping it centered in frame',
    operator:
      'the operator walks a slow circle around the subject, keeping it centered, the horizon rocking gently with their steps',
    ghost:
      'the camera swings a 180° orbital arc around the subject, weightless and centred throughout',
    supportedModels: SEEDANCE2
  },
  {
    id: 'shot-insert',
    seconds: 4,
    label: 'Insert / macro detail',
    description:
      'A very short close detail — the cutaway that lets an edit breathe and hides a continuity problem.',
    shotSize: 'ecu',
    fov: 12,
    bracket: 'rack-focus-hold',
    bracketKinetic: 'crash-push-in',
    motion:
      'the camera holds very close on the detail at 12° with a barely perceptible drift, focus falling off fast',
    operator:
      'the operator leans right over the detail and holds, breathing moving the frame a millimetre at a time',
    ghost: 'the camera slams onto the detail and HOLDS, the rest of the world gone',
    supportedModels: SEEDANCE2
  },
  {
    id: 'shot-reaction',
    seconds: 5,
    label: 'Reaction close-up',
    description:
      'A near-static close-up carried entirely by the performance — the shot that needs an expression sheet behind it.',
    shotSize: 'cu',
    fov: 18,
    bracket: 'static-locked-off',
    bracketKinetic: 'dutch-snap-landing',
    motion:
      'the camera stays locked in a close-up at 18° and barely breathes; the movement is the performance, not the camera',
    operator:
      'the operator holds the close-up as still as a body can, the frame drifting a hair and coming back',
    ghost: 'the camera settles on a canted close-up and locks, the world tilted around the face',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-pov-handheld',
    seconds: 6,
    label: 'POV / handheld',
    description: 'Subjective, unstable framing — presence and urgency, at the cost of steadiness.',
    shotSize: 'ms',
    fov: 63,
    bracket: 'pov-handheld',
    bracketKinetic: 'hard-whip-impact',
    motion:
      'the camera is handheld at eye level at 63°, moving with the body that carries it, framing loose and reactive',
    operator:
      'the operator is inside the action, breathing hard, the camera swinging with their shoulders and losing the subject for a moment before finding it again',
    ghost:
      'the camera whips through the space at head height and lands hard on the subject, never a person, never part of the scene',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-whip-pan',
    seconds: 4,
    label: 'Whip-pan transition',
    description:
      'The one effect preset: a fast pan that blurs out, built to be cut against the next shot’s matching whip in.',
    shotSize: 'ms',
    fov: 47,
    bracket: 'whip-pan-transition',
    bracketKinetic: 'hard-whip-impact',
    motion:
      'the camera whip-pans fast enough to blur the frame, settling for a beat before and after the blur so the transition reads',
    operator:
      'the operator turns fast to catch something off to the side, the frame smearing before it settles on what they were looking for',
    ghost:
      'the camera WHIPS across the axis, the frame smearing to nothing before it SNAPS onto the next subject',
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  },
  {
    id: 'shot-locked-off',
    seconds: 5,
    label: 'Locked-off frame',
    description:
      'A rigid frame where only the subject moves — the most reliable shot on every model, and the most under-used.',
    shotSize: 'ws',
    fov: 47,
    bracket: 'static-locked-off',
    bracketKinetic: 'static-locked-off',
    motion:
      'the camera is locked off on a tripod at 47° and does not move at all; only the subject moves inside the frame',
    operator:
      'the camera is on sticks and nobody touches it — the operator has stepped away and let the frame run',
    ghost: 'the camera holds one rigid frame and refuses to move; everything else does the moving',
    // The only preset with a hard parameter behind it: Seedance 1.5 locks the
    // camera with `fixed_lens`, and its own guide says that is the way to do it,
    // not prompt words.
    supportedModels: [...SEEDANCE2, 'bytedance/seedance-1.5-pro']
  }
]

/** Per-model params a preset needs beyond its prompt — real control beats prose. */
const SHOT_PRESET_PARAMS: Record<string, Record<string, Record<string, unknown>>> = {
  // Seedance 1.5 documents `fixed_lens: true` as THE way to lock the camera.
  'shot-locked-off': { 'bytedance/seedance-1.5-pro': { fixed_lens: true } },
  'shot-reaction': { 'bytedance/seedance-1.5-pro': { fixed_lens: true } },
  'shot-insert': { 'bytedance/seedance-1.5-pro': { fixed_lens: true } }
}

/** The `text` + `from-image` modes shared by shot presets. */
const shotModes = (modelId: string): RecipeMode[] => [
  { id: 'text', modelId },
  {
    id: 'from-image',
    modelId,
    source: { role: 'anchor', accepts: 'image', required: true }
  }
]

const SHOT_COMMON_FIELDS: RecipeField[] = [
  F.description,
  F.opensOn,
  F.closesOn,
  F.screenDirection,
  F.pace,
  F.shotSize,
  F.fov,
  F.whiteBalance,
  F.atmosphere,
  F.life,
  F.sound
]

/** The register a shot is written in, taken from the video's art direction. */
function registerOf(style?: StyleTemplate): { mode: PromptMode; doctrine: CameraDoctrine } {
  const declaration = style ? getCaptureDeclaration(style.captureId) : undefined
  return {
    mode: declaration?.mode ?? 'architect',
    doctrine: declaration?.doctrine ?? 'embodied'
  }
}

/**
 * The camera sentence for this preset in this register. Doctrine A never
 * describes the camera — it describes the person holding it — and Doctrine B
 * never describes a person.
 */
function cameraSentenceFor(
  preset: ShotPresetSpec,
  register: { mode: PromptMode; doctrine: CameraDoctrine },
  values: RecipeValues
): string {
  const base =
    register.mode === 'flow'
      ? preset.operator
      : register.mode === 'kinetic'
        ? preset.ghost
        : preset.motion
  const fov = text(values, 'fov')
  // An explicit FOV override replaces the one baked into the sentence.
  return fov && base.includes('°') ? base.replace(/\d+°/, `${snapFov(Number(fov))}°`) : base
}

/**
 * The body of a shot prompt: a bracketed timeline, one camera behaviour and one
 * primary subject action per beat, escalating establish → develop → payoff, and
 * ending on an aftermath beat (realism) or a locked hero frame (stylized) —
 * real footage does not cut on the beat, and a stylized clip needs its poster
 * frame.
 */
function buildShotBody(preset: ShotPresetSpec, args: RecipePromptArgs): string {
  const values = args.values
  const register = registerOf(args.style)
  const subject = subjectOf(values, '[SHOT]')
  const bracketId = register.doctrine === 'disembodied' ? preset.bracketKinetic : preset.bracket
  const bracket = bracketFor(bracketId, register.doctrine)
  const size = getShotSize(text(values, 'shotSize') ?? preset.shotSize)
  const seconds = args.durationSeconds ?? preset.seconds
  const ranges = beatRanges(seconds, beatCountFor(seconds))
  const camera = cameraSentenceFor(preset, register, values)
  const opensOn = text(values, 'opensOn')
  const closesOn = text(values, 'closesOn')
  const life = text(values, 'life')
  const atmosphere = text(values, 'atmosphere')
  const wb = text(values, 'whiteBalance')

  const beats: SeedanceBeat[] = ranges.map((range, index) => {
    const isFirst = index === 0
    const isLast = index === ranges.length - 1
    if (isFirst) {
      return {
        ...range,
        bracket,
        action: opensOn
          ? `The shot OPENS ON: ${opensOn}.`
          : `${size?.abbr ?? 'MS'} on ${subject} — the frame settles on the subject.`,
        camera: `${camera}.`,
        ...(atmosphere ? { atmosphere: `${atmosphere}.` } : {})
      }
    }
    if (isLast) {
      return {
        ...range,
        bracket,
        action: closesOn
          ? `The shot CLOSES ON: ${closesOn}.`
          : `${subject} — the action lands and settles.`,
        camera:
          register.mode === 'kinetic'
            ? 'Frame locks on the final pose, residual motion still running inside the freeze.'
            : 'The camera holds a beat longer than the action needs, drifting slightly off-subject.',
        ...(life ? { atmosphere: `${life}.` } : {})
      }
    }
    return {
      ...range,
      bracket,
      action: `${subject}.`,
      camera: `${frag(values, 'pace')}, and ${frag(values, 'screenDirection')}.`,
      ...(life && ranges.length === 2 ? { atmosphere: `${life}.` } : {})
    }
  })

  return block(
    buildSeedanceBody({
      beats,
      ...(text(values, 'sound') ? { audio: text(values, 'sound')! } : {}),
      oner: true
    }),
    wb ? `White balance ${wb}K, fixed for the whole shot.` : undefined,
    join(
      size ? `${size.abbr} — ${size.inFrame}.` : undefined,
      'One continuous camera setup: no cut inside this shot, and the camera does not cross the 180° line.'
    )
  )
}

const SHOT_RECIPES_BASE: Recipe[] = SHOT_PRESETS.map((preset) => ({
  id: preset.id,
  kind: 'shot' as const,
  followsVideoFormat: true,
  label: preset.label,
  description: preset.description,
  slot: '[SHOT]',
  params: { duration: preset.seconds },
  paramsByModel: SHOT_PRESET_PARAMS[preset.id],
  modes: preset.modes ?? shotModes(SHOT_MODEL),
  fields: SHOT_COMMON_FIELDS,
  supportedModels: preset.supportedModels ?? SEEDANCE2,
  buildPrompt: (args: RecipePromptArgs) =>
    block(
      buildShotBody(preset, args),
      args.mode?.source?.accepts === 'image'
        ? 'The connected image IS the opening frame of this shot — continue from it, do not re-stage it.'
        : undefined
    )
}))

/**
 * Video extend — the ONLY genuine continuity path (the previous CLIP as an @Video
 * reference). Its own recipe because it is source-only and reference-roled:
 * between shots you CUT, and when you truly must continue, you extend. It also
 * carries the continuation protocol: there is no memory between generations, so
 * the state has to be restated, physically, every time.
 */
const EXTEND_RECIPE: Recipe = {
  id: 'shot-extend',
  kind: 'shot',
  followsVideoFormat: true,
  params: { duration: 6 },
  label: 'Continue the previous clip (video extend)',
  description:
    'The one shot that genuinely continues another: the previous CLIP is wired as an @Video reference so set, identity, grade and voice carry over. It serializes the batch (this shot cannot run before the previous one has settled) and a re-roll upstream invalidates it — use it where a cut would not do.',
  slot: '[SHOT]',
  modes: [
    {
      id: 'from-video',
      modelId: SHOT_MODEL,
      source: { role: 'reference', accepts: 'video', required: true }
    }
  ],
  fields: SHOT_COMMON_FIELDS,
  supportedModels: SEEDANCE2,
  buildPrompt: (args) => {
    const values = args.values
    const register = registerOf(args.style)
    const subject = subjectOf(values, '[SHOT]')
    const bracket = bracketFor(
      register.doctrine === 'disembodied' ? 'ramp-on-the-steal' : 'steadicam-glide',
      register.doctrine
    )
    const seconds = args.durationSeconds ?? 6
    const ranges = beatRanges(seconds, beatCountFor(seconds))
    const opensOn = text(values, 'opensOn')
    const closesOn = text(values, 'closesOn')
    const beats: SeedanceBeat[] = ranges.map((range, index) => {
      if (index === 0) {
        return {
          ...range,
          bracket,
          action: opensOn
            ? `Direct continuation: the shot OPENS ON ${opensOn}, exactly where the source clip left off.`
            : 'Direct continuation: the shot opens exactly where the source clip left off.',
          camera:
            'The camera continues moving in the same direction and at the same speed as the source clip, with no visible cut at the join.'
        }
      }
      if (index === ranges.length - 1) {
        return {
          ...range,
          bracket,
          action: closesOn ? `The shot CLOSES ON: ${closesOn}.` : `${subject} — the beat lands.`,
          camera: 'The camera holds a beat past the action.'
        }
      }
      return {
        ...range,
        bracket,
        action: `${subject}.`,
        camera: `${frag(values, 'pace')}, and ${frag(values, 'screenDirection')}.`
      }
    })
    return block(
      buildSeedanceBody({
        references: [
          'Continue from the connected source clip (@Video1): same set, wardrobe, lighting, grade and voices, and the same state carried forward physically — wet stays wet, torn stays torn, dust stays on the clothes.'
        ],
        beats,
        ...(text(values, 'sound') ? { audio: text(values, 'sound')! } : {}),
        oner: true
      }),
      'One continuous camera setup: no cut inside this shot, and the camera does not cross the 180° line.'
    )
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Every recipe, both kinds — the single list the UI, the docs and the tests read. */
export const RECIPES: Recipe[] = [...REFERENCE_RECIPES, ...SHOT_RECIPES_BASE, EXTEND_RECIPE]

/** The reference half — the add-node "Designs" group and the design library. */
export const DESIGN_RECIPES: Recipe[] = RECIPES.filter((r) => r.kind === 'reference')

/** The shot half — pre-configured video nodes. */
export const SHOT_RECIPES: Recipe[] = RECIPES.filter((r) => r.kind === 'shot')

const RECIPE_MAP = new Map(RECIPES.map((r) => [r.id, r]))

export function getRecipe(id: string): Recipe | undefined {
  return RECIPE_MAP.get(id)
}

/** Resolves a reference recipe only — `params.designId` never names a shot. */
export function getDesignRecipe(id: string): Recipe | undefined {
  const recipe = RECIPE_MAP.get(id)
  return recipe?.kind === 'reference' ? recipe : undefined
}

export const recipeIds = RECIPES.map((r) => r.id)
export const designRecipeIds = DESIGN_RECIPES.map((r) => r.id)

/** The mode a recipe is created in by default. */
export function defaultModeOf(recipe: Recipe): RecipeMode {
  return recipe.modes[0]!
}

export function getRecipeMode(recipe: Recipe, modeId?: string): RecipeMode | undefined {
  if (modeId === undefined) return defaultModeOf(recipe)
  return recipe.modes.find((m) => m.id === modeId)
}

/**
 * The models offered for a given mode: its own, plus the supported models that
 * are not another mode's model and can actually carry the mode's source handle.
 * A design recipe switches model by switching mode, so it offers exactly one; a
 * shot preset reads the same across the Seedance 2 tiers, so it offers all
 * three. The form, the creation service and the registry test share this rule.
 */
export function recipeModelChoices(recipe: Recipe, mode: RecipeMode): string[] {
  const modeModels = new Set(recipe.modes.map((m) => m.modelId))
  return recipe.supportedModels.filter((id) => {
    if (id === mode.modelId) return true
    if (modeModels.has(id)) return false
    return mode.source ? resolveRecipeHandle(id, mode.source) !== undefined : true
  })
}

/** The fields a recipe shows in the given mode (mode-restricted fields drop out). */
export function recipeFieldsFor(recipe: Recipe, mode: RecipeMode): RecipeField[] {
  return recipe.fields.filter((f) => !f.modes || f.modes.includes(mode.id))
}

/** Resolves the per-model prompt override, falling back to the recipe default. */
export function buildRecipePrompt(recipe: Recipe, modelId: string, args: RecipePromptArgs): string {
  const builder = recipe.byModel?.[modelId] ?? recipe.buildPrompt
  return builder(args)
}

/** Historical name, kept for the MCP docs and existing callers. */
export const buildDesignPrompt = buildRecipePrompt

/**
 * Full node params for a recipe node: model defaults + recipe/mode overrides +
 * the built prompt + the markers.
 *
 * The markers are deliberately not model fields — run-time validation strips
 * them — but they are load-bearing everywhere else: `recipeId`/`recipeMode`
 * let the lint know a required source is missing and let the UI re-open the
 * form, `designId` (reference recipes ONLY) drives the frame-anchor warning and
 * the design-library promotion, and `applyVideoStyle` makes the run engine
 * append the video's current style bible.
 */
export function recipeNodeParams(args: {
  recipe: Recipe
  mode: RecipeMode
  /** Overrides `mode.modelId` — must be one of `recipe.supportedModels`. */
  modelId?: string
  values: RecipeValues
  style?: StyleTemplate
  /** The video's format defaults — applied only when the recipe follows them. */
  videoDefaults?: { defaultAspectRatio?: string | null; defaultResolution?: string | null } | null
  /**
   * Overrides the recipe's default clip length (a scenario shot's own duration).
   * Snapped to the model's `duration` field, then used for BOTH the param and
   * the prompt's beat timeline — they can never disagree.
   */
  durationSeconds?: number
}): Record<string, unknown> {
  const modelId = args.modelId ?? args.mode.modelId
  if (!args.recipe.supportedModels.includes(modelId)) {
    throw new Error(
      `Model "${modelId}" is not supported by recipe "${args.recipe.id}" (${args.recipe.supportedModels.join(', ')}).`
    )
  }
  const model = getModelOrThrow(modelId)
  const subject = (args.values.description ?? '').trim()
  const durationField = model.paramFields.find((f) => f.key === 'duration' && f.type === 'number')
  const duration =
    args.durationSeconds !== undefined && durationField
      ? clampParamToField(args.durationSeconds, durationField)
      : undefined
  return {
    ...defaultParamsFor(modelId),
    ...args.recipe.params,
    ...args.recipe.paramsByModel?.[modelId],
    ...args.mode.params,
    // The video's format wins over the recipe's for anything the audience
    // actually sees framed — a 9:16 project cannot have 16:9 shots.
    ...(args.recipe.followsVideoFormat
      ? videoDefaultParams(modelId, args.videoDefaults ?? null)
      : {}),
    ...(duration !== undefined ? { duration } : {}),
    prompt: buildRecipePrompt(args.recipe, modelId, {
      values: args.values,
      ...(args.style ? { style: args.style } : {}),
      mode: args.mode,
      ...(duration !== undefined ? { durationSeconds: duration } : {})
    }),
    recipeId: args.recipe.id,
    recipeMode: args.mode.id,
    ...(args.recipe.kind === 'reference' ? { designId: args.recipe.id } : {}),
    applyVideoStyle: true,
    ...(subject ? { designSubject: subject } : {})
  }
}

/**
 * The node's `intent` — English like template intents. Reference recipes state
 * the reference-only rule (the convention the template tests enforce); shot
 * recipes state what the camera does.
 */
export function recipeIntent(recipe: Recipe, values: RecipeValues = {}): string {
  const subject = (values.description ?? '').trim()
  const suffix = subject ? ` — ${subject}` : ''
  if (recipe.kind === 'shot') {
    return `${recipe.label}${suffix}. One continuous camera setup; consistency with the other shots comes from the references wired on all of them, never from chaining the previous clip's last frame.`
  }
  return `${recipe.label}${suffix} — design reference for downstream shots. Wire it into reference inputs only (e.g. Seedance 2 reference_image_urls); on a frame anchor it would appear on screen.`
}

/** Historical name, kept for the MCP docs. */
export const designIntent = recipeIntent
