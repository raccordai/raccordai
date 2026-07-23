import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = [
  'auto',
  '1:1',
  '5:4',
  '9:16',
  '21:9',
  '16:9',
  '4:3',
  '3:2',
  '4:5',
  '3:4',
  '2:3'
] as const
const RESOLUTION = ['1K', '2K', '4K'] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(20000),
  aspect_ratio: z.enum(ASPECT).default('auto'),
  resolution: z.enum(RESOLUTION).default('1K')
})

type Params = z.infer<typeof paramsSchema>

export const gptImage2I2I: ModelDefinition<Params> = {
  id: 'gpt-image-2-image-to-image',
  label: 'GPT Image 2 — Image to Image',
  description: 'Edit or transform an input image with a text prompt.',
  kind: 'image',
  recommendedFor: ['image-editing', 'storyboards'],
  paramsSchema,
  // Indicative per-image rates by resolution — align with https://kie.ai/pricing.
  estimateCredits: (params) => ({ '1K': 10, '2K': 15, '4K': 30 })[params.resolution],
  paramFields: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '1K',
      options: RESOLUTION.map((v) => ({ value: v, label: v })),
      description: '4K not available with 1:1; auto resolves to 1K only.'
    }
  ],
  inputs: [
    {
      key: 'input_urls',
      label: 'Reference image(s)',
      accepts: ['image'],
      multiple: true,
      maxCount: 4,
      description: 'Source images to edit or transform.'
    }
  ],
  outputs: [{ key: 'output', label: 'Output image', kind: 'image' }],
  promptingNotes:
    'No @-aliasing here — describe the desired edit naturally. With aspect_ratio=auto, only 1K resolution is available; 4K is not available for 1:1.',
  // Distilled from OpenAI's official GPT Image prompting guides (developers.openai.com cookbook).
  promptGuide: `EDITS (the golden formula):
  "Change only X. Keep everything else the same."
Repeat the preserve list on EVERY iteration to prevent drift, and state invariants explicitly:
"preserve identity/geometry/layout", "no watermark", "no extra text".

IDENTITY PRESERVATION (official wording):
  "Preserve face, body shape, pose, hair, expression, and likeness exactly. Replace only clothing."
GPT Image 2 processes every input at high fidelity automatically — no fidelity parameter needed.

MULTIPLE INPUT IMAGES (up to 4 connected):
  Reference each by index and role, then state the interaction:
  "Image 1: product photo. Image 2: style reference. Apply Image 2's style to Image 1."
  "Put the bird from Image 1 on the elephant in Image 2."
  Indexing follows the connection order shown in the UI.

COMPOSITING REALISM:
  Explicitly ask to match the target scene's lighting, perspective, scale and shadows so the
  inserted element integrates photorealistically.

STYLE TRANSFORMS:
  Name the target medium precisely ("repaint as a 2D anime key visual, clean lineart, cel shading")
  and list what must survive the transform (composition, pose, palette).
  When the image belongs to a styled workflow, append the video's style bible verbatim.

PITFALLS:
  - Phrase edits positively; bare negations drift.
  - One change per iteration — overloaded edit prompts are hard to debug.
  - Without an explicit preserve list the model may creatively reinterpret untouched areas.

PARAMS INTERPLAY (kie.ai):
  aspect_ratio=auto locks resolution to 1K; 4K unavailable at 1:1.

FULL EXAMPLE (official pattern):
  "Edit the image to dress the woman using the provided clothing images. Preserve her exact likeness,
  pose and background. Replace only the clothing, fitting the garments naturally. Match the scene's
  lighting so the outfit integrates photorealistically."`,
  buildPayload: ({ params, inputs }) => ({
    prompt: params.prompt,
    input_urls: inputs.input_urls ?? [],
    aspect_ratio: params.aspect_ratio,
    resolution: params.resolution
  })
}
