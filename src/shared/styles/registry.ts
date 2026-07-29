import { getBoosterStack, getCaptureDeclaration, wrapSeedanceSandwich } from '../prompting/seedance'

/**
 * Style templates — reusable art directions (anime, commercial, realism…).
 * A style is attached to a video (videos.styleId) and consumed by agents:
 * its `styleBible` paragraph is meant to be appended to EVERY visual prompt
 * of the video so all shots share one coherent look (the single biggest
 * lever for cross-shot consistency).
 *
 * All agent-facing content is English (prompts perform best in English);
 * UI display names live in i18n under `styles.<id>`.
 */

export interface StyleTemplate {
  id: string
  /** Agent-facing English name. */
  label: string
  /** One-line summary for pickers and the docs index. */
  description: string
  /**
   * The art-direction paragraph to append verbatim to every image/video
   * prompt of the video. Written to be model-agnostic.
   */
  styleBible: string
  /** Extra fragment for still-image prompts (keyframes, moodboards, products). */
  imageFragment: string
  /** Extra fragment for video prompts (motion, camera, pacing). */
  videoFragment: string
  /** Suggested Suno `style` field content for the soundtrack. */
  musicHint: string
  /** What to keep OUT of prompts — mixing these in degrades the look. */
  avoid: string
  /**
   * §6.9 — the capture declaration this art direction is captured on. It is
   * PROVENANCE, not decoration: prepended to every styled video prompt at
   * payload time, it selects the slice of the distribution the shot is drawn
   * from, and it brings the prompting mode, the camera doctrine and the closing
   * booster stack with it (all three live on the declaration, so nothing here
   * can drift out of sync). Registry-test enforced against
   * `prompting/seedance.ts`.
   */
  captureId: string
  /**
   * The 25-40 word compression of `styleBible` that rides inside the opening
   * declaration. The full bible stays the reference document; each prompt
   * carries the compressed version, because a long look paragraph at the top
   * displaces the instructions that matter.
   */
  styleBibleCompact: string
  /** Suggested model params (applied as hints, never forced). */
  recommendedParams: {
    aspectRatio?: string
    resolution?: string
    /** Seedance 1.5 Pro `fixed_lens` suggestion. */
    fixedLens?: boolean
  }
}

export const STYLES: StyleTemplate[] = [
  {
    id: 'anime',
    label: 'Anime / 2D animation',
    description:
      'Hand-drawn Japanese animation look — cel shading, expressive faces, painterly backgrounds.',
    styleBible:
      'Art direction: 2D anime, hand-drawn cel animation. Clean lineart, flat cel shading with two-tone shadows, ' +
      'painterly detailed backgrounds in the style of a theatrical anime film. Vivid but harmonious palette, ' +
      'strong rim light at golden hour, expressive large eyes, wind-blown hair. Consistent character design across every shot.',
    imageFragment:
      'Key visual quality, sharp lineart, no 3D render, no photorealism. Composition with clear silhouette reading.',
    videoFragment:
      'Animation on twos feel, held backgrounds with parallax camera pans, dramatic speed lines on fast actions, ' +
      'sakuga-style fluid movement on key moments only.',
    musicHint:
      'anime opening, J-pop orchestral hybrid, soaring strings, energetic drums, emotional build',
    avoid:
      'photorealistic, live-action, 3D CGI, hyperrealistic skin texture, western cartoon style',
    captureId: 'anime-cel',
    styleBibleCompact:
      'Cel-animated look: clean lineart, flat two-tone shading, painted backgrounds, vivid harmonious palette, strong golden-hour rim light, one consistent character model.',
    recommendedParams: { aspectRatio: '16:9', resolution: '1080p', fixedLens: false }
  },
  {
    id: 'commercial',
    label: 'Commercial / advertising',
    description:
      'Polished product-advertising look — studio lighting, macro details, punchy grading.',
    styleBible:
      'Art direction: high-end TV commercial. Immaculate studio or lifestyle set, controlled three-point lighting with ' +
      'soft key and crisp speculars, shallow depth of field on macro product details, punchy contrast grading with clean ' +
      'whites. Aspirational, energetic mood. The product is always the hero of the frame.',
    imageFragment:
      'Product photography quality, perfect surfaces, subtle reflections on a seamless backdrop, no clutter, ad-ready composition with negative space for copy.',
    videoFragment:
      'Confident slow camera moves: dolly-in on the product, orbital reveal, whip-pan transitions between scenes, ' +
      'satisfying slow-motion detail shots (pours, splashes, textures). Fast overall pacing, each beat 2-4 seconds with clear intent.',
    musicHint:
      'upbeat commercial pop, claps and stomps, bright synth hooks, feel-good, 110-120 BPM',
    avoid:
      'dull flat lighting, handheld shakiness, muted desaturated grading, visible brand logos other than the product',
    captureId: 'high-end-commercial',
    styleBibleCompact:
      'Immaculate set, controlled three-point light with soft key and crisp speculars, shallow depth on macro details, punchy contrast with clean whites, the product always the hero of the frame.',
    recommendedParams: { aspectRatio: '16:9', resolution: '1080p', fixedLens: false }
  },
  {
    id: 'cinematic-realism',
    label: 'Cinematic realism',
    description: 'Live-action feature-film look — anamorphic lenses, natural light, filmic grain.',
    styleBible:
      'Art direction: photorealistic live-action cinema. Shot on anamorphic lenses, shallow depth of field, natural ' +
      'motivated lighting with soft practicals, filmic color grading with teal-orange restraint, subtle film grain and ' +
      'halation. Grounded performances, authentic locations, atmospheric haze for depth.',
    imageFragment:
      'Film still quality, true-to-life skin tones and textures, natural imperfections, cinematic composition following the rule of thirds.',
    videoFragment:
      'Deliberate camera language: slow dolly and tracking shots, occasional handheld for tension, long takes over fast cuts. ' +
      'Motivated movement only — the camera moves because the story does.',
    musicHint:
      'cinematic film score, emotional strings and piano, subtle percussion, slow build, atmospheric',
    avoid:
      'cartoon, illustration, oversaturated colors, artificial-looking CGI, vlog-style framing',
    captureId: 'cinematic-35mm',
    styleBibleCompact:
      'Anamorphic glass, shallow depth of field, motivated natural light with soft practicals, restrained filmic grade, fine grain and halation, atmospheric haze for depth.',
    recommendedParams: { aspectRatio: '21:9', resolution: '1080p', fixedLens: false }
  },
  {
    id: 'documentary',
    label: 'Documentary',
    description:
      'Naturalistic documentary look — available light, observational camera, honest textures.',
    styleBible:
      'Art direction: observational documentary. Available natural light, true colors with a gentle neutral grade, ' +
      'honest textures and real-world imperfection, medium depth of field. Intimate but respectful framing, ' +
      'authentic environments over staged sets.',
    imageFragment:
      'Reportage photography quality, candid feel, environmental context in frame, no staging artifacts.',
    videoFragment:
      'Observational camera: gentle handheld drift, slow reframing pans, patient static shots on tripod for interviews. ' +
      'No flashy transitions, let scenes breathe.',
    musicHint:
      'minimal ambient score, warm acoustic textures, sparse piano, unobtrusive, contemplative',
    avoid: 'dramatic stylized lighting, speed ramps, heavy color grading, glossy commercial polish',
    captureId: 'verite-16mm',
    styleBibleCompact:
      'Available natural light, true colors under a gentle neutral grade, honest textures and real-world imperfection, medium depth of field, authentic environments over staged sets.',
    recommendedParams: { aspectRatio: '16:9', resolution: '1080p', fixedLens: true }
  },
  {
    // The stylized register (§6.9 MODE C). It exists as a STYLE, not as a
    // per-node switch, because the realism and stylized registers run on
    // opposite camera doctrines: mixing them inside one film produces neither.
    // Choosing this art direction is how a piece opts into the ghost camera.
    id: 'kinetic-action',
    label: 'Kinetic action / stylized',
    description:
      'Choreographed, impossible action — weightless camera, speed ramps, hero framing. Trailer energy.',
    styleBible:
      'Art direction: stylized kinetic action. One seamless continuous take with aggressive in-camera speed ramps, ' +
      'a weightless invisible camera that is never a character, low-angle hero framing and canted finishes. ' +
      'High-contrast punchy grade, hard flares on energy and sparks, brutal but designed physics with real weight.',
    imageFragment:
      'Hero key-art composition, low camera, strong rim and flare, high contrast, dynamic diagonal staging.',
    videoFragment:
      'Speed ramping on dramatic function only — real time into slow motion on the moment of contact, snapping back on the consequence. ' +
      'Impacts scored as event then camera answer, varying direction: snap in, snap out, crash low.',
    musicHint: 'trailer percussion, braams and risers, hybrid orchestral, hard hits on impacts',
    avoid: 'handheld shake, documentary framing, autofocus hunting, muted naturalistic grading',
    captureId: 'stylized-kinetic',
    styleBibleCompact:
      'Weightless invisible camera, aggressive speed ramps, low-angle hero framing and canted finishes, high-contrast punchy grade, hard flares on energy, brutal designed physics with real weight.',
    recommendedParams: { aspectRatio: '21:9', resolution: '1080p', fixedLens: false }
  }
]

const STYLE_MAP = new Map(STYLES.map((s) => [s.id, s]))

/**
 * Node-params marker (deliberately not a model field — run-time validation
 * strips it): when true, the run engine appends the video's current style
 * bible to the prompt at payload time. Stored prompts stay business-only, so
 * a style change propagates to every flagged node with no prompt edit.
 * Absent = false: pre-existing nodes keep their baked-in bible untouched.
 */
export const APPLY_VIDEO_STYLE_PARAM = 'applyVideoStyle'

export function nodeAppliesVideoStyle(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    (params as Record<string, unknown>)[APPLY_VIDEO_STYLE_PARAM] === true
  )
}

/** The single prompt+bible composition rule for STILLS (run engine and UI preview agree). */
export function appendStyleBible(prompt: string, styleBible: string): string {
  const base = prompt.trim()
  return base === '' ? styleBible : `${base}\n\n${styleBible}`
}

/**
 * §6.9 — how a style reaches a prompt at payload time, per media kind.
 *
 * Stills keep the historical rule: the bible is appended, because a still has
 * no capture medium to declare and no look to hold across time.
 *
 * MOVING IMAGES get the sandwich. The opening declaration goes FIRST — it is
 * the highest-leverage element of a video prompt, a domain selector that pulls
 * a coherent slice of footage (grain, motion physics, framing habits, light
 * behaviour) all agreeing with each other — carrying the compressed look bible
 * with it. The stored prompt stays pure action in the middle. The booster stack
 * closes, re-stating the medium so the look does not decay over the back half
 * of the clip.
 *
 * The full bible is deliberately NOT appended to a video prompt any more: a
 * long look paragraph at the tail competes with the action beats, and the
 * compressed version at the top does the same job where the model weighs it
 * most. The bible remains the reference document (docs "styles", the panel).
 */
export function wrapPromptWithStyle(args: {
  prompt: string
  style: StyleTemplate
  kind: 'image' | 'video' | 'audio'
}): string {
  if (args.kind !== 'video') return appendStyleBible(args.prompt, args.style.styleBible)
  const declaration = getCaptureDeclaration(args.style.captureId)
  // A style whose declaration went missing must not silently lose its art
  // direction — fall back to the historical append rather than emit nothing.
  if (!declaration) return appendStyleBible(args.prompt, args.style.styleBible)
  const booster = getBoosterStack(declaration.boosterId)
  return wrapSeedanceSandwich(args.prompt, {
    declaration: declaration.text,
    lookCompact: args.style.styleBibleCompact,
    booster: booster?.text ?? ''
  })
}

export function getStyle(id: string): StyleTemplate | undefined {
  return STYLE_MAP.get(id)
}

export const styleIds = STYLES.map((s) => s.id)

export function isStyleId(id: string): boolean {
  return STYLE_MAP.has(id)
}
