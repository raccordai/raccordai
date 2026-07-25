/**
 * Workflow templates — ready-to-import graph blueprints (workflow JSON v1,
 * the exact format accepted by import_workflow). Prompts contain [SLOTS]
 * meant to be filled by the user or the assistant before running; every
 * visual node carries `applyVideoStyle: true`, so the video's style bible is
 * appended to its prompt at run time (set the video's style to the template's
 * styleId — the new-video flow does) and a later style switch propagates
 * without editing any prompt.
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

export interface WorkflowTemplateSlot {
  /** The literal token as it appears in the blueprint, e.g. "[PRODUCT]". */
  token: string
  /** i18n key of the field label in the new-video dialog (`templates.slots.*`, fr+en). */
  i18nKey: string
  /** Example value — field placeholder, and the fill used by the starter project. */
  example: string
}

export interface WorkflowTemplate {
  id: string
  /** Agent-facing English name; UI display names live in i18n under `templates.<id>`. */
  label: string
  description: string
  /** The style template the blueprint's prompts are written with. */
  styleId: string
  /** Placeholder slots present in the blueprint — fill before running (see fillTemplateSlots). */
  slots: WorkflowTemplateSlot[]
  workflow: {
    version: 1
    nodes: WorkflowTemplateNode[]
    edges: WorkflowTemplateEdge[]
  }
}

// Shared slot vocabulary — templates reference these so the same token always
// carries the same label key; the registry test enforces token/blueprint parity.
const SLOTS = {
  product: {
    token: '[PRODUCT]',
    i18nKey: 'templates.slots.product',
    example: 'Aurora wireless headphones'
  },
  setting: { token: '[SETTING]', i18nKey: 'templates.slots.setting', example: 'a sunlit loft' },
  tagline: { token: '[TAGLINE]', i18nKey: 'templates.slots.tagline', example: 'Sound, redefined.' },
  character: {
    token: '[CHARACTER]',
    i18nKey: 'templates.slots.character',
    example: 'Léa, 20, pink hair, yellow jacket'
  },
  place: {
    token: '[PLACE]',
    i18nKey: 'templates.slots.place',
    example: 'a rooftop garden above a neon city'
  },
  action: {
    token: '[ACTION]',
    i18nKey: 'templates.slots.action',
    example: 'leaps across the gap at sunset'
  },
  subject: {
    token: '[SUBJECT]',
    i18nKey: 'templates.slots.subject',
    example: 'an old lighthouse keeper'
  },
  location: {
    token: '[LOCATION]',
    i18nKey: 'templates.slots.location',
    example: 'a storm-battered coastline'
  },
  mood: { token: '[MOOD]', i18nKey: 'templates.slots.mood', example: 'melancholic, hopeful' },
  hook: { token: '[HOOK]', i18nKey: 'templates.slots.hook', example: 'Your feed stops here.' }
} satisfies Record<string, WorkflowTemplateSlot>

/** Grid helpers so every template lays out the same way (left-to-right flow). */
const col = (i: number): number => i * 420
const row = (i: number): number => i * 350

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'product-commercial',
    label: 'Product commercial (3 shots + music)',
    description:
      'A 24s product ad: one hero product image anchoring three cinematic shots cut together (reveal → detail → tagline), scored with an upbeat track.',
    styleId: 'commercial',
    slots: [SLOTS.product, SLOTS.setting, SLOTS.tagline],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'hero-image',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Hero product shot',
          intent:
            'The ad-ready hero image of the product, anchoring the first frame of every shot.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Hero product photograph of [PRODUCT] on a seamless studio backdrop in [SETTING]. ' +
              'Centered composition with generous negative space, soft key light with crisp speculars, subtle reflection under the product.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
              'fine dust particles glinting in the beam.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
          intent:
            'Macro orbital shot on the product details — a cut to a new lens, re-anchored on the hero still.',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              'Open on a macro orbital shot circling [PRODUCT], extreme close-up on its textures and materials, ' +
              'shallow depth of field, satisfying slow motion. This is a cut to a new camera setup, ' +
              'not a continuation of the previous shot.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
              'lighting settling into an elegant final frame. This is a cut to a new camera setup, ' +
              'not a continuation of the previous shot.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
        // Every shot departs from the SAME clean hero still. Seedance 1.5 has no
        // reference inputs — input_urls is a literal frame anchor — so the only
        // way to keep the product identical without chaining a generated (and
        // often degraded) last frame is to re-anchor each shot on the source
        // image and let the prompt take the camera somewhere else.
        { from: 'hero-image', to: 'shot-1', input: 'input_urls', output: 'output' },
        { from: 'hero-image', to: 'shot-2', input: 'input_urls', output: 'output' },
        { from: 'hero-image', to: 'shot-3', input: 'input_urls', output: 'output' }
      ]
    }
  },
  {
    id: 'anime-sequence',
    label: 'Anime sequence (keyframe + 3 shots + music)',
    description:
      'A 24s anime scene: a key visual sets the character design (used as an @Image reference — it never appears on screen), then three Seedance 2 shots cut together (establishing → action → emotion), each a new camera setup sharing that reference, with a J-pop orchestral track.',
    styleId: 'anime',
    slots: [SLOTS.character, SLOTS.place, SLOTS.action],
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
              'Anime key visual of [CHARACTER] standing in [PLACE], full-body, three-quarter view, character design sheet quality.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
            'The action beat of the scene — a hard cut to a new camera setup, identity carried by @Image1.',
          position: { x: col(2), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              'New camera setup: this is a cut, not a continuation of the previous shot. ' +
              'Shot 1: dynamic medium shot, [CHARACTER] [ACTION], sakuga-quality fluid animation on the movement, ' +
              'speed lines and dramatic camera tilt at the peak of the action. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
            'Close-up emotional beat closing the scene — a hard cut to a tighter lens, identity carried by @Image1.',
          position: { x: col(3), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              'New camera setup: this is a cut, not a continuation of the previous shot. ' +
              "Shot 1: slow push-in close-up on [CHARACTER]'s face, hair moving in the breeze, golden-hour rim light, " +
              'a quiet emotional beat, eyes catching the light. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
        // One shared reference (@Image1) on every shot — NOT a lastFrame chain.
        // Chaining a generated closing frame into the next clip is what produces
        // the glitchy pseudo-continuity; each shot is a deliberate cut instead,
        // and identity is carried by the key visual all three shots share.
        { from: 'key-visual', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'key-visual', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'key-visual', to: 'shot-3', input: 'reference_image_urls', output: 'output' }
      ]
    }
  },
  {
    id: 'storyboard-sequence',
    label: 'Storyboarded scene (character sheet + 9-panel storyboard + 3 shots + music)',
    description:
      'The full pre-visualization pipeline: a character design sheet feeds a 9-panel storyboard grid (review the staging THERE, before any video credits are spent), then three Seedance 2 shots cut together follow the storyboard panels in order — the sheet and the grid are wired as references, they never appear on screen.',
    styleId: 'anime',
    slots: [SLOTS.character, SLOTS.place, SLOTS.action],
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
              'Identical proportions, outfit, hairstyle and colors across all views. Plain light background, no scenery, no text labels, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
              'Framing varies like a film — establishing wide, mediums, close-ups. Clear readable compositions, no speech bubbles, no captions, no other text, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
            'Action beat following storyboard panels 4-6 — a hard cut to a new camera setup, staged by @Image2.',
          position: { x: col(3), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              '@Image2 is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom; this shot covers panels 4-6. ' +
              'New camera setup: this is a cut, not a continuation of the previous shot. ' +
              'Shot 1: dynamic medium shot, [CHARACTER] [ACTION], fluid animation on the movement, dramatic camera tilt at the peak of the action. ' +
              'Render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
            'Emotional close-up finale following storyboard panels 7-9 — a hard cut to a tighter lens, staged by @Image2.',
          position: { x: col(4), y: row(0) },
          params: {
            prompt:
              '[CHARACTER] matches the character design @Image1 (reference only — never shown on screen). ' +
              '@Image2 is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom; this shot covers panels 7-9. ' +
              'New camera setup: this is a cut, not a continuation of the previous shot. ' +
              "Shot 1: slow push-in close-up on [CHARACTER]'s face, a quiet emotional beat closing the scene, eyes catching the light. " +
              'Render one single full-frame shot: no 3x3 grid, no panel borders, no panel numbers, no split-screen or comic-panel layout. ' +
              '2D anime style, high-definition, rich detail; faces stable, smooth motion, no subtitles, no watermarks.',
            aspect_ratio: '16:9',
            applyVideoStyle: true,
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
        // FIRST (@Image1), storyboard grid second (@Image2). No lastFrame chain —
        // the storyboard is what holds the scene together, and it does so without
        // forcing each clip to open on the previous clip's degraded closing frame.
        { from: 'character-sheet', to: 'storyboard', input: 'input_urls', output: 'output' },
        { from: 'character-sheet', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'character-sheet', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-2', input: 'reference_image_urls', output: 'output' },
        { from: 'character-sheet', to: 'shot-3', input: 'reference_image_urls', output: 'output' },
        { from: 'storyboard', to: 'shot-3', input: 'reference_image_urls', output: 'output' }
      ]
    }
  },
  {
    id: 'cinematic-sequence',
    label: 'Cinematic sequence (3 shots + score)',
    description:
      'A 24s photorealistic film sequence: three shots cut together (establishing → tracking → close-up) with an emotional film score.',
    styleId: 'cinematic-realism',
    slots: [SLOTS.subject, SLOTS.location, SLOTS.mood],
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
              '[SUBJECT] small in frame, very slow dolly forward.',
            aspect_ratio: '21:9',
            applyVideoStyle: true,
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
          intent: 'Tracking shot following the subject — a cut to a new camera setup.',
          position: { x: col(1), y: row(0) },
          params: {
            prompt:
              'Smooth lateral tracking shot following [SUBJECT] moving through [LOCATION], ' +
              'foreground elements passing between camera and subject for depth, motivated natural light.',
            aspect_ratio: '21:9',
            applyVideoStyle: true,
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
              'practical lights blooming softly in the bokeh background, long held final frame.',
            aspect_ratio: '21:9',
            applyVideoStyle: true,
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
      // No edges: three self-contained shots cut together. Seedance 1.5 has no
      // reference inputs, so chaining was the only "consistency" lever — and it
      // bought a glitchy transition rather than a real match. Each prompt names
      // [SUBJECT], [LOCATION] and [MOOD] instead, and the cuts read as cuts.
      edges: []
    }
  },
  {
    id: 'vertical-social-ad',
    label: 'Vertical social ad (9:16, 2 shots + music)',
    description:
      'A snappy 9:16 social ad: product image animated by Seedance 2 via @Image1, a punchline shot, and an energetic track.',
    styleId: 'commercial',
    slots: [SLOTS.product, SLOTS.hook],
    workflow: {
      version: 1,
      nodes: [
        {
          key: 'product-image',
          modelId: 'gpt-image-2-text-to-image',
          label: '00 — Product visual',
          intent: 'The vertical product visual used as @Image1 first frame on both shots.',
          position: { x: col(0), y: row(0) },
          params: {
            prompt:
              'Vertical (9:16) product photograph of [PRODUCT], bold centered composition, vibrant gradient backdrop, ' +
              'punchy studio lighting, room at the top for a caption.',
            aspect_ratio: '9:16',
            applyVideoStyle: true,
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
              'Shot 2: cut to a fast orbital move around [PRODUCT], energetic particles and speculars, camera settles on a bold centered frame.',
            generate_audio: true,
            resolution: '720p',
            aspect_ratio: '9:16',
            applyVideoStyle: true,
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
              'Shot 2: cut to a snap zoom out to a clean final frame, [PRODUCT] centered with negative space above for a call to action.',
            generate_audio: true,
            resolution: '720p',
            aspect_ratio: '9:16',
            applyVideoStyle: true,
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
        // Both shots reference the SAME product visual as @Image1. Shot 2 used to
        // take shot 1's last frame instead, which made the punchline open on a
        // degraded frame — and its prompt still says "@Image1 as the first frame",
        // so the reference has to stay the clean source image.
        { from: 'product-image', to: 'shot-1', input: 'reference_image_urls', output: 'output' },
        { from: 'product-image', to: 'shot-2', input: 'reference_image_urls', output: 'output' }
      ]
    }
  }
]

const TEMPLATE_MAP = new Map(WORKFLOW_TEMPLATES.map((t) => [t.id, t]))

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATE_MAP.get(id)
}

export const workflowTemplateIds = WORKFLOW_TEMPLATES.map((t) => t.id)

/**
 * Replaces slot tokens across every string of a blueprint (prompts, labels,
 * intents, music titles…), keyed by the literal token ("[PRODUCT]" → value).
 * Blank values leave their token in place — still assistant-fillable later.
 * Pure and non-mutating: returns a fresh workflow, string-safe by construction
 * (no JSON round-trip of user input).
 */
export function fillTemplateSlots(
  workflow: WorkflowTemplate['workflow'],
  values: Record<string, string>
): WorkflowTemplate['workflow'] {
  const entries = Object.entries(values)
    .map(([token, value]) => [token, value.trim()] as const)
    .filter(([, value]) => value !== '')
  const fill = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return entries.reduce<string>((acc, [token, value]) => acc.split(token).join(value), input)
    }
    if (Array.isArray(input)) return input.map(fill)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, fill(value)]))
    }
    return input
  }
  return fill(workflow) as WorkflowTemplate['workflow']
}
