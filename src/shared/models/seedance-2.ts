import { z } from 'zod'
import type { ModelDefinition } from './types'
import { SEEDANCE2_PROMPT_GUIDE } from './seedance2-prompting'

const ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const
const RESOLUTION = ['480p', '720p', '1080p', '4k'] as const

const paramsSchema = z.object({
  prompt: z.string().max(20000).default(''),
  generate_audio: z.boolean().default(true),
  resolution: z.enum(RESOLUTION).default('720p'),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  duration: z.number().int().min(4).max(15).default(5),
  web_search: z.boolean().default(false),
  nsfw_checker: z.boolean().default(true)
})

type Params = z.infer<typeof paramsSchema>

export const seedance2: ModelDefinition<Params> = {
  id: 'bytedance/seedance-2',
  label: 'Seedance 2',
  description:
    'The full Seedance 2.0 tier — same @ reference system as Fast/Mini, plus 1080p and 4k output. For live-action realism and final masters; for animation, Fast matches its quality at a fraction of the cost.',
  kind: 'video',
  recommendedFor: ['photorealism', 'high-resolution', 'final-masters', 'character-consistency'],
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
      defaultValue: 5
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
      description: '1080p/4k are exclusive to this tier — and priced accordingly.'
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
        "This image IS the opening frame (literal anchor — scene stills or the previous clip's lastFrame, never design sheets). Frame anchoring and @ references are mutually exclusive per run."
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
        'Each connection is numbered @Image1, @Image2, … (max 9). References GUIDE the output (identity, style) and do NOT appear on screen — unless the prompt assigns a frame role: "@Image1 as the first frame".'
    },
    {
      key: 'reference_video_urls',
      label: 'Reference videos',
      accepts: ['video'],
      multiple: true,
      maxCount: 3,
      referenceAlias: '@Video',
      description:
        'Each connection is numbered @Video1, @Video2, @Video3. Combined length ≤ 15s. Also the channel for video extend, character swap and custom voice-over tracks.'
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
    'Same @ reference system as Seedance 2 Fast/Mini — references GUIDE without appearing on screen; assign every connected source an explicit role.\n' +
    'This is the only tier with 1080p/4k: reserve it for live-action realism and final masters. For ANIMATION, Seedance 2 Fast produces indistinguishable results (300-test verdict) at 720p — iterate there and switch the node here only if native 1080p+ is required.\n' +
    'First/Last frame handles are literal anchors (mutually exclusive with @ references per run). Both anchors + "Show me what happens in between. USE MULTIPLE CAMERA ANGLES." fills the story between two stills.\n' +
    'Video extend (previous clip as @Video1 + "[cut]"-separated next beats) preserves set, identity AND voice across clips — stronger than lastFrame chaining when characters speak.\n' +
    'For 10s+ outputs, use numbered shots or "[cut]" beats — never exact timestamps (officially unstable).\n' +
    'Total uploads cap: ≤ 12 files combined. Restriction: no realistic human faces in references (platform compliance).',
  promptGuide: SEEDANCE2_PROMPT_GUIDE,
  // kie.ai has not published per-second rates for this model yet — add
  // estimateCredits once https://kie.ai/pricing lists Seedance 2.0.
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
