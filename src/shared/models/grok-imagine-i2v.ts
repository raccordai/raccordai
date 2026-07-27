import { z } from 'zod'
import type { ModelDefinition } from './types'

// 'auto' is a UI value: the field is omitted from the payload (the API only
// honors aspect_ratio in multi-image mode; otherwise the source image rules).
const ASPECT = ['auto', '16:9', '9:16', '1:1', '2:3', '3:2'] as const
const RESOLUTION = ['480p', '720p'] as const
// 'spicy' exists API-side but is rejected with external image URLs — which is
// the only way Raccord feeds images — so it is not offered here.
const MODE = ['normal', 'fun'] as const

/** API floor is 6s; the schema tolerates lower values saved by Grok 1.5 nodes. */
const MIN_API_DURATION = 6

const paramsSchema = z.object({
  prompt: z.string().max(5000).default(''),
  aspect_ratio: z.enum(ASPECT).default('auto'),
  mode: z.enum(MODE).default('normal'),
  duration: z.number().int().min(1).max(30).default(8),
  resolution: z.enum(RESOLUTION).default('480p'),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const grokImagineI2V: ModelDefinition<Params> = {
  id: 'grok-imagine/image-to-video',
  label: 'Grok Imagine — Image to Video',
  description:
    'Animate up to 7 source images with a motion prompt (Grok Imagine). Native audio, 6-30s clips.',
  kind: 'video',
  recommendedFor: ['first-frame-animation', 'native-audio'],
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Motion prompt',
      type: 'textarea',
      defaultValue: '',
      description: 'Describe the MOTION — the images already provide the scene. Max 5000 chars.'
    },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: MIN_API_DURATION,
      max: 30,
      step: 1,
      defaultValue: 8,
      description:
        'Whole seconds, 6 to 30. Values below 6 s saved by older nodes are snapped up at run.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description:
        '`auto` follows the source image. A fixed ratio only applies with several images.'
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '480p',
      options: RESOLUTION.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      defaultValue: 'normal',
      options: MODE.map((v) => ({ value: v, label: v })),
      description: '`fun` exaggerates motion.'
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
      maxCount: 7,
      frameAnchor: true,
      referenceAlias: '@image',
      description:
        'Up to 7 source images (JPEG/PNG/WEBP, 10MB each) that APPEAR in the video, referenced as @image1, @image2, … in the motion prompt.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Grok Imagine animates up to 7 images — the connected images ARE the visual content of the video (frame anchors, like Seedance 1.5; NOT invisible references like Seedance 2). Never wire a character sheet or storyboard here.\n' +
    'In the motion prompt, reference each as `@image1 `, `@image2 `, … (lowercase, each followed by a space) — e.g. "@image1 slowly walks forward, wind in the hair".\n' +
    'Numbering follows connection order (shown in the UI). Connect at least one image.\n' +
    'Duration is 6-30 seconds (default 8). Keep `aspect_ratio` on `auto` to follow the source image (a fixed ratio only matters with several images).\n' +
    "Between shots, CUT — do not chain. Wiring this node's `lastFrame` into the next clip's image input makes the seam glitch (a generated closing frame is motion-blurred and compressed). Cut to a new camera setup instead, and keep subjects consistent by re-anchoring each shot on the SAME clean source image.",
  // Distilled from xAI's official docs (docs.x.ai) and xAI's Replicate model listing.
  promptGuide: `CORE PRINCIPLE (official xAI guidance):
  Describe the MOTION, not the scene — the connected image already provides the scene.
  Say what should CHANGE: action, camera movement, atmosphere. Never re-describe or contradict
  the source image (don't write "a woman dances" if the image shows a man).

MOTION:
  - Be specific about intensity: "car racing past at high speed", not "car passing".
  - One or two actions max — too many simultaneous actions degrade the clip.
  - Natural sentences, not tag stacking. Think like a director.
  - Sweet spot: 6-10 second clips; keep the motion brief and readable.

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
  aspect_ratio=auto follows the source image (recommended); a fixed ratio only applies when
  several images are connected. Duration 6-30s, default 8.

PITFALLS:
  - Negative prompts are ignored — phrase everything positively.
  - English prompts only.
  - Vague motion verbs without intensity produce timid animation.
  - When the clip belongs to a styled workflow, keep the style bible short here (motion first).

FULL EXAMPLES (official patterns):
  "@image1 slowly turns her head to the right and smiles, soft breeze moving her hair, gentle camera push-in."
  "@image1 the sneaker rotates smoothly on the pedestal, camera orbiting at eye level, dramatic spotlight
  sweeping across the surface, upbeat electronic music."`,
  // No estimateCredits: kie.ai publishes no rate for this generation of Grok
  // yet — fill in from the dashboard (https://kie.ai/pricing); never guess.
  buildPayload: ({ params, inputs }) => ({
    image_urls: inputs.image_urls ?? [],
    prompt: params.prompt,
    mode: params.mode,
    // Old Grok 1.5 nodes may carry 1-5s durations — snap to the API floor.
    duration: Math.max(MIN_API_DURATION, params.duration),
    resolution: params.resolution,
    nsfw_checker: params.nsfw_checker,
    ...(params.aspect_ratio !== 'auto' ? { aspect_ratio: params.aspect_ratio } : {})
  })
}
