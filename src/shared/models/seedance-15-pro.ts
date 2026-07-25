import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const
const RESOLUTION = ['480p', '720p', '1080p'] as const
/** kie.ai only accepts these clip lengths (sent as strings: "4" | "8" | "12"). */
const DURATIONS = [4, 8, 12] as const

const paramsSchema = z.object({
  prompt: z.string().max(2500).default(''),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  resolution: z.enum(RESOLUTION).default('720p'),
  // Stored as a number so the timeline can read clip durations; snapped to 4/8/12 in buildPayload.
  duration: z.number().int().min(4).max(12).default(8),
  fixed_lens: z.boolean().default(false),
  generate_audio: z.boolean().default(true),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const seedance15Pro: ModelDefinition<Params> = {
  id: 'bytedance/seedance-1.5-pro',
  label: 'Seedance 1.5 Pro',
  description:
    'Cinematic video generation (text-to-video or image-to-video with up to 2 frames), up to 1080p with native audio and dialogue.',
  kind: 'video',
  recommendedFor: ['first-frame-animation', 'dialogue-audio', 'cinematic'],
  // No cheaper sibling — draft = same model floored to 480p (2 cr/s vs 10 at 1080p).
  draftEquivalent: { modelId: 'bytedance/seedance-1.5-pro', params: { resolution: '480p' } },
  paramsSchema,
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  estimateCredits: (params) =>
    ({ '480p': 2, '720p': 5, '1080p': 10 })[params.resolution] * params.duration,
  paramFields: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 4,
      max: 12,
      step: 4,
      defaultValue: 8,
      description: 'Allowed lengths: 4, 8 or 12 seconds (other values are snapped to the closest).'
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
      defaultValue: '720p',
      options: RESOLUTION.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'fixed_lens',
      label: 'Fixed lens',
      type: 'boolean',
      defaultValue: false,
      description: 'Keep the camera static and stable (off = dynamic camera movement).'
    },
    {
      key: 'generate_audio',
      label: 'Generate audio',
      type: 'boolean',
      defaultValue: true,
      description: 'Create sound effects / dialogue audio for the video (additional cost).'
    },
    { key: 'nsfw_checker', label: 'NSFW checker', type: 'boolean', defaultValue: true }
  ],
  inputs: [
    {
      key: 'input_urls',
      label: 'Frame anchors (first/last)',
      accepts: ['image'],
      multiple: true,
      maxCount: 2,
      frameAnchor: true,
      description:
        '0-2 images (jpeg/png/webp, ≤10MB) that APPEAR IN THE VIDEO literally: 1 image = the exact first frame; 2 = first + last frame. ' +
        'NEVER wire a character sheet, storyboard or style reference here — it would show up on screen. ' +
        'For reference-guided generation (design sheets, style boards), use Seedance 2 Fast instead. Leave empty for text-to-video.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Seedance 1.5 Pro is a classic t2v/i2v model — no @ reference system. The prompt (3-2500 chars) drives everything: shot type, style, action, and spoken dialogue in quotes (e.g. the bartender says: "Welcome, friends!").\n' +
    'CRITICAL — `input_urls` are FRAME ANCHORS, not references: every connected image literally APPEARS in the video (1 image = first frame; 2 = first + last, great for controlled transitions). ' +
    'A character design sheet or storyboard wired here shows up on screen in the opening frames. When you need an image to GUIDE the output without appearing (character/style consistency), switch the node to Seedance 2 Fast and use its @Image references.\n' +
    "For clip-to-clip continuity: wire the previous video node's `lastFrame` output into this node's `input_urls` so the clip starts exactly where the prior one ended — that IS the intended use of frame anchoring.\n" +
    'Enable `fixed_lens` for a locked-off static camera; leave it off for dynamic movement. `generate_audio` adds sound effects/dialogue at extra cost.',
  // Distilled from ByteDance's official prompt guide (BytePlus ModelArk doc 2168087),
  // cross-checked with fal.ai's and Replicate's Seedance 1.5 guides.
  promptGuide: `ANATOMY (official ByteDance order — follow it):
  Subject + Movement + Environment + Camera movement + Aesthetic/style + Sound
Specificity beats prose: concrete character attributes (age, clothing, emotion), concrete verbs with
intensity ("sprints, out of breath" not "moves"), physical consequences (dust kicked up, hair whipping).

CAMERA (vocabulary the model reads reliably):
  dolly-in / dolly-out, pan, tilt, track / tracking shot, follow, orbit / surround, rise, fall,
  zoom, push-in, pull-back, truck, dolly zoom (Hitchcock = dolly-in + zoom-out).
Compose a move as: starting frame + movement type + amplitude + ending frame.
One clear camera intention per clip; \`fixed_lens: true\` is the way to lock the camera (not prompt words).

DIALOGUE & AUDIO (native, lip-synced):
  - Spoken lines in quotes, with a speaker label for multi-person scenes:
      Indian woman: "This place looks sketchy, but the food smells amazing." Black man: "That's always a good sign."
  - Voiceover: A deep, calm male voice says, "In the vast silence of the universe..."
  - State the language and the tone/speech rate ("she whispers slowly, in French").
  - Sound effects are plain narrative description: "raindrops merging into streams flowing down the glass".
  - BGM is generated by default — steer it with mood/style descriptors, or write "no music" for silence.

MULTI-SHOT (single prompt, several cuts):
  Shot 1: Medium shot, ... Shot 2: Cut to a close-up, ... Shot 3: Cut to ...
Use "cut to"/"then" for transitions. Keep monologues short per shot — split speech across cuts.

STYLE:
  Name an aesthetic framework at the END of the prompt ("in the style of a Hayao Miyazaki film",
  "high-end commercial style, crisp details, premium mood"). Use professional photo/film terminology.
  When the video belongs to a styled workflow, append the video's style bible verbatim to every prompt.

IMAGE ANCHORING (frame anchors — NOT references):
  1 connected image = first frame (describe the MOTION, don't re-describe the image);
  2 images = first + last frame (controlled transitions). Use clear, well-lit faces in input images.
  Every connected image APPEARS on screen. Never anchor a character sheet, storyboard or style
  board — it becomes the opening frame. Reference-guided identity/style belongs to Seedance 2's
  @Image system; on 1.5 the ONLY consistency levers are the prompt and lastFrame chaining.

PITFALLS:
  - Vague subjects ("a person walking in a city") produce generic output — spend words on wardrobe, action, sound.
  - Contradictory audio/visual or camera instructions produce artifacts, not errors.
  - Not describing the soundscape wastes the audio branch — always write it when generate_audio is on.

FULL EXAMPLE:
  "Cyberpunk detective walking through a crowded night market, steam rising from food stalls, neon reflections
  on wet asphalt, camera follows from behind then orbits to the front, he mutters: 'Someone got here first.'
  Distant sirens, sizzling woks. Moody cinematic grade, shallow depth of field, film grain."`,
  buildPayload: ({ params, inputs }) => {
    // kie.ai only accepts 4/8/12 — snap whatever the node stored to the closest allowed value.
    const duration = DURATIONS.reduce((best, v) =>
      Math.abs(v - params.duration) < Math.abs(best - params.duration) ? v : best
    )
    return {
      prompt: params.prompt,
      input_urls: inputs.input_urls ?? [],
      aspect_ratio: params.aspect_ratio,
      resolution: params.resolution,
      duration: String(duration), // the API expects a string enum: "4" | "8" | "12"
      fixed_lens: params.fixed_lens,
      generate_audio: params.generate_audio,
      nsfw_checker: params.nsfw_checker
    }
  }
}
