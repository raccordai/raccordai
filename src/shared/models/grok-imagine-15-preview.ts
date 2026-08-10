import { z } from 'zod'
import type { ModelDefinition } from './types'

/**
 * Grok Imagine Video 1.5 (preview) — kie.ai jobs API.
 * API reference: https://docs.kie.ai/market/grok-imagine/1-5-preview
 * One model for BOTH text-to-video and image-to-video (images optional), unlike
 * the plain Grok Imagine pair. Distinctives vs plain Grok: 1-15 s clips (the
 * only Grok that can go under 6 s), 1080p available (single image only),
 * prompt cap 4096, no fun/spicy modes.
 */

// 'auto' is a UI value: it follows the source image (or the model's default in
// pure text-to-video). The API enum adds nothing else.
const ASPECT = ['auto', '16:9', '9:16', '1:1', '2:3', '3:2'] as const
// Nodes saved before this model was retired (then restored) may carry 4:3/3:4 —
// tolerated by the schema, mapped to the closest current ratio in buildPayload.
const LEGACY_ASPECT = ['4:3', '3:4'] as const
const LEGACY_ASPECT_MAP: Record<string, string> = { '4:3': '3:2', '3:4': '2:3' }
const RESOLUTION = ['480p', '720p', '1080p'] as const

const paramsSchema = z.object({
  prompt: z.string().max(4096).default(''),
  aspect_ratio: z.enum([...ASPECT, ...LEGACY_ASPECT]).default('auto'),
  duration: z.number().int().min(1).max(15).default(8),
  resolution: z.enum(RESOLUTION).default('480p'),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const grokImagine15Preview: ModelDefinition<Params> = {
  id: 'grok-imagine-video-1-5-preview',
  label: 'Grok Imagine 1.5 (Preview)',
  description:
    'Text-to-video or animate up to 7 source images (Grok Imagine 1.5). Native audio, 1-15s clips, up to 1080p.',
  kind: 'video',
  recommendedFor: ['text-to-video', 'first-frame-animation', 'native-audio'],
  // No cheaper sibling — draft = same model forced to 480p.
  draftEquivalent: { modelId: 'grok-imagine-video-1-5-preview', params: { resolution: '480p' } },
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description:
        'With images: describe the MOTION only. Without: scene + motion. English only, max 4096 chars.'
    },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 1,
      max: 15,
      step: 1,
      defaultValue: 8,
      description: 'Whole seconds, 1 to 15 — the only Grok that can go under 6 s.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description: '`auto` follows the source image (recommended with images).'
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '480p',
      options: RESOLUTION.map((v) => ({ value: v, label: v })),
      description: '1080p accepts a single source image at most.'
    },
    { key: 'nsfw_checker', label: 'NSFW checker', type: 'boolean', defaultValue: true }
  ],
  inputs: [
    {
      key: 'image_urls',
      label: 'Source images',
      accepts: ['image'],
      multiple: true,
      maxCount: 7,
      frameAnchor: true,
      referenceAlias: '@image',
      description:
        'Optional: up to 7 source images (JPEG/PNG/WEBP, 20MB each — only 1 at 1080p) that APPEAR in the video, referenced as @image1, @image2, … in the motion prompt. Leave empty for text-to-video.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Grok Imagine 1.5 does BOTH text-to-video (no image) and image-to-video: connected images ARE the visual content of the video (frame anchors, like Seedance 1.5; NOT invisible references like Seedance 2). Never wire a character sheet or storyboard here.\n' +
    'With images, describe the MOTION only and reference each as `@image1 `, `@image2 `, … (lowercase, each followed by a space) — numbering follows connection order. Without images, the prompt carries scene + motion. English only, max 4096 chars.\n' +
    'Duration is 1-15 seconds (default 8) — the only Grok that can produce sub-6s clips. Up to 1080p, but 1080p accepts a SINGLE source image at most.\n' +
    'Keep `aspect_ratio` on `auto` to follow the source image; audio is native (BGM, SFX, quoted dialogue lines in the prompt).\n' +
    "Between shots, CUT — do not chain. Wiring this node's `lastFrame` into the next clip's image input makes the seam glitch (a generated closing frame is motion-blurred and compressed). Cut to a new camera setup instead, and keep subjects consistent by re-anchoring each shot on the SAME clean source image.",
  // Distilled from xAI's official docs (docs.x.ai) and xAI's Replicate model listing.
  promptGuide: `CORE PRINCIPLE (official xAI guidance):
  With a connected image, describe the MOTION, not the scene — the image already provides the scene.
  Say what should CHANGE: action, camera movement, atmosphere. Never re-describe or contradict
  the source image (don't write "a woman dances" if the image shows a man).
  In pure text-to-video, the prompt is the only source of truth: scene first (subject, setting,
  lighting), then motion (action, camera), in that order.

MOTION:
  - Be specific about intensity: "car racing past at high speed", not "car passing".
  - One or two actions max — too many simultaneous actions degrade the clip.
  - Natural sentences, not tag stacking. Think like a director.
  - Sweet spot: 5-8 second clips; keep the motion brief and readable.

CAMERA (vocabulary the model recognizes):
  pan, tilt, zoom, dolly, tracking shot, orbit, aerial, handheld, push-in, static framing.

IMAGE REFERENCES:
  Reference each connected image as \`@image1 \`, \`@image2 \` (lowercase, each followed by a space),
  numbered by connection order: "@image1 slowly turns her head and smiles". This is how this node's
  inputs are addressed — keep every reference in that exact form.

AUDIO (native — music, SFX, lip-synced dialogue in the same pass):
  Mention sound in the prompt: BGM style ("upbeat electronic music"), SFX ("footsteps on gravel"),
  ambience ("forest sounds with birdsong"). Short spoken lines go in quotes:
  she says happily: "thanks! Back to work". Optionally end with an "AUDIO:" section for sound design.

PARAMS:
  aspect_ratio=auto follows the source image (recommended); duration 1-15s, default 8 —
  this is the Grok to pick for beats shorter than 6 s. 1080p allows one source image at most.

PITFALLS:
  - Negative prompts are ignored — phrase everything positively.
  - English prompts only.
  - Vague motion verbs without intensity produce timid animation.
  - When the clip belongs to a styled workflow, keep the style bible short here (motion first).

FULL EXAMPLES (official patterns):
  "@image1 slowly turns her head to the right and smiles, soft breeze moving her hair, gentle camera push-in."
  "@image1 the sneaker rotates smoothly on the pedestal, camera orbiting at eye level, dramatic spotlight
  sweeping across the surface, upbeat electronic music."`,
  // kie.ai rates as shipped before this model was retired: 1 cr/s at 480p,
  // 2 cr/s at 720p. 1080p is UNVERIFIED — derived from xAI's own per-second
  // ratio (0.25/0.08 ≈ 3×480p); confirm against https://kie.ai/pricing.
  estimateCredits: (params) =>
    ({ '480p': 1, '720p': 2, '1080p': 3 })[params.resolution] * params.duration,
  buildPayload: ({ params, inputs }) => {
    const images = inputs.image_urls ?? []
    if (params.resolution === '1080p' && images.length > 1) {
      throw new Error('1080p accepts a single source image — drop to 720p or keep one image.')
    }
    return {
      ...(images.length > 0 ? { image_urls: images } : {}),
      prompt: params.prompt,
      // Legacy nodes may store 4:3/3:4 (pre-retirement enum) — map to the
      // closest ratio the current API accepts.
      aspect_ratio: LEGACY_ASPECT_MAP[params.aspect_ratio] ?? params.aspect_ratio,
      duration: params.duration,
      resolution: params.resolution,
      nsfw_checker: params.nsfw_checker
    }
  }
}
