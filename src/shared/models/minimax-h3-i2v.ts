import { z } from 'zod'
import type { ModelDefinition } from './types'

/**
 * MiniMax H3 (Hailuo 03) image-to-video — kie.ai jobs API.
 * API reference: https://kie.ai/minimax-h3?model=minimax-h3%2Fimage-to-video
 * One frame anchor (or a first/last pair) + a prompt → a 4-15 s clip at 768P
 * or 2K with native stereo audio. This endpoint has NO reference inputs: every
 * connected image appears on screen.
 */

const RESOLUTION = ['768P', '2K'] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(7000).default(''),
  // Stored as a number of whole seconds (the timeline reads params.duration);
  // the API accepts every integer from 4 to 15.
  duration: z.number().int().min(4).max(15).default(6),
  resolution: z.enum(RESOLUTION).default('2K')
})

type Params = z.infer<typeof paramsSchema>

export const minimaxH3I2V: ModelDefinition<Params> = {
  id: 'minimax-h3/image-to-video',
  label: 'MiniMax H3 — Image to Video',
  description:
    'Animate a still image (or a first/last frame pair) with strong instruction following, readable on-screen text and native stereo audio (MiniMax Hailuo 03). 4-15 s clips at 768P or 2K.',
  kind: 'video',
  recommendedFor: ['first-frame-animation', 'high-resolution', 'native-audio'],
  // Same model floored to 768P (cheaper per second) — iterate cheap, then
  // re-run the keeper at 2K. A node already at 768P resolves to null and is
  // never stamped draft.
  draftEquivalent: { modelId: 'minimax-h3/image-to-video', params: { resolution: '768P' } },
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description:
        'Describe the MOTION, camera and sound — the anchored image already provides the scene. 1 to 7000 characters.'
    },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 4,
      max: 15,
      step: 1,
      defaultValue: 6,
      description:
        'Whole seconds, any integer from 4 to 15. The API rejects anything shorter than 4 s — merge a shorter beat with its neighbour, never round down.'
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '2K',
      options: RESOLUTION.map((v) => ({ value: v, label: v })),
      description: '768P is the cheaper tier — draft at 768P, master at 2K.'
    }
  ],
  inputs: [
    {
      key: 'first_frame_url',
      label: 'First frame',
      accepts: ['image'],
      required: true,
      maxCount: 1,
      frameAnchor: true,
      description:
        "This image IS the opening frame (literal anchor — a clean scene still or hero shot; never design sheets, and never the previous clip's lastFrame: a generated closing frame is degraded and makes the cut glitch). JPG/PNG/WebP/HEIC, ≤30 MB, sides 256-5760 px, aspect ratio 0.4-2.5."
    },
    {
      key: 'last_frame_url',
      label: 'Last frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        'Optional: this image IS the closing frame — with both anchors set, the model generates the motion between the two stills (controlled transitions, reveals, key-art animation). Same image restrictions as the first frame.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Both image handles are FRAME ANCHORS: the connected images literally appear on screen (like Seedance 1.5 — NOT invisible references like Seedance 2). Never wire a character sheet, storyboard or board here.\n' +
    'One image = the opening visual state; first + last = the model generates the in-between (controlled transitions, reveals). This endpoint has no reference inputs: character consistency across shots = re-anchoring every shot on the SAME clean source still.\n' +
    'The model follows detailed directions reliably — shot timing, camera movement, character behavior, sound design, explicit restrictions ("keep the logo unchanged") — and renders readable text, titles and signage.\n' +
    'Audio is native stereo: describe dialogue, music and SFX in the prompt, there is no separate audio switch.\n' +
    'Duration is any integer from 4 to 15 s (default 6); prompt 1-7000 characters; 768P (8 cr/s) for drafts, 2K (13 cr/s) for masters.\n' +
    "Between shots, CUT — do not chain. Wiring this node's `lastFrame` into the next clip's anchor makes the seam glitch (a generated closing frame is motion-blurred and compressed): cut to a new camera setup and re-anchor on the same clean still instead.",
  // Distilled from kie.ai's MiniMax H3 model page (Hailuo 03 image-to-video
  // guide: single image vs first/last pair, instruction following, text
  // rendering, native stereo audio).
  promptGuide: `CORE PRINCIPLE:
  The anchored image already provides the scene — the prompt directs what CHANGES: action,
  camera movement, atmosphere, sound. Do not re-describe or contradict the source image.

INPUT MODES:
  - SINGLE IMAGE (first frame): the image is the starting visual state — natural character
    motion, environmental movement and camera animation grow out of it. Best for animated
    posters, product showcases, UI demonstrations, character performances, key-art animation.
  - FIRST + LAST FRAME: both stills appear literally; the model generates how the sequence
    begins, transitions and concludes — use it for controlled transitions and reveals.
  Both handles are anchors: wire clean stills only, never design sheets or boards. There are
  no reference inputs on this endpoint — consistency across shots = the SAME clean source
  still re-anchored on every shot.

INSTRUCTION FOLLOWING (the model's strength — use it):
  - Direct shot structure explicitly: order, timing, transitions, camera moves (push-in,
    orbit, tracking, handheld), character behavior.
  - State what must remain UNCHANGED ("the logo stays exactly as in the image") — the model
    honors explicit restrictions, not only positive instructions.
  - On-screen text, titles, interface components and signage render legibly — spell out the
    exact wording in quotes when text must appear.

AUDIO (native stereo, same pass):
  Describe the sound design in the prompt: dialogue in quotes, music style, SFX, ambience.
  There is no audio parameter — the prompt is the mix.

PARAMS:
  Duration: any integer 4-15 s (default 6). Resolution: 768P for cheap drafts, 2K for the
  final master.

PITFALLS:
  - A prompt fighting the image (new outfit, different setting) warps the opening frames.
  - One or two actions per clip — overloaded prompts degrade motion quality.
  - Never chain a generated lastFrame into the next clip's anchor; cut and re-anchor on the
    clean source still.

FULL EXAMPLE:
  "The chef looks up from the cutting board and smiles, steam rising from the pan behind her.
  Slow push-in from waist-level to a chest-up framing. Keep the restaurant logo on her apron
  exactly as in the image. Warm kitchen ambience, sizzling oil, soft jazz in the background."`,
  buildPayload: ({ params, inputs }) => {
    const first = inputs.first_frame_url?.[0]
    const last = inputs.last_frame_url?.[0]
    return {
      prompt: params.prompt,
      // The API requires at least one anchor; optional fields are omitted
      // rather than sent empty (presence is intent).
      ...(first ? { first_frame_url: first } : {}),
      ...(last ? { last_frame_url: last } : {}),
      duration: params.duration,
      resolution: params.resolution
    }
  }
}
