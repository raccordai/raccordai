import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const
const RESOLUTION = ['480p', '720p'] as const

const paramsSchema = z.object({
  prompt: z.string().max(4096).default(''),
  aspect_ratio: z.enum(ASPECT).default('auto'),
  duration: z.number().int().min(1).max(15).default(8),
  resolution: z.enum(RESOLUTION).default('480p'),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const grokImagineI2V: ModelDefinition<Params> = {
  id: 'grok-imagine-video-1-5-preview',
  label: 'Grok Imagine 1.5 — Image to Video',
  description: 'Animate one or more source images with a motion prompt (Grok Imagine Video 1.5).',
  kind: 'video',
  paramsSchema,
  paramFields: [
    { key: 'prompt', label: 'Motion prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 1,
      max: 15,
      step: 1,
      defaultValue: 8
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description: '`auto` follows the source image dimensions.'
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '480p',
      options: RESOLUTION.map((v) => ({ value: v, label: v }))
    },
    { key: 'nsfw_checker', label: 'NSFW checker', type: 'boolean', defaultValue: true }
  ],
  inputs: [
    {
      key: 'image_urls',
      label: 'Source images',
      accepts: ['image'],
      multiple: true,
      required: true,
      referenceAlias: '@image',
      description:
        'One or more source images, referenced as @image1, @image2, … in the motion prompt (lowercase, each followed by a space).'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Grok Imagine 1.5 animates one or more images — the connected images ARE the visual content of the video (frame anchors, like Seedance 1.5; NOT invisible references like Seedance 2). Never wire a character sheet or storyboard here.\n' +
    'In the motion prompt, reference each as `@image1 `, `@image2 `, … (lowercase, each followed by a space) — e.g. "@image1 slowly walks forward, wind in the hair".\n' +
    'Numbering follows connection order (shown in the UI). Connect at least one image.\n' +
    'Duration is 1–15 seconds (default 8). Set `aspect_ratio` to `auto` to follow the source image, or pick a fixed ratio.\n' +
    "For continuity to the next clip: wire this node's `lastFrame` output into the next video node's image input (`image_urls` for another Grok, or `reference_image_urls` for Seedance).",
  // Distilled from xAI's official docs (docs.x.ai) and xAI's Replicate model listing.
  promptGuide: `CORE PRINCIPLE (official xAI guidance):
  Describe the MOTION, not the scene — the connected image already provides the scene.
  Say what should CHANGE: action, camera movement, atmosphere. Never re-describe or contradict
  the source image (don't write "a woman dances" if the image shows a man).

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
  aspect_ratio=auto follows the source image (recommended); forcing a different ratio STRETCHES it.
  Duration 1-15s, default 8.

PITFALLS:
  - Negative prompts are ignored — phrase everything positively.
  - Vague motion verbs without intensity produce timid animation.
  - When the clip belongs to a styled workflow, keep the style bible short here (motion first).

FULL EXAMPLES (official patterns):
  "@image1 slowly turns her head to the right and smiles, soft breeze moving her hair, gentle camera push-in."
  "@image1 the sneaker rotates smoothly on the pedestal, camera orbiting at eye level, dramatic spotlight
  sweeping across the surface, upbeat electronic music."`,
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  estimateCredits: (params) => (params.resolution === '720p' ? 2 : 1) * params.duration,
  buildPayload: ({ params, inputs }) => ({
    image_urls: inputs.image_urls ?? [],
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio,
    duration: params.duration,
    resolution: params.resolution,
    nsfw_checker: params.nsfw_checker
  })
}
