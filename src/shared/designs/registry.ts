import type { StyleTemplate } from '../styles/registry'
import { defaultParamsFor, getModelOrThrow } from '../models'

/**
 * Design recipes — one-click "design sheet" nodes (character, décor, prop…)
 * whose prompt is BUILT for the target model and the video's style template,
 * so the user never has to know each model's idioms or the reference-vs-anchor
 * pitfall. A recipe produces a regular image model node, marked with
 * `params.designId` so the editor can warn when its output is wired to a
 * frame-anchor input (the sheet would appear on screen).
 *
 * All agent-facing content is English (prompts perform best in English);
 * UI display names live in i18n under `designs.<id>`.
 */

export interface DesignPromptArgs {
  /** The user's short subject description. Empty → the recipe's [SLOT] is kept. */
  description: string
  /** The video's style template, when one is set. */
  style?: StyleTemplate
}

export interface DesignRecipe {
  id: string
  /** Agent-facing English name; UI display names live in i18n under `designs.<id>`. */
  label: string
  description: string
  /** Placeholder slot kept in the prompt when no description is given, e.g. "[CHARACTER]". */
  slot: string
  /** The image model the default prompt is written for. */
  defaultModelId: string
  /** Recipe param overrides, merged over the model's defaults (never over `prompt`). */
  params?: Record<string, unknown>
  /** Default prompt builder — must work for any image model (positive, model-agnostic wording). */
  buildPrompt(args: DesignPromptArgs): string
  /** Per-model overrides for models whose prompt idioms diverge; falls back to buildPrompt. */
  byModel?: Record<string, (args: DesignPromptArgs) => string>
}

/** Joins the non-empty fragments into one prompt paragraph. */
const join = (...fragments: Array<string | undefined | false>): string =>
  fragments.filter(Boolean).join(' ')

/**
 * The image-specific style fragment baked into the prompt at creation. The
 * style BIBLE is deliberately not baked in: design nodes carry
 * `applyVideoStyle: true`, so the run engine appends the video's current
 * bible at payload time (style switches propagate without prompt edits).
 */
const styled = (style?: StyleTemplate): string => (style ? style.imageFragment : '')

export const DESIGN_RECIPES: DesignRecipe[] = [
  {
    id: 'character',
    label: 'Character design sheet',
    description:
      'Full-body turnaround of one character (front, three-quarter, profile) — the identity reference to wire into every shot.',
    slot: '[CHARACTER]',
    defaultModelId: 'gpt-image-2-text-to-image',
    params: { aspect_ratio: '16:9' },
    buildPrompt: ({ description, style }) =>
      join(
        `Character design sheet of ${description.trim() || '[CHARACTER]'}:`,
        'full-body turnaround with three aligned views of the SAME character — front, three-quarter and profile — in a neutral standing pose.',
        'Identical proportions, outfit, hairstyle and colors across all views. Plain light background, no scenery, no text labels, no watermarks.',
        'Clear silhouette reading — this sheet is the identity reference for video generation.',
        styled(style)
      )
  },
  {
    id: 'decor',
    label: 'Environment design',
    description:
      'Wide establishing view of one location — architecture, materials, lighting mood — reusable as the set reference.',
    slot: '[PLACE]',
    defaultModelId: 'gpt-image-2-text-to-image',
    params: { aspect_ratio: '16:9' },
    buildPrompt: ({ description, style }) =>
      join(
        `Environment design of ${description.trim() || '[PLACE]'}:`,
        'wide establishing view showing the whole location — its layout, architecture, materials and key lighting mood.',
        'Readable as a film set with clear foreground, midground and background. No characters, no text, no watermarks.',
        styled(style)
      )
  },
  {
    id: 'prop',
    label: 'Prop design sheet',
    description:
      'One object shown from several angles on a neutral background — the prop reference for consistent shots.',
    slot: '[PROP]',
    defaultModelId: 'gpt-image-2-text-to-image',
    params: { aspect_ratio: '1:1' },
    buildPrompt: ({ description, style }) =>
      join(
        `Prop design sheet of ${description.trim() || '[PROP]'}:`,
        'the object shown large on a plain neutral background from three angles — front, three-quarter and back — plus one close-up detail inset.',
        'Identical materials, colors and proportions across views. No hands, no scene, no text labels, no watermarks.',
        styled(style)
      )
  },
  {
    id: 'styleframe',
    label: 'Style frame',
    description:
      'One fully composed frame that locks the look of the film — palette, lighting, atmosphere, framing.',
    slot: '[SCENE]',
    defaultModelId: 'gpt-image-2-text-to-image',
    params: { aspect_ratio: '16:9' },
    buildPrompt: ({ description, style }) =>
      join(
        `Cinematic style frame of ${description.trim() || '[SCENE]'}:`,
        'one fully composed frame that establishes the visual grammar of the film — color palette, lighting, atmosphere and framing.',
        'Production-design quality, coherent light sources, no text, no watermarks.',
        styled(style)
      )
  },
  {
    id: 'storyboard',
    label: 'Storyboard (9-panel grid)',
    description:
      'The pre-visualization step between design sheets and video: one 3x3 grid of 9 numbered panels showing how the scene unfolds — review the staging before spending video credits, then wire it as a shot reference (Seedance 2). Build it from the design sheets with gpt-image-2-image-to-image to lock identity at the storyboard stage.',
    slot: '[SCENE]',
    defaultModelId: 'gpt-image-2-text-to-image',
    params: { aspect_ratio: '16:9' },
    buildPrompt: ({ description, style }) =>
      join(
        `Storyboard of ${description.trim() || '[SCENE]'}:`,
        'a single 3x3 grid of 9 sequential panels telling the scene beat by beat, read left to right, top to bottom, a small panel number in the corner of each panel.',
        'Same characters, outfits, location, lighting and art style in every panel; framing varies like a film — establishing wide, mediums, close-ups — so each panel implies its camera move.',
        'Clear readable compositions over dense detail. No speech bubbles, no captions, no other text, no watermarks.',
        styled(style)
      ),
    byModel: {
      // Preferred path: the connected design sheets lock identity at the storyboard stage.
      'gpt-image-2-image-to-image': ({ description, style }) =>
        join(
          `Create a storyboard of ${description.trim() || '[SCENE]'}:`,
          'a single 3x3 grid of 9 sequential panels telling the scene beat by beat, read left to right, top to bottom, a small panel number in the corner of each panel.',
          'Keep every character, outfit, prop and set exactly consistent with the connected design sheets (Image 1, Image 2, …) across all panels.',
          'Framing varies like a film — establishing wide, mediums, close-ups — so each panel implies its camera move.',
          'Clear readable compositions over dense detail. No speech bubbles, no captions, no other text, no watermarks.',
          styled(style)
        )
    }
  }
]

const RECIPE_MAP = new Map(DESIGN_RECIPES.map((r) => [r.id, r]))

export function getDesignRecipe(id: string): DesignRecipe | undefined {
  return RECIPE_MAP.get(id)
}

export const designRecipeIds = DESIGN_RECIPES.map((r) => r.id)

/** Resolves the per-model prompt override, falling back to the recipe default. */
export function buildDesignPrompt(
  recipe: DesignRecipe,
  modelId: string,
  args: DesignPromptArgs
): string {
  const builder = recipe.byModel?.[modelId] ?? recipe.buildPrompt
  return builder(args)
}

/**
 * Full node params for a design node: model defaults + recipe overrides + the
 * built prompt + the `designId`/`designSubject`/`applyVideoStyle` markers.
 * The markers are deliberately not model fields — run-time validation strips
 * them — but the editor reads `designId` to warn when the node's output is
 * wired to a frame-anchor input, library promotion copies design markers onto
 * the asset, and the run engine appends the video's style bible when
 * `applyVideoStyle` is set.
 */
export function designNodeParams(
  recipe: DesignRecipe,
  modelId: string,
  args: DesignPromptArgs
): Record<string, unknown> {
  getModelOrThrow(modelId)
  const subject = args.description.trim()
  return {
    ...defaultParamsFor(modelId),
    ...recipe.params,
    prompt: buildDesignPrompt(recipe, modelId, args),
    designId: recipe.id,
    applyVideoStyle: true,
    ...(subject ? { designSubject: subject } : {})
  }
}

/**
 * The node's `intent` — English like template intents, and containing the word
 * "reference" so the same convention the template tests enforce applies.
 */
export function designIntent(recipe: DesignRecipe): string {
  return `${recipe.label} — design reference for downstream shots. Wire it into reference inputs only (e.g. Seedance 2 reference_image_urls); on a frame anchor it would appear on screen.`
}
