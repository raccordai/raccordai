import { z } from 'zod'
import type { ModelDefinition } from './types'

/**
 * ByteDance OmniHuman 1.5 (kie.ai jobs API) — audio-driven portrait animation.
 * API reference: https://docs.kie.ai/market/omnihuman-1-5
 * A still portrait + a speech/song track → a video of the subject performing
 * it, lip-synced. Output duration follows the audio (≤60 s, ≤15 s recommended).
 */

const RESOLUTION = ['720', '1080'] as const
/** API sentinel for "random seed each run". */
const RANDOM_SEED = -1
const MAX_SEED = 2147483647

const paramsSchema = z.object({
  prompt: z.string().max(1000).default(''),
  output_resolution: z.enum(RESOLUTION).default('1080'),
  pe_fast_mode: z.boolean().default(false),
  seed: z.number().int().min(RANDOM_SEED).max(MAX_SEED).default(RANDOM_SEED)
})

type Params = z.infer<typeof paramsSchema>

export const omnihuman15: ModelDefinition<Params> = {
  id: 'omnihuman-1-5',
  label: 'OmniHuman 1.5',
  description:
    'Audio-driven portrait animation (ByteDance): a still image + a voice/music track become a video of the subject performing it, lip-synced. People, pets, anime.',
  kind: 'video',
  recommendedFor: ['lip-sync', 'talking-head', 'portrait-animation'],
  paramsSchema,
  // No estimateCredits: the run is billed on the AUDIO's length, which is not a
  // param (estimateCredits sees params only) — no per-run figure would be
  // honest. Rates: https://kie.ai/pricing.
  paramFields: [
    {
      key: 'prompt',
      label: 'Direction (optional)',
      type: 'textarea',
      defaultValue: '',
      description:
        'Optional performance direction (emotion, gesture, camera) — the audio drives the animation. ≤300 chars recommended, 1000 max. zh/en/ja/ko/es/id.'
    },
    {
      key: 'output_resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '1080',
      options: [
        { value: '720', label: '720p' },
        { value: '1080', label: '1080p' }
      ]
    },
    {
      key: 'pe_fast_mode',
      label: 'Fast mode',
      type: 'boolean',
      defaultValue: false,
      description: 'Faster generation at some quality cost.'
    },
    {
      key: 'seed',
      label: 'Seed',
      type: 'number',
      min: RANDOM_SEED,
      max: MAX_SEED,
      defaultValue: RANDOM_SEED,
      description: '-1 = random. A positive seed reproduces the same result with identical inputs.'
    }
  ],
  inputs: [
    {
      key: 'image_url',
      label: 'Portrait',
      accepts: ['image'],
      required: true,
      maxCount: 1,
      frameAnchor: true,
      description:
        'The still that gets animated — it IS the on-screen subject (JPEG/PNG/WebP, ≤10MB, any aspect ratio; people, pets, anime). Wire a clean portrait or hero still, NEVER a design sheet or board.'
    },
    {
      key: 'audio_url',
      label: 'Voice audio',
      accepts: ['audio'],
      required: true,
      maxCount: 1,
      description:
        'The speech or song that drives the performance (mp3/wav/aac/ogg/m4a, ≤10MB, max 60 s — 15 s or less recommended). Wire an ElevenLabs speech node or a Suno track. The output duration follows this audio.'
    },
    {
      key: 'mask_url',
      label: 'Subject masks',
      accepts: ['image'],
      multiple: true,
      maxCount: 5,
      description:
        'Optional: up to 5 mask images marking WHICH subject(s) to animate in a multi-person image (JPEG/PNG/WebP, ≤10MB each).'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'OmniHuman 1.5 animates a STILL portrait to perform an audio track, lip-synced — the audio drives everything; the optional prompt only directs the performance (emotion, gesture, camera), ≤300 chars recommended.\n' +
    '`image_url` is a FRAME ANCHOR: the connected image IS the on-screen subject. Wire a clean portrait or hero still — never a character sheet or storyboard (it would appear on screen). In a multi-person image, `mask_url` marks who performs.\n' +
    'Audio ≤60 s, but ≤15 s reads best; the OUTPUT duration follows the audio (no duration param — the timeline reads the rendered media). Typical pipeline: character sheet → a clean portrait still → ElevenLabs speech → this node.\n' +
    'Complementary tools: to re-sync the mouth of an EXISTING clip, use volcengine/video-to-video-lip-sync; OmniHuman is for making a still speak.\n' +
    'Between shots, CUT — never chain this node into another clip via `lastFrame` (a generated closing frame is degraded and the seam glitches). Re-anchor every talking shot on the SAME clean portrait instead.',
  buildPayload: ({ params, inputs }) => {
    const payload: Record<string, unknown> = {
      output_resolution: params.output_resolution,
      pe_fast_mode: params.pe_fast_mode
    }
    const image = inputs.image_url?.[0]
    const audio = inputs.audio_url?.[0]
    if (image) payload.image_url = image
    if (audio) payload.audio_url = audio
    if (inputs.mask_url?.length) payload.mask_url = inputs.mask_url
    if (params.prompt.trim() !== '') payload.prompt = params.prompt
    if (params.seed !== RANDOM_SEED) payload.seed = params.seed
    return payload
  }
}
