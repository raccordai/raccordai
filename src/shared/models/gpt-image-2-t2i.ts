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

export const gptImage2T2I: ModelDefinition<Params> = {
  id: 'gpt-image-2-text-to-image',
  label: 'GPT Image 2 — Text to Image',
  description: 'Generate an image from a text prompt — no source image required.',
  kind: 'image',
  recommendedFor: ['text-to-image', 'style-frames'],
  // No cheaper sibling — draft = same model floored to 1K (10 cr vs 30 at 4K).
  draftEquivalent: { modelId: 'gpt-image-2-text-to-image', params: { resolution: '1K' } },
  paramsSchema,
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
  inputs: [],
  outputs: [{ key: 'output', label: 'Output image', kind: 'image' }],
  // Indicative per-image rates by resolution — align with https://kie.ai/pricing.
  estimateCredits: (params) => ({ '1K': 10, '2K': 15, '4K': 30 })[params.resolution],
  buildPayload: ({ params }) => ({
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio,
    resolution: params.resolution
  }),
  promptingNotes:
    'Pure text-to-image — no reference inputs. Describe subject, style, lighting, composition. Set aspect_ratio explicitly (≠ auto) if you want 2K or 4K resolution.',
  // Distilled from OpenAI's official GPT Image prompting guides (developers.openai.com cookbook).
  promptGuide: `ANATOMY (official OpenAI order — use labeled segments/line breaks for complex requests):
  background/scene → subject → key details → constraints.
State the intended USE first ("hero image for an ad", "anime key visual", "UI mock") — it sets the
model's mode and polish level. Declare the visual medium explicitly: photo, watercolor, 3D render,
2D anime illustration, flat vector...

COMPOSITION & LOOK:
  - Framing/viewpoint: close-up, wide, top-down, three-quarter; perspective; lighting; mood.
  - Be concrete about materials, shapes, textures.
  - People & action: scale, body framing, gaze, object interactions — precisely.

TEXT INSIDE THE IMAGE:
  - Put the literal text in quotes or ALL CAPS; spell tricky words/brand names letter-by-letter.
  - Specify typography (font style, size, color, placement) and demand "verbatim, no extra characters".

SPECIFIC LOOKS:
  - Photorealism: "photorealistic, real photograph, professional photography" + camera language
    (lens, aperture, lighting direction, film grain, shallow depth of field) + real texture (pores,
    fabric wear, imperfections). Prompt a candid moment, avoid studio-polish wording.
  - Product/advertising: write the prompt like a creative brief (brand, audience, concept, composition,
    exact copy); ask for light polishing and subtle contact shadows only.
  - Flat design/logos: simplicity, vector-like shapes, strong silhouette, balanced negative space.
  - When the image belongs to a styled workflow, append the video's style bible verbatim.

PITFALLS:
  - Avoid relying on negations — prefer positive constraints over "no X" alone.
  - Missing constraints cause creative drift: state exclusions explicitly ("no watermark", "no extra text").
  - Debug long prompts with small single-change iterations.

PARAMS INTERPLAY (kie.ai):
  aspect_ratio=auto locks resolution to 1K; 4K unavailable at 1:1. Set the ratio explicitly for 2K/4K.

FULL EXAMPLE (official pattern):
  "Create a photorealistic candid photograph of an elderly sailor standing on a small fishing boat.
  Weathered skin with visible wrinkles, pores and sun texture, faded traditional tattoos on his arms.
  Shot like a 35mm film photograph, soft coastal daylight, shallow depth of field, subtle film grain."`
}
