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
  '2:3',
  '4:1',
  '1:4',
  '8:1',
  '1:8'
] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(20000),
  aspect_ratio: z.enum(ASPECT).default('auto')
})

type Params = z.infer<typeof paramsSchema>

export const nanoBanana2Lite: ModelDefinition<Params> = {
  id: 'nano-banana-2-lite',
  label: 'Nano Banana 2 Lite',
  description:
    'Fastest and cheapest Nano Banana — ~4 s generations at 1K, up to 10 input images. Ideal for drafts and quick iterations.',
  kind: 'image',
  recommendedFor: ['cheap-draft', 'fast-iteration'],
  paramsSchema,
  // Indicative flat per-image rate (1K only) — align with https://kie.ai/pricing (4 credits).
  estimateCredits: () => 4,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description: 'Max 20 000 characters.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description:
        'auto lets the model pick (follows the input image when editing). 4:1/8:1 for banners.'
    }
  ],
  inputs: [
    {
      key: 'image_urls',
      label: 'Input image(s)',
      accepts: ['image'],
      multiple: true,
      maxCount: 10,
      description:
        'Up to 10 images (JPEG/PNG/WebP, ≤30 MB each) to edit, restyle or blend. Optional — pure text-to-image without any.'
    }
  ],
  outputs: [{ key: 'output', label: 'Output image', kind: 'image' }],
  promptingNotes:
    'Describe scenes in full sentences (narrative beats keyword lists). Output is 1K only, no resolution/format params — draft here (fast, 4 credits), then re-run the keeper on Nano Banana 2 or Pro for 2K/4K. Up to 10 input images; reference each by its role and connection order.',
  // Distilled from Google's official Gemini image prompting guide
  // (https://ai.google.dev/gemini-api/docs/image-generation).
  promptGuide: `CORE PRINCIPLE (official): describe the scene, don't stack keywords. The model's deep language
understanding means a narrative paragraph outperforms a comma-separated tag list.

ANATOMY:
  subject → action/pose → setting → composition (shot type, angle, lens) → lighting → style/medium.

OFFICIAL TEMPLATES:
  - Photorealistic: "A photorealistic [shot type] of [subject] in [setting]. [Lighting description].
    Shot from [angle] with [lens]." Camera vocabulary is parsed: wide-angle, macro, low-angle
    perspective, 85mm portrait lens, shallow depth of field.
  - Illustration/sticker: "A [style] of [subject with details]. Features [visual qualities like bold
    outlines, cel-shading] and [color/background]."
  - Product mockup: "A studio-lit product photograph of [product] on [surface]. Lighting is [setup]
    to [purpose]."
  - Sequential art: "Make a [n]-panel comic in a [style]. Put the character in [scene type]."

EDITING (images connected):
  - Describe the change; the model matches the original's style, lighting and perspective.
  - Inpainting formula: "Change only the [element] to [new element]. Keep everything else exactly
    the same, preserving the original style, lighting, and composition."
  - Style transfer: "Transform into the artistic style of [style]. Preserve the original composition."
  - Multi-image composition (up to 10): name each image by role and connection order:
    "Take the [element from image 1] and place it on the [element from image 2]."

PITFALLS:
  - Output caps at 1K — dense typography and fine 4K detail belong on Nano Banana Pro.
  - Semantic negative prompts: state the desired state positively ("an empty, deserted street")
    instead of "no cars" — bare negations drift.
  - One change per iteration; refine conversationally rather than rewriting the whole prompt.
  - When the image belongs to a styled workflow, append the video's style bible verbatim.

FULL EXAMPLE (official pattern):
  "A photorealistic close-up portrait of an elderly Japanese ceramicist in his sun-drenched workshop,
  inspecting a freshly glazed tea bowl. Soft golden hour light through a side window highlights the
  clay texture. Shot from eye level with an 85mm portrait lens, shallow depth of field."`,
  buildPayload: ({ params, inputs }) => ({
    prompt: params.prompt,
    image_urls: inputs.image_urls ?? [],
    aspect_ratio: params.aspect_ratio
  })
}
