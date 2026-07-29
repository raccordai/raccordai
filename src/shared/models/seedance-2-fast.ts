import { z } from 'zod'
import type { ModelDefinition } from './types'
import { SEEDANCE2_PROMPT_GUIDE } from './seedance2-prompting'

const ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const
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
  recommendedFor: ['character-consistency', 'storyboard-driven', 'animation'],
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
      defaultValue: 15,
      description:
        'Whole seconds, 4 to 15. The API rejects anything shorter than 4 s — a beat that short must be merged with its neighbour, never rounded down.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: '16:9',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description: 'adaptive follows the input frame/reference dimensions.'
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
      key: 'first_frame_url',
      label: 'First frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        "This image IS the opening frame (literal anchor — a clean scene still or hero shot; never design sheets, and never the previous clip's lastFrame: a generated closing frame is degraded and makes the cut glitch). First frame only / first + last / @ references are three mutually exclusive modes per run."
    },
    {
      key: 'last_frame_url',
      label: 'Last frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        'This image IS the closing frame. With First frame set, prompt "Show me what happens in between. USE MULTIPLE CAMERA ANGLES." to generate the connecting story.'
    },
    {
      key: 'reference_image_urls',
      label: 'Reference images',
      accepts: ['image'],
      multiple: true,
      maxCount: 9,
      referenceAlias: '@Image',
      description:
        'Each connection is numbered @Image1, @Image2, … (max 9). References GUIDE the output (identity, style) and do NOT appear on screen — unless the prompt assigns a frame role: "@Image1 as the first frame". Wiring the SAME sheet on every shot is how you keep a subject consistent across cuts. jpeg/png/webp/bmp/tiff/gif, aspect ratio 0.4-2.5, 300-6000 px, ≤30 MB each.'
    },
    {
      key: 'reference_video_urls',
      label: 'Reference videos',
      accepts: ['video'],
      multiple: true,
      maxCount: 3,
      maxTotalSeconds: 15,
      referenceAlias: '@Video',
      description:
        "Each connection is numbered @Video1, @Video2, @Video3. mp4/mov, 480p or 720p, 2-15s each, ≤15s combined, ≤50 MB each. This is the video-extend channel — the reliable way to continue a shot, unlike chaining the previous clip's lastFrame. Also character swap and custom voice-over tracks."
    },
    {
      key: 'reference_audio_urls',
      label: 'Reference audios',
      accepts: ['audio'],
      multiple: true,
      maxCount: 3,
      maxTotalSeconds: 15,
      referenceAlias: '@Audio',
      description:
        'Each connection is numbered @Audio1, @Audio2, @Audio3. wav/mp3, 2-15s each, ≤15s combined, ≤15 MB each.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Seedance 2.0 uses the @ reference system — assign each connected source a clear role in the prompt.\n' +
    'References GUIDE the output without appearing on screen: this is THE model for character sheets, storyboards and style boards (on Seedance 1.5, connected images literally become frames). To show an image literally, use the First/Last frame anchor handles (mutually exclusive with @ references per run) — or give a reference a frame role: "@Image1 as the first frame".\n' +
    'ANIMATION verdict (300-generation test): Fast output is indistinguishable from full Seedance 2 — iterate and ship animation here; only the 720p cap differs (upscale externally, or switch the node to Seedance 2 for native 1080p/4k).\n' +
    'Examples: "reference @Video1\'s camera movement", "BGM references @Audio1", "Change the man in @Video1 to the robot in @Image1" (character swap), "Change the season in @Video1 to winter" (scene fix).\n' +
    'Between shots, CUT — do not chain. Wiring the previous node\'s `lastFrame` into this one makes the seam glitch (a generated closing frame is motion-blurred and compressed): change the camera setup instead and keep the SAME character sheet / storyboard wired as @ references on every shot. When continuity is truly required, use video extend (previous clip as @Video1 + "[cut]"-separated next beats) — it preserves set, identity AND voice.\n' +
    'Two clips only read as one sequence if each prompt says which frame it OPENS ON and which it CLOSES ON, and keeps the screen direction across the cut; the 4-panel shot board (designs recipe "shotboard") settles the hand-off on a cheap image, and the previous CLIP wired as @Video1 ("match its grade and wardrobe, do NOT continue its action") carries the look — at the cost of serializing the runs.\n' +
    'For 10s+ outputs, use numbered shots ("Shot 1: ... Shot 2: Cut to ...") or "[cut]" beats — ByteDance flags exact timestamps (0–3s style) as unstable.\n' +
    'Total uploads cap: ≤ 12 files combined. Restriction: no realistic human faces in references (platform compliance).',
  promptGuide: SEEDANCE2_PROMPT_GUIDE,
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  // kie bills a video-input run differently (price × (input + output) seconds, at
  // a lower unit price: 9 cr/s at 480p, 20 at 720p); `estimateCredits` only sees
  // params, never the wired handles, so the no-video rate is what we quote — the
  // higher per-output-second of the two, i.e. the estimate never under-sells.
  estimateCredits: (params) => ({ '480p': 15.5, '720p': 33 })[params.resolution] * params.duration,
  buildPayload: ({ params, inputs }) => {
    const first = inputs.first_frame_url?.[0]
    const last = inputs.last_frame_url?.[0]
    return {
      prompt: params.prompt,
      ...(first ? { first_frame_url: first } : {}),
      ...(last ? { last_frame_url: last } : {}),
      reference_image_urls: inputs.reference_image_urls ?? [],
      reference_video_urls: inputs.reference_video_urls ?? [],
      reference_audio_urls: inputs.reference_audio_urls ?? [],
      generate_audio: params.generate_audio,
      resolution: params.resolution,
      aspect_ratio: params.aspect_ratio,
      duration: params.duration,
      web_search: params.web_search,
      nsfw_checker: params.nsfw_checker
    }
  }
}
