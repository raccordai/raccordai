import { z } from 'zod'
import type { ModelDefinition } from './types'

const MODEL_VERSIONS = ['V4', 'V4_5', 'V4_5PLUS', 'V5'] as const
const VOCAL_GENDER = ['', 'm', 'f'] as const

const paramsSchema = z
  .object({
    prompt: z.string().max(5000).default(''),
    customMode: z.boolean().default(false),
    instrumental: z.boolean().default(false),
    model: z.enum(MODEL_VERSIONS).default('V4_5'),
    style: z.string().max(1000).default(''),
    title: z.string().max(80).default(''),
    negativeTags: z.string().max(200).default(''),
    vocalGender: z.enum(VOCAL_GENDER).default('')
  })
  .superRefine((p, ctx) => {
    // kie.ai's Suno API makes style+title required in custom mode, and the prompt
    // (used as exact lyrics) required when custom mode is vocal.
    if (p.customMode) {
      if (!p.style.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['style'],
          message: 'style is required in custom mode'
        })
      if (!p.title.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['title'],
          message: 'title is required in custom mode'
        })
      if (!p.instrumental && !p.prompt.trim())
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['prompt'],
          message: 'prompt (lyrics) is required in custom vocal mode'
        })
    } else if (!p.prompt.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'prompt is required' })
    }
  })

type Params = z.infer<typeof paramsSchema>

export const sunoMusic: ModelDefinition<Params> = {
  id: 'suno/generate-music',
  label: 'Suno — Generate Music',
  description:
    'Generate a music track (with or without vocals) from a text prompt or custom lyrics.',
  kind: 'audio',
  provider: 'suno',
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Prompt / Lyrics',
      type: 'textarea',
      defaultValue: '',
      description:
        'Non-custom mode: a free-form description of the song (≤500 chars). Custom mode: the exact lyrics to sing.'
    },
    {
      key: 'customMode',
      label: 'Custom mode',
      type: 'boolean',
      defaultValue: false,
      description:
        'On: control style/title and treat the prompt as exact lyrics. Off: just describe the song.'
    },
    {
      key: 'instrumental',
      label: 'Instrumental (no vocals)',
      type: 'boolean',
      defaultValue: false
    },
    {
      key: 'model',
      label: 'Suno version',
      type: 'select',
      defaultValue: 'V4_5',
      options: MODEL_VERSIONS.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'style',
      label: 'Style (custom mode)',
      type: 'text',
      defaultValue: '',
      description: 'e.g. "lo-fi hip hop, mellow, rainy night". Required in custom mode.'
    },
    {
      key: 'title',
      label: 'Title (custom mode)',
      type: 'text',
      defaultValue: '',
      description: 'Track title (≤80 chars). Required in custom mode.'
    },
    {
      key: 'negativeTags',
      label: 'Negative tags',
      type: 'text',
      defaultValue: '',
      description: 'Styles to steer away from (custom mode).'
    },
    {
      key: 'vocalGender',
      label: 'Vocal gender',
      type: 'select',
      defaultValue: '',
      options: [
        { value: '', label: 'Any' },
        { value: 'm', label: 'Male' },
        { value: 'f', label: 'Female' }
      ],
      description: 'Nudges the vocal gender (custom mode) — not guaranteed.'
    }
  ],
  // Pure generator: no media inputs. Its audio output can feed e.g. Seedance's `reference_audio_urls`.
  inputs: [],
  outputs: [{ key: 'output', label: 'Music', kind: 'audio' }],
  promptingNotes:
    'Two modes:\n' +
    '- Non-custom (default): write a short natural-language description ("upbeat synthwave with driving bass, ~120 BPM"). Keep it ≤500 chars; leave style/title empty.\n' +
    '- Custom: the prompt becomes the exact lyrics; you must also set `style` and `title`. Use `instrumental: true` for no vocals (then prompt/lyrics are ignored).\n' +
    "Suno returns multiple variations per request; the first track is used as this node's output.\n" +
    'Tip: wire this node\'s `output` into a Seedance node\'s `reference_audio_urls` to score a clip ("BGM references @Audio1").',
  // Distilled from Suno's official help center (help.suno.com), kie.ai's Suno API docs and the
  // community Suno AI wiki (metatag list) — see docs.kie.ai/suno-api/generate-music.
  promptGuide: `TWO REGIMES:
  1. Description mode (customMode=false): ONE sentence-style brief ≤500 chars. Pack in: genre (1-2 max),
     mood, tempo/BPM, key instruments, era, vocal type ("female vocals"). V4.5+/V5 also honor structure
     instructions ("begin with soft ambient layers, build gradually with flowing synths").
  2. Custom mode (customMode=true): \`prompt\` = the EXACT lyrics; \`style\` + \`title\` required.
     instrumental=true → lyrics ignored, style+title only.

STYLE FIELD (custom mode):
  - V4: short comma-separated tags, ≤200 chars ("Folk, Acoustic, Nostalgic").
  - V4.5/V4.5+/V5: up to 1000 chars, conversational multi-clause descriptions work
    ("synthwave, dreamy, 80s, female vocals, warm analog synths, steady 100 BPM groove, spacious reverb").
  - Comma-separate genre / voice / instrumentation so the model differentiates them.

LYRICS METATAGS (custom mode — short bracketed tags right before the section they govern):
  Structure: [Intro] [Verse] [Chorus] [Bridge] [Outro]
  Instruments/dynamics: [Piano] [Guitar solo] [Catchy Hook] [Crescendo] [Whispering vocals]
  Vocals: [Female Vocal] [Male narrator]
  Endings (prevents rambling): finish the lyrics with [Outro] then [Fade Out] and [End].
  (parentheses) are SUNG as backing vocals/ad-libs ("(oh yeah)") — use deliberately.
  Keep tags 1-3 words; over-tagging (10+) degrades output. Interpretation is stochastic — retry if needed.

VOCALS:
  Stack the levers, most→least reliable: vocalGender param (custom mode, probabilistic) → vocal
  descriptors in style ("deep gritty male vocals") → inline tags in lyrics ([feminine high airy vocal]).

LENGTH:
  No duration parameter. Steer with lyric quantity (more verses = longer), an explicit target in the
  description ("a 30-second hook", "punchy 20s jingle"), and closing tags [Fade Out][End].
  Max: 4 min on V4, 8 min on V4.5+/V5.

NEGATIVE TAGS:
  Comma-separated exclusions, keep minimal (2-4): "heavy metal, distorted guitar, aggressive drums".

PITFALLS:
  - Artist/celebrity names are BLOCKED — describe the sound instead ("90s Seattle grunge, raspy male
    vocals", not "like Nirvana").
  - Genre info belongs in style, not in the lyrics box (style paragraphs in lyrics get sung).
  - Long bracketed text gets sung verbatim — keep tags short.
  - A 1000-char style sent to V4 fails — mind the per-version limits.

FULL EXAMPLE (custom mode):
  style: "synthwave, dreamy, 80s, female vocals, warm analog synths, steady 100 BPM groove"
  title: "Neon Rain" · negativeTags: "heavy metal, aggressive drums" · vocalGender: "f"
  prompt: "[Intro]\\n[Synth]\\n\\n[Verse]\\nCity lights are bleeding through the window pane\\n...\\n
  [Chorus]\\nNeon rain, falling down on me (falling down)\\n...\\n[Outro]\\n[Fade Out]\\n[End]"`,
  // Indicative per-song rate — align with https://kie.ai/pricing.
  estimateCredits: () => 8,
  buildPayload: ({ params }) => {
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      customMode: params.customMode,
      instrumental: params.instrumental,
      model: params.model
    }
    // In non-custom mode kie.ai expects the extra fields left empty.
    if (params.customMode) {
      if (params.style) body.style = params.style
      if (params.title) body.title = params.title
      if (params.negativeTags) body.negativeTags = params.negativeTags
      if (params.vocalGender) body.vocalGender = params.vocalGender
    }
    return body
  }
}
