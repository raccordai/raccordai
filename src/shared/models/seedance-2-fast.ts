import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const
const RESOLUTION = ['480p', '720p'] as const

const paramsSchema = z.object({
  prompt: z.string().max(20000).default(''),
  generate_audio: z.boolean().default(true),
  resolution: z.enum(RESOLUTION).default('720p'),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  duration: z.number().int().min(4).max(15).default(15),
  web_search: z.boolean().default(false),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const seedance2Fast: ModelDefinition<Params> = {
  id: 'bytedance/seedance-2-fast',
  label: 'Seedance 2 Fast',
  description:
    'Video generation driven by @ references: connected images/videos/audio GUIDE identity, style and motion without appearing on screen (unless given a frame role). The model for character sheets, storyboards and style boards.',
  kind: 'video',
  paramsSchema,
  paramFields: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 4,
      max: 15,
      step: 1,
      defaultValue: 15
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
    { key: 'generate_audio', label: 'Generate audio', type: 'boolean', defaultValue: true },
    { key: 'web_search', label: 'Web search', type: 'boolean', defaultValue: false },
    { key: 'nsfw_checker', label: 'NSFW checker', type: 'boolean', defaultValue: true }
  ],
  inputs: [
    {
      key: 'reference_image_urls',
      label: 'Reference images',
      accepts: ['image'],
      multiple: true,
      maxCount: 9,
      referenceAlias: '@Image',
      description:
        'Each connection is numbered @Image1, @Image2, … (max 9). References GUIDE the output (identity, style) and do NOT appear on screen — unless the prompt assigns a frame role: "@Image1 as the first frame".'
    },
    {
      key: 'reference_video_urls',
      label: 'Reference videos',
      accepts: ['video'],
      multiple: true,
      maxCount: 3,
      referenceAlias: '@Video',
      description: 'Each connection is numbered @Video1, @Video2, @Video3. Combined length ≤ 15s.'
    },
    {
      key: 'reference_audio_urls',
      label: 'Reference audios',
      accepts: ['audio'],
      multiple: true,
      maxCount: 3,
      referenceAlias: '@Audio',
      description: 'Each connection is numbered @Audio1, @Audio2, @Audio3. Combined length ≤ 15s.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Seedance 2.0 uses the @ reference system — assign each connected source a clear role in the prompt.\n' +
    'References GUIDE the output without appearing on screen: this is THE model for character sheets, storyboards and style boards (on Seedance 1.5, connected images literally become frames). To show a reference literally, give it a frame role: "@Image1 as the first frame".\n' +
    'Examples: "@Image1 as the first frame", "@Image2 as the last frame", "reference @Video1\'s camera movement", "BGM references @Audio1".\n' +
    'For 10s+ outputs, structure the prompt as numbered shots ("Shot 1: ... Shot 2: Cut to ...") with action, camera, audio per shot — ByteDance flags exact timestamps (0–3s style) as unstable.\n' +
    'For clip-to-clip continuity: connect the previous video node\'s `lastFrame` output to this node\'s `reference_image_urls` input, then prompt "@Image1 as the first frame" so Seedance picks up exactly where the prior clip ended.\n' +
    'Total uploads cap: ≤ 12 files combined. Restriction: no realistic human faces in references (platform compliance).',
  // Distilled from ByteDance's official Seedance 2.0 prompt guide (BytePlus/Volcengine doc 2222480),
  // cross-checked with fal.ai and kie.ai docs. Notably: the official guide flags exact timestamps
  // as UNSTABLE — shot-numbered structure is the supported long-clip syntax.
  promptGuide: `ANATOMY (official ByteDance order):
  Precise subject + action detail + scene/environment + lighting & color tone + camera movement
  + visual style + image quality + constraints.
Think of the prompt as a short shot brief: who, doing what, where, shot how, what it sounds like.

@ REFERENCES (the core of Seedance 2.0 — every connected source needs an explicit ROLE):
  - Slots: @Image1-@Image9, @Video1-@Video3, @Audio1-@Audio3 (numbered by connection order, ≤12 files total).
  - Assign roles verbatim: "@Image1 as the first frame", "@Image2 as the last frame",
    "reference @Video1 for camera movement and pacing", "use @Audio1 as background music",
    "Replace the woman in @Video1 with @Image1", "Extend @Video1 by 5 seconds".
  - Subject binding: define each subject ONCE with 2-3 stable traits ("the woman in the red dress from
    @Image1"), then reuse the same @ImageN on every mention. Contradictory traits cause identity drift.
  - Budget: 4-5 references is the sweet spot (1-2 character images, 1 scene, 1 camera video, 1 audio);
    more causes style collision and subject-recognition blur.
  - First-frame / first+last-frame anchoring and multimodal reference mode are mutually exclusive.

MULTI-SHOT (long clips — 10s+):
  Shot 1: [camera move] + [subject action/expression] + [location] + [audio].
  Shot 2: Cut to ... (one camera movement per shot; ~3 cuts per generation stay consistent)
  DO NOT use exact timestamps ("0-3s:") — officially flagged as unstable.

DIALOGUE & AUDIO:
  - Quoted dialogue works on API platforms: She says: "Keep lines short." State language and tone.
  - Voice cloning: reference a voice via @Audio1 plus traits ("low, warm male voice from @Audio1").
  - The model scores everything by default — write "no music" explicitly if you want silence.

STYLE & QUALITY (required — prevents style collapse toward photorealism):
  - Always include a strong style keyword: "2D anime", "3D CG fantasy", "vintage film", "cyberpunk
    cool blue-purple", "high-end commercial style"... plus a quality tail: "high-definition, rich
    detail, cinematic texture, natural color, soft lighting".
  - Standard constraint line to append: "faces stable, smooth motion, no stutter or flicker,
    no subtitles, no watermarks, no duplicate identical characters".
  - When the video belongs to a styled workflow, append the video's style bible verbatim.

PITFALLS (official troubleshooting):
  - Identity drift → clean headshot + separate full-body reference; put the priority reference first.
  - Burned-in subtitles → "no subtitles" constraint + text-free reference sources.
  - Anime drifting photoreal → the style keyword is missing or too weak.
  - "Twin" subject duplication → single-subject references + "no identical duplicates".
  - Adjective stacking ("stunning, gorgeous") does nothing — spend words on verbs and physics.

FULL EXAMPLE (official pattern):
  "Girl @Image1 as protagonist, @Image2 as scene style reference, reference @Video1's camera movement.
  Shot 1: Late afternoon, girl @Image1 walks briskly to the door, medium tracking shot, warm golden light.
  Shot 2: Cut to indoor medium shot, roommates look up, one asks: 'How did the exam go?', camera pans.
  Shot 3: Close-up, she lowers her head, then looks up laughing: 'Just kidding!', camera pulls back wide.
  HD cinematic documentary style, warm tone, soft lighting; faces stable, smooth motion, no subtitles."`,
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  estimateCredits: (params) => (params.resolution === '720p' ? 4 : 2) * params.duration,
  buildPayload: ({ params, inputs }) => ({
    prompt: params.prompt,
    reference_image_urls: inputs.reference_image_urls ?? [],
    reference_video_urls: inputs.reference_video_urls ?? [],
    reference_audio_urls: inputs.reference_audio_urls ?? [],
    generate_audio: params.generate_audio,
    resolution: params.resolution,
    aspect_ratio: params.aspect_ratio,
    duration: params.duration,
    web_search: params.web_search,
    nsfw_checker: params.nsfw_checker
  })
}
