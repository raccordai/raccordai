import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['16:9', '9:16', '1:1'] as const
// Resolution per mode: std 720p, pro 1080p, 4K 2160p (kie docs mapping).
const MODE = ['std', 'pro', '4K'] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(5000).default(''),
  sound: z.boolean().default(false),
  duration: z.number().int().min(3).max(15).default(5),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  mode: z.enum(MODE).default('pro')
})

type Params = z.infer<typeof paramsSchema>

export const kling3: ModelDefinition<Params> = {
  id: 'kling-3.0/video',
  label: 'Kling 3.0',
  description:
    'Kuaishou Kling 3.0 video generation — text-to-video or first/last frame anchoring, up to 4K.',
  kind: 'video',
  recommendedFor: ['first-frame-animation', 'high-resolution', 'photorealism'],
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description: 'Scene + motion + camera. Required.'
    },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 3,
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
      description: 'Ignored when a First frame is connected (the video follows the image).'
    },
    {
      key: 'mode',
      label: 'Quality mode',
      type: 'select',
      defaultValue: 'pro',
      options: MODE.map((v) => ({ value: v, label: v })),
      description: 'std=720p, pro=1080p, 4K=2160p. Higher modes cost more credits and time.'
    },
    {
      key: 'sound',
      label: 'Generate sound',
      type: 'boolean',
      defaultValue: false
    }
  ],
  inputs: [
    {
      key: 'first_frame',
      label: 'First frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        "This image IS the opening frame (literal anchor — scene stills or the previous clip's lastFrame, never design sheets)."
    },
    {
      key: 'last_frame',
      label: 'Last frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description: 'This image IS the closing frame. Requires a First frame connection.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Kling 3.0 runs text-to-video, or anchors the clip on a literal First frame (optionally plus a Last frame — JPG/PNG, 10MB max). Connected images APPEAR on screen: never wire a character sheet or storyboard here.\n' +
    'Duration is 3-15 seconds (default 5); `mode` picks the resolution tier (std=720p, pro=1080p, 4K=2160p); `sound` adds generated audio.\n' +
    'With a First frame connected, aspect_ratio is ignored (the video follows the image).\n' +
    'Kling elements (@name references) and multi-shot mode exist API-side but are not wired in Raccord yet — use Seedance 2 for reference-driven consistency.\n' +
    "For continuity to the next clip: wire this node's `lastFrame` output into the next video node's frame input.",
  // Distilled from kie.ai's Kling 3.0 docs (docs.kie.ai/market/kling/kling-3-0).
  promptGuide: `CORE PRINCIPLE (kie.ai/Kling guidance):
  Be specific and descriptive: subject, motion, camera angle and scene composition, in natural
  sentences. With a First frame connected, do not re-describe the image — describe what MOVES.

STRUCTURE:
  [subject + setting] → [action, one or two max] → [camera] → [light/atmosphere].

CAMERA:
  Kling responds well to explicit camera work: slow push-in, tracking shot, orbit, crane up,
  handheld, static frame. Name one camera move per clip.

FRAMES:
  - First frame alone: the clip opens exactly on that image and animates from it.
  - First + Last frame: Kling generates the in-between — describe the transformation
    ("the storm clouds roll in and swallow the skyline").
  - A Last frame without a First frame is not supported.

PARAMS:
  duration 3-15s (default 5). mode: std=720p, pro=1080p (default), 4K=2160p — 4K is slower and
  costs more. sound=true generates audio; mention the desired ambience in the prompt.

PITFALLS:
  - Keep prompts under ~500 characters for the best adherence.
  - Elements (@name) and multi-shot are not wired in Raccord yet — single shot per node.

FULL EXAMPLE:
  "A red fox trots across a snow-covered meadow at dawn, leaving a trail of pawprints, low golden
  light, slow tracking shot at ground level, gentle wind and distant birdsong."`,
  // No estimateCredits: kie.ai publishes no rate for Kling 3.0 yet — fill in
  // from the dashboard (https://kie.ai/pricing); never guess.
  buildPayload: ({ params, inputs }) => {
    const first = inputs.first_frame?.[0]
    const last = inputs.last_frame?.[0]
    if (last && !first) {
      throw new Error(
        'Kling 3.0: a Last frame requires a First frame connection (the API reads image_urls[0] as the first frame).'
      )
    }
    const image_urls = first ? [first, ...(last ? [last] : [])] : []
    return {
      prompt: params.prompt,
      sound: params.sound,
      // The API takes duration as a string ("5"); stored as a number for the timeline.
      duration: String(params.duration),
      mode: params.mode,
      multi_shots: false,
      ...(image_urls.length > 0 ? { image_urls } : { aspect_ratio: params.aspect_ratio })
    }
  }
}
