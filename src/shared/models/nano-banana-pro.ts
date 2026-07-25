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
const OUTPUT_FORMAT = ['png', 'jpg'] as const

const paramsSchema = z.object({
  prompt: z.string().min(1).max(10000),
  aspect_ratio: z.enum(ASPECT).default('auto'),
  resolution: z.enum(RESOLUTION).default('1K'),
  output_format: z.enum(OUTPUT_FORMAT).default('png')
})

type Params = z.infer<typeof paramsSchema>

export const nanoBananaPro: ModelDefinition<Params> = {
  id: 'nano-banana-pro',
  label: 'Nano Banana Pro',
  description:
    'Google Gemini 3 Pro image — best-in-class text rendering, blends up to 8 input images, 1K/2K/4K output.',
  kind: 'image',
  recommendedFor: ['text-rendering', 'high-resolution', 'multi-image-blend'],
  // Lite is 1K-only (resolution/output_format are dropped by its schema) and
  // names its input handle image_urls.
  draftEquivalent: { modelId: 'nano-banana-2-lite', inputs: { image_input: 'image_urls' } },
  paramsSchema,
  // Indicative per-image rates by resolution — align with https://kie.ai/pricing
  // (18 credits for 1K/2K, 24 credits for 4K).
  estimateCredits: (params) => ({ '1K': 18, '2K': 18, '4K': 24 })[params.resolution],
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      defaultValue: '',
      description: 'Max 10 000 characters.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: 'auto',
      options: ASPECT.map((v) => ({ value: v, label: v })),
      description: 'auto lets the model pick (follows the input image when editing).'
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '1K',
      options: RESOLUTION.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'output_format',
      label: 'Format',
      type: 'select',
      defaultValue: 'png',
      options: OUTPUT_FORMAT.map((v) => ({ value: v, label: v }))
    }
  ],
  inputs: [
    {
      key: 'image_input',
      label: 'Input image(s)',
      accepts: ['image'],
      multiple: true,
      maxCount: 8,
      description:
        'Up to 8 images (JPEG/PNG/WebP, ≤30 MB each) to edit, restyle or blend. Optional — pure text-to-image without any.'
    }
  ],
  outputs: [{ key: 'output', label: 'Output image', kind: 'image' }],
  promptingNotes:
    'Describe scenes in full sentences (narrative beats keyword lists). Strongest text rendering of the family — put exact copy in quotes and describe the typography. Up to 8 input images can be edited or blended; reference each by its role and connection order. 4K costs more — iterate at 1K, upscale the keeper.',
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
  - Text in the image: give the literal text in quotes, describe the font style descriptively
    ("clean bold sans-serif"), and the overall design. This model excels at legible, multi-line text —
    posters, UI mocks, infographics.
  - Product mockup: "A studio-lit product photograph of [product] on [surface]. Lighting is [setup]
    to [purpose]." Ask for subtle contact shadows.
  - Sequential art: "Make a [n]-panel comic in a [style]. Put the character in [scene type]."

EDITING (images connected):
  - Describe the change; the model matches the original's style, lighting and perspective.
  - Inpainting formula: "Change only the [element] to [new element]. Keep everything else exactly
    the same, preserving the original style, lighting, and composition."
  - Style transfer: "Transform into the artistic style of [style]. Preserve the original composition."
  - Multi-image composition (up to 8): name each image by role and connection order:
    "Take the [element from image 1] and place it on the [element from image 2]."

PITFALLS:
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
    image_input: inputs.image_input ?? [],
    aspect_ratio: params.aspect_ratio,
    resolution: params.resolution,
    output_format: params.output_format
  })
}
