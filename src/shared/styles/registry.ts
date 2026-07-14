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
    recommendedParams: { aspectRatio: '16:9', resolution: '1080p', fixedLens: true }
  }
]

const STYLE_MAP = new Map(STYLES.map((s) => [s.id, s]))

export function getStyle(id: string): StyleTemplate | undefined {
  return STYLE_MAP.get(id)
}

export const styleIds = STYLES.map((s) => s.id)

export function isStyleId(id: string): boolean {
  return STYLE_MAP.has(id)
}
