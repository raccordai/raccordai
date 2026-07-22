import { getStyle } from '../styles/registry'

/**
 * Workflow templates — ready-to-import graph blueprints (workflow JSON v1,
 * the exact format accepted by import_workflow). Prompts contain [SLOTS]
 * meant to be filled by the user or the assistant before running; every
 * prompt already carries the matching style template's style bible so the
 * imported graph is coherent out of the box.
 */

export interface WorkflowTemplateNode {
  key: string
  modelId: string
  label?: string
  intent?: string
  position: { x: number; y: number }
  params: Record<string, unknown>
}

export interface WorkflowTemplateEdge {
  from: string
  to: string
  input: string
  output?: 'output' | 'lastFrame'
}

export interface WorkflowTemplate {
  id: string
  /** Agent-facing English name; UI display names live in i18n under `templates.<id>`. */
  label: string
  description: string
  /** The style template the blueprint's prompts are written with. */
  styleId: string
  /** Placeholder slots present in the prompts, e.g. "[PRODUCT]" — fill before running. */
  slots: string[]
  workflow: {
    version: 1
    nodes: WorkflowTemplateNode[]
    edges: WorkflowTemplateEdge[]
  }
}

// Non-null: every template's styleId is validated against the style registry by the tests.
const bible = (styleId: string): string => getStyle(styleId)!.styleBible

/** Grid helpers so every template lays out the same way (left-to-right flow). */
const col = (i: number): number => i * 420
const row = (i: number): number => i * 350

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'product-commercial',
    label: 'Product commercial (3 shots + music)',
    description:
      'A 24s product ad: hero product image, then three chained cinematic shots (reveal → detail → tagline), scored with an upbeat track.',
    styleId: 'commercial',
    slots: ['[PRODUCT]', '[SETTING]', '[TAGLINE]'],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'hero-image',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Hero product shot',
          intent: 'The ad-ready hero image of the product, reused as the first frame of shot 1.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Hero product photograph of [PRODUCT] on a seamless studio backdrop in [SETTING]. ' +
              'Centered composition with generous negative space, soft key light with crisp speculars, subtle reflection under the product. ' +
              bible('commercial'),
            aspect_ratio: '16:9',
            resolution: '1K'
          }
        },
        {
          key: 'shot-1',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 01 — Reveal',
          intent: 'Slow dolly-in reveal of the product from the hero image.',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              'Slow confident dolly-in on [PRODUCT] standing on a seamless studio backdrop, light sweeping across its surface, ' +
              'fine dust particles glinting in the beam. ' +
              bible('commercial'),
            aspect_ratio: '16:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-2',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 02 — Detail',
          intent: 'Macro orbital shot on the product details, continuous with shot 1.',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              'Macro orbital shot circling [PRODUCT], extreme close-up on its textures and materials, ' +
              'shallow depth of field, satisfying slow motion. ' +
              bible('commercial'),
            aspect_ratio: '16:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-3',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 03 — Tagline',
          intent:
            'Final wide shot pulling back from the product, leaving negative space for the tagline "[TAGLINE]".',
          position: { x: col(3), y: row(0) },
          params: {
            prompt:
              'Slow pull-back from [PRODUCT] to a wide symmetrical composition with clean negative space on the right third, ' +
              'lighting settling into an elegant final frame. ' +
              bible('commercial'),
            aspect_ratio: '16:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'music',
          modelId: 'suno/generate-music',
          label: 'Music — Upbeat ad track',
          intent: 'The 24s soundtrack of the ad.',
          position: { x: col(1), y: row(1) },
          params: {
            prompt: '',
            customMode: true,
            instrumental: true,
            model: 'V4_5',
            style:
              'upbeat commercial pop, claps and stomps, bright synth hooks, feel-good, 115 BPM',
            title: '[PRODUCT] anthem',
            negativeTags: 'sad, slow, lo-fi',
            vocalGender: ''
          }
        }
      ],
      edges: [
        { from: 'hero-image', to: 'shot-1', input: 'input_urls', output: 'output' },
        { from: 'shot-1', to: 'shot-2', input: 'input_urls', output: 'lastFrame' },
        { from: 'shot-2', to: 'shot-3', input: 'input_urls', output: 'lastFrame' }
      ]
    }
  },
  {
    id: 'anime-sequence',
    label: 'Anime sequence (keyframe + 3 shots + music)',
    description:
      'A 24s anime scene: a key visual sets the character design (used as an @Image reference — it never appears on screen), then three chained Seedance 2 shots (establishing → action → emotion) with a J-pop orchestral track.',
    styleId: 'anime',
    slots: ['[CHARACTER]', '[PLACE]', '[ACTION]'],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'key-visual',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Key visual',
          intent:
            'Character design reference for every shot (wired as @Image1) — it guides identity and style, it must never appear as a frame.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Anime key visual of [CHARACTER] standing in [PLACE], full-body, three-quarter view, character design sheet quality. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '1K'
          }
        },
        {
          key: 'shot-1',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 01 — Establishing',
          intent:
            'Wide establishing shot of the place, the character entering frame (design from @Image1).',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — the design sheet itself must not appear on screen). ' +
              'Shot 1: wide establishing shot of [PLACE], painterly anime background, [CHARACTER] walks into frame from the left, ' +
              'wind moving through the scene, slow pan following the character. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-2',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 02 — Action',
          intent:
            'The action beat of the scene, continuous with shot 1 (starts on its last frame @Image2).',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              '@Image2 as the first frame (seamless continuation of the previous shot). ' +
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              'Shot 1: dynamic medium shot, [CHARACTER] [ACTION], sakuga-quality fluid animation on the movement, ' +
              'speed lines and dramatic camera tilt at the peak of the action. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-3',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 03 — Emotion',
          intent:
            "Close-up emotional beat closing the scene (starts on shot 2's last frame @Image2).",
          position: { x: col(3), y: row(0) },
          params: {
            prompt:
              '@Image2 as the first frame (seamless continuation of the previous shot). ' +
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              "Shot 1: slow push-in close-up on [CHARACTER]'s face, hair moving in the breeze, golden-hour rim light, " +
              'a quiet emotional beat, eyes catching the light. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'music',
          modelId: 'suno/generate-music',
          label: 'Music — Anime score',
          intent: 'The emotional orchestral track of the scene.',
          position: { x: col(1), y: row(1) },
          params: {
            prompt: '',
            customMode: true,
            instrumental: true,
            model: 'V4_5',
            style:
              'anime opening, J-pop orchestral hybrid, soaring strings, energetic drums, emotional build',
            title: '[PLACE] theme',
            negativeTags: 'metal, harsh, dissonant',
            vocalGender: ''
          }
        }
      ],
      edges: [
        // Array order fixes the @Image numbering: the design reference is wired
        // FIRST on every shot (@Image1), the previous clip's last frame second (@Image2).
        { from: 'key-visual', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'key-visual', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'shot-1', to: 'shot-2', input: 'reference_image_urls', output: 'lastFrame' },
        { from: 'key-visual', to: 'shot-3', input: 'reference_image_urls', output: 'output' },
        { from: 'shot-2', to: 'shot-3', input: 'reference_image_urls', output: 'lastFrame' }
      ]
    }
  },
  {
    id: 'storyboard-sequence',
    label: 'Storyboarded scene (character sheet + 9-panel storyboard + 3 shots + music)',
    description:
      'The full pre-visualization pipeline: a character design sheet feeds a 9-panel storyboard grid (review the staging THERE, before any video credits are spent), then three chained Seedance 2 shots follow the storyboard panels in order — the sheet and the grid are wired as references, they never appear on screen.',
    styleId: 'anime',
    slots: ['[CHARACTER]', '[PLACE]', '[ACTION]'],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'character-sheet',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Character sheet',
          intent:
            'Character design reference — wired into the storyboard and every shot (@Image1), it must never appear as a frame.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Character design sheet of [CHARACTER]: full-body turnaround with three aligned views of the SAME character — front, three-quarter and profile — in a neutral standing pose. ' +
              'Identical proportions, outfit, hairstyle and colors across all views. Plain light background, no scenery, no text labels, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '1K'
          }
        },
        {
          key: 'storyboard',
          modelId: 'gpt-image-2-image-to-image',
          label: '01 — Storyboard (9 panels)',
          intent:
            'The 9-panel storyboard of the scene — the review gate before running the shots. Wired as a reference (@Image2) on every shot; it must never appear on screen.',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              'Create a storyboard of [CHARACTER] in [PLACE]: the scene where [CHARACTER] [ACTION]. ' +
              'A single 3x3 grid of 9 sequential panels telling the scene beat by beat, read left to right, top to bottom, a small panel number in the corner of each panel: ' +
              'panels 1-3 establish [PLACE] and the character entering, panels 4-6 cover the action ([ACTION]), panels 7-9 land the emotional close-up finale. ' +
              'Keep the character exactly consistent with the connected design sheet (Image 1) across all panels. ' +
              'Framing varies like a film — establishing wide, mediums, close-ups. Clear readable compositions, no speech bubbles, no captions, no other text, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '1K'
          }
        },
        {
          key: 'shot-1',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 01 — Establishing (panels 1-3)',
          intent:
            'Wide establishing shot following storyboard panels 1-3 (character design @Image1, storyboard @Image2 — references only).',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — the sheet must not appear on screen). ' +
              '@Image2 is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom; this shot covers panels 1-3. ' +
              'Shot 1: wide establishing shot of [PLACE], [CHARACTER] walks into frame, slow pan following the character, wind moving through the scene. ' +
              'Render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-2',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 02 — Action (panels 4-6)',
          intent:
            'Action beat following storyboard panels 4-6, continuous with shot 1 (starts on its last frame @Image3).',
          position: { x: col(3), y: row(0) },
          params: {
            prompt:
              '@Image3 as the first frame (seamless continuation of the previous shot). ' +
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              '@Image2 is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom; this shot covers panels 4-6. ' +
              'Shot 1: dynamic medium shot, [CHARACTER] [ACTION], fluid animation on the movement, dramatic camera tilt at the peak of the action. ' +
              'Render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-3',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 03 — Finale (panels 7-9)',
          intent:
            "Emotional close-up finale following storyboard panels 7-9 (starts on shot 2's last frame @Image3).",
          position: { x: col(4), y: row(0) },
          params: {
            prompt:
              '@Image3 as the first frame (seamless continuation of the previous shot). ' +
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              '@Image2 is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom; this shot covers panels 7-9. ' +
              "Shot 1: slow push-in close-up on [CHARACTER]'s face, a quiet emotional beat closing the scene, eyes catching the light. " +
              'Render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks. ' +
              bible('anime'),
            aspect_ratio: '16:9',
            resolution: '720p',
            duration: 8,
            generate_audio: true,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'music',
          modelId: 'suno/generate-music',
          label: 'Music — Scene score',
          intent: 'The emotional orchestral track of the scene.',
          position: { x: col(2), y: row(1) },
          params: {
            prompt: '',
            customMode: true,
            instrumental: true,
            model: 'V4_5',
            style:
              'anime opening, J-pop orchestral hybrid, soaring strings, energetic drums, emotional build',
            title: '[PLACE] theme',
            negativeTags: 'metal, harsh, dissonant',
            vocalGender: ''
          }
        }
      ],
      edges: [
        // Array order fixes the @Image numbering on every shot: character sheet
        // FIRST (@Image1), storyboard grid second (@Image2), continuity third (@Image3).
        { from: 'character-sheet', to: 'storyboard', input: 'input_urls', output: 'output' },
        { from: 'character-sheet', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'character-sheet', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'shot-1', to: 'shot-2', input: 'reference_image_urls', output: 'lastFrame' },
        { from: 'character-sheet', to: 'shot-3', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-3', input: 'reference_image_urls', output: 'output' },
        { from: 'shot-2', to: 'shot-3', input: 'reference_image_urls', output: 'lastFrame' }
      ]
    }
  },
  {
    id: 'cinematic-sequence',
    label: 'Cinematic sequence (3 shots + score)',
    description:
      'A 24s photorealistic film sequence: three chained shots (establishing → tracking → close-up) with an emotional film score.',
    styleId: 'cinematic-realism',
    slots: ['[SUBJECT]', '[LOCATION]', '[MOOD]'],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'shot-1',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 01 — Establishing',
          intent: 'Wide cinematic establishing shot setting the location and mood.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Wide establishing shot of [LOCATION], [MOOD] atmosphere, atmospheric haze catching the light, ' +
              '[SUBJECT] small in frame, very slow dolly forward. ' +
              bible('cinematic-realism'),
            aspect_ratio: '21:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-2',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 02 — Tracking',
          intent: 'Tracking shot following the subject, continuous with shot 1.',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              'Smooth lateral tracking shot following [SUBJECT] moving through [LOCATION], ' +
              'foreground elements passing between camera and subject for depth, motivated natural light. ' +
              bible('cinematic-realism'),
            aspect_ratio: '21:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-3',
          modelId: 'bytedance/seedance-1.5-pro',
          label: 'Shot 03 — Close-up',
          intent: 'Intimate close-up ending the sequence on the subject.',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              'Slow push-in to a close-up on [SUBJECT], shallow depth of field, [MOOD] expression, ' +
              'practical lights blooming softly in the bokeh background, long held final frame. ' +
              bible('cinematic-realism'),
            aspect_ratio: '21:9',
            resolution: '1080p',
            duration: 8,
            fixed_lens: false,
            generate_audio: true,
            nsfw_checker: true
          }
        },
        {
          key: 'music',
          modelId: 'suno/generate-music',
          label: 'Music — Film score',
          intent: 'The emotional score of the sequence.',
          position: { x: col(0), y: row(1) },
          params: {
            prompt: '',
            customMode: true,
            instrumental: true,
            model: 'V4_5',
            style:
              'cinematic film score, emotional strings and piano, subtle percussion, slow build, atmospheric',
            title: '[LOCATION] score',
            negativeTags: 'edm, pop, upbeat',
            vocalGender: ''
          }
        }
      ],
      edges: [
        { from: 'shot-1', to: 'shot-2', input: 'input_urls', output: 'lastFrame' },
        { from: 'shot-2', to: 'shot-3', input: 'input_urls', output: 'lastFrame' }
      ]
    }
  },
  {
    id: 'vertical-social-ad',
    label: 'Vertical social ad (9:16, 2 shots + music)',
    description:
      'A snappy 9:16 social ad: product image animated by Seedance 2 via @Image1, a punchline shot, and an energetic track.',
    styleId: 'commercial',
    slots: ['[PRODUCT]', '[HOOK]'],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'product-image',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Product visual',
          intent: 'The vertical product visual used as first frame of the hook shot.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Vertical (9:16) product photograph of [PRODUCT], bold centered composition, vibrant gradient backdrop, ' +
              'punchy studio lighting, room at the top for a caption. ' +
              bible('commercial'),
            aspect_ratio: '9:16',
            resolution: '1K'
          }
        },
        {
          key: 'shot-1',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 01 — Hook',
          intent: 'Attention-grabbing opening: the product visual bursts to life. Hook: "[HOOK]".',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              '@Image1 as the first frame. Shot 1: the scene snaps alive, [PRODUCT] pops forward with a quick zoom burst and light sweep. ' +
              'Shot 2: cut to a fast orbital move around [PRODUCT], energetic particles and speculars, camera settles on a bold centered frame. ' +
              bible('commercial'),
            generate_audio: true,
            resolution: '720p',
            aspect_ratio: '9:16',
            duration: 8,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'shot-2',
          modelId: 'bytedance/seedance-2-fast',
          label: 'Shot 02 — Punchline',
          intent: 'Closing beat with space for the call to action.',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              '@Image1 as the first frame. Shot 1: quick whip-pan reveal of [PRODUCT] in a lifestyle context, hands reaching for it. ' +
              'Shot 2: cut to a snap zoom out to a clean final frame, [PRODUCT] centered with negative space above for a call to action. ' +
              bible('commercial'),
            generate_audio: true,
            resolution: '720p',
            aspect_ratio: '9:16',
            duration: 7,
            web_search: false,
            nsfw_checker: true
          }
        },
        {
          key: 'music',
          modelId: 'suno/generate-music',
          label: 'Music — Energetic hook',
          intent: 'The 15s energetic track of the ad.',
          position: { x: col(0), y: row(1) },
          params: {
            prompt: '',
            customMode: true,
            instrumental: true,
            model: 'V4_5',
            style:
              'high-energy social media ad, trap-pop hybrid, punchy 808s, catchy synth hook, 130 BPM',
            title: '[PRODUCT] hook',
            negativeTags: 'slow, ambient, sad',
            vocalGender: ''
          }
        }
      ],
      edges: [
        { from: 'product-image', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'shot-1', to: 'shot-2', input: 'reference_image_urls', output: 'lastFrame' }
      ]
    }
  }
]

const TEMPLATE_MAP = new Map(WORKFLOW_TEMPLATES.map((t) => [t.id, t]))

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATE_MAP.get(id)
}

export const workflowTemplateIds = WORKFLOW_TEMPLATES.map((t) => t.id)
