import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['16:9', '9:16', '1:1', '2:3', '3:2'] as const
const RESOLUTION = ['480p', '720p'] as const
const MODE = ['normal', 'fun', 'spicy'] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(5000).default(''),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  mode: z.enum(MODE).default('normal'),
  duration: z.number().int().min(6).max(30).default(8),
  resolution: z.enum(RESOLUTION).default('480p'),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const grokImagineT2V: ModelDefinition<Params> = {
  id: 'grok-imagine/text-to-video',
  label: 'Grok Imagine — Text to Video',
  description:
    'Generate a video from a text prompt alone (Grok Imagine). Native audio, 6-30s clips.',
  kind: 'video',
  recommendedFor: ['text-to-video', 'native-audio'],
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description: 'Scene + motion, English only, up to 5000 characters.'
    },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 6,
      max: 30,
      step: 1,
      defaultValue: 8,
      description: 'Whole seconds, 6 to 30. The API floor is 6 s; 6-10 s reads best for one action.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: '16:9',
      options: ASPECT.map((v) => ({ value: v, label: v }))
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
      description: '`fun` exaggerates motion; `spicy` relaxes filtering.'
    },
    { key: 'nsfw_checker', label: 'NSFW checker', type: 'boolean', defaultValue: true }
  ],
  inputs: [],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Text-to-video: there is no source image, so the prompt must carry BOTH the scene (subject, setting, light) and the motion (action, camera). English only, max 5000 characters.\n' +
    'Duration is 6-30 seconds; audio is native (BGM, SFX, quoted dialogue lines in the prompt).\n' +
    'For an image-driven clip, use Grok Imagine — Image to Video instead.\n' +
    "Between shots, CUT — do not chain. Wiring this node's `lastFrame` into the next clip's image input makes the seam glitch (a generated closing frame is degraded); cut to a new camera setup instead.",
  // Distilled from xAI's official docs (docs.x.ai) — same engine family as the
  // image-to-video guide, minus the @image references (no image inputs here).
  promptGuide: `CORE PRINCIPLE:
  Unlike image-to-video, the prompt is the ONLY source of truth — describe the scene first
  (subject, setting, lighting), then the motion (action, camera), in that order.

MOTION:
  - Be specific about intensity: "car racing past at high speed", not "car passing".
  - One or two actions max — too many simultaneous actions degrade the clip.
  - Natural sentences, not tag stacking. Think like a director.

CAMERA (vocabulary the model recognizes):
  pan, tilt, zoom, dolly, tracking shot, orbit, aerial, handheld, push-in, static framing.

AUDIO (native — music, SFX, lip-synced dialogue in the same pass):
  Mention sound in the prompt: BGM style ("upbeat electronic music"), SFX ("footsteps on gravel"),
  ambience ("forest sounds with birdsong"). Short spoken lines go in quotes:
  she says happily: "thanks! Back to work". Optionally end with an "AUDIO:" section for sound design.

PARAMS:
  duration 6-30s. Sweet spot for a readable single action: 6-10s.
  mode=fun exaggerates motion and physics; mode=normal is the cinematic default.

PITFALLS:
  - Negative prompts are ignored — phrase everything positively.
  - English prompts only.
  - Vague motion verbs without intensity produce timid animation.

FULL EXAMPLE:
  "A weathered fisherman in a yellow raincoat stands at the bow of a small boat in heavy rain,
  gripping the rail as waves rock the hull, handheld camera, cold blue light, rain SFX and low
  ominous strings."`,
  // No estimateCredits: kie.ai publishes no rate for this model yet — fill in
  // from the dashboard (https://kie.ai/pricing) once known; never guess.
  buildPayload: ({ params }) => ({
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio,
    mode: params.mode,
    duration: params.duration,
    resolution: params.resolution,
    nsfw_checker: params.nsfw_checker
  })
}
