import { z } from 'zod'
import type { ModelDefinition } from './types'
import { SEEDANCE25_PROMPT_GUIDE } from './seedance2-prompting'

const ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const
const RESOLUTION = ['480p', '720p', '1080p'] as const

const paramsSchema = z.object({
  prompt: z.string().max(30000).default(''),
  generate_audio: z.boolean().default(true),
  resolution: z.enum(RESOLUTION).default('720p'),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  // The API also accepts -1 (auto duration) — deliberately NOT exposed: the
  // timeline, the render plan and the credit estimate all read params.duration
  // as the clip's declared length, and -1 would poison all three.
  duration: z.number().int().min(4).max(30).default(5),
  web_search: z.boolean().default(false),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const seedance25: ModelDefinition<Params> = {
  id: 'bytedance/seedance-2-5',
  label: 'Seedance 2.5',
  description:
    'The newest Seedance generation: 4-30 s per run (a whole scene or a 30 s continuous take in ONE generation), stronger motion and physics, and a widened reference budget (30 images, 10 videos, 10 audios, 30 s of reference video). Same @ reference system and the same three exclusive input modes as the 2.0 tiers; caps at 1080p — a native-4k master still means Seedance 2.',
  kind: 'video',
  recommendedFor: ['long-takes', 'photorealism', 'complex-motion', 'character-consistency'],
  // Same model, floored to 480p: the schema/handles are its own, so every
  // duration (up to 30 s) and every wiring survives draft mode; a node already
  // at 480p resolves to null and is never stamped draft.
  draftEquivalent: { modelId: 'bytedance/seedance-2-5', params: { resolution: '480p' } },
  paramsSchema,
  paramFields: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 4,
      max: 30,
      step: 1,
      defaultValue: 5,
      description:
        'Whole seconds, 4 to 30. The API rejects anything shorter than 4 s — a beat that short must be merged with its neighbour, never rounded down. Above ~15 s, structure the prompt as numbered shots or one explicit continuous take.'
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
      options: RESOLUTION.map((v) => ({ value: v, label: v })),
      description: '1080p is the ceiling on 2.5 — native 4k stays a Seedance 2 exclusive.'
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
      maxCount: 30,
      referenceAlias: '@Image',
      description:
        'Each connection is numbered @Image1, @Image2, … (API cap 30 — but 4-5 stays the quality sweet spot). References GUIDE the output (identity, style) and do NOT appear on screen — unless the prompt assigns a frame role: "@Image1 as the first frame". Wiring the SAME sheet on every shot is how you keep a subject consistent across cuts. jpeg/png/webp/bmp/tiff/gif, aspect ratio 0.4-2.5, 300-6000 px, ≤30 MB each.'
    },
    {
      key: 'reference_video_urls',
      label: 'Reference videos',
      accepts: ['video'],
      multiple: true,
      maxCount: 10,
      maxTotalSeconds: 30,
      referenceAlias: '@Video',
      description:
        "Each connection is numbered @Video1, @Video2, … (max 10). mp4/mov, 480p or 720p, 2-30s each, ≤30s combined, ≤200 MB each. This is the video-extend channel — the reliable way to continue a shot, unlike chaining the previous clip's lastFrame. Also character swap and custom voice-over tracks."
    },
    {
      key: 'reference_audio_urls',
      label: 'Reference audios',
      accepts: ['audio'],
      multiple: true,
      maxCount: 10,
      maxTotalSeconds: 30,
      referenceAlias: '@Audio',
      description:
        'Each connection is numbered @Audio1, @Audio2, … (max 10). wav/mp3, 2-30s each, ≤30s combined, ≤15 MB each.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Same @ reference system as the Seedance 2.0 tiers — references GUIDE without appearing on screen; assign every connected source an explicit role. First/Last frame handles are literal anchors; first frame only / first + last / @ references stay three mutually exclusive modes per run.\n' +
    'THE 2.5 DIFFERENCE: 4-30 s per generation. A whole 2-3-shot scene, or one continuous 30 s take, fits in ONE run — prefer that over stitching three 8 s clips when the beats share a scene. The consistency ceiling has not moved (~3 cuts per generation): a 30 s run is one oner (\'one continuous shot, no cuts\') or 2-3 numbered shots, never 6. Structure long prompts as numbered shots or "[cut]" beats — never exact timestamps (officially unstable) — and state the FINAL frame explicitly.\n' +
    'Reference budget: 30 images / 10 videos / 10 audios, 30 s of reference video or audio combined — an API bound, not a recommendation: 4-5 labeled references remain the quality sweet spot.\n' +
    'Between shots, CUT — do not chain. Wiring the previous node\'s lastFrame into this one makes the seam glitch (a generated closing frame is motion-blurred and compressed): change the camera setup instead and keep the SAME character sheet / storyboard wired as @ references on every shot. When continuity is truly required, use video extend (previous clip as @Video1 + "[cut]"-separated next beats) — with the 30 s output ceiling it can also replace two chained runs outright.\n' +
    'Two clips only read as one sequence if each prompt says which frame it OPENS ON and which it CLOSES ON, and keeps the screen direction across the cut; the 4-panel shot board (designs recipe "shotboard") settles the hand-off on a cheap image.\n' +
    'Resolution caps at 1080p — for a native-4k master, run the keeper on Seedance 2 (model swap keeps the params). Platform compliance on realistic human faces in references follows kie.ai rules (the 2.0 tiers reject them) — prefer stylized sheets.',
  promptGuide: SEEDANCE25_PROMPT_GUIDE,
  // Indicative per-second rates by resolution — align with https://kie.ai/pricing.
  // A video-input run is billed differently (price × (input + output) seconds,
  // at a lower unit price: 17 / 38 / 68.5 cr/s); `estimateCredits` only sees
  // params, never the wired handles, so the no-video rate is what we quote —
  // the higher per-output-second of the two, i.e. the estimate never under-sells.
  estimateCredits: (params) =>
    ({ '480p': 28, '720p': 63, '1080p': 114 })[params.resolution] * params.duration,
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
      // Pinned: the render pipeline (lossless concat, ffprobe homogeneity)
      // expects h264 mp4 — never let a kie-side default drift send mov.
      // return_last_frame stays unsent: main extracts the last frame itself
      // (ffmpeg, extractLastFrameFromResult) uniformly across all models.
      output_format: 'mp4',
      web_search: params.web_search,
      nsfw_checker: params.nsfw_checker
    }
  }
}
