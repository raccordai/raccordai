import { z } from 'zod'
import type { ModelDefinition } from './types'

const ASPECT = ['16:9', '9:16'] as const
const RESOLUTION = ['360p', '720p', '1080p', '4k'] as const
/** kie.ai only accepts these clip lengths (sent as strings: "4" | "6" | "8" | "10"). */
const DURATIONS = [4, 6, 8, 10] as const

/** Nearest allowed duration; ties snap to the shorter (cheaper) value. */
const snapDuration = (d: number): (typeof DURATIONS)[number] =>
  DURATIONS.reduce((best, v) => (Math.abs(v - d) < Math.abs(best - d) ? v : best))

const paramsSchema = z.object({
  prompt: z.string().min(1).max(20000),
  aspect_ratio: z.enum(ASPECT).default('16:9'),
  resolution: z.enum(RESOLUTION).default('720p'),
  // Stored as a number so the timeline can read clip durations; snapped to 4/6/8/10 in buildPayload.
  duration: z.number().int().min(4).max(10).default(8),
  // Trim window applied to a wired source video (video_list start/ends). The
  // API caps the span at 10 s; buildPayload snaps an invalid window.
  video_start: z.number().min(0).max(30).default(0),
  video_end: z.number().min(0).max(30).default(10)
})

type Params = z.infer<typeof paramsSchema>

export const geminiOmniFlash11: ModelDefinition<Params> = {
  id: 'google/gemini-omni-flash-1-1',
  label: 'Gemini Omni 1.1 Flash',
  description:
    "Google's multimodal video model: text, reference images, a trimmed source video and first/last keyframes in one run. 4-10 s clips, fast same-price 360p drafts, up to 4K output, and scene extension from up to 10 s of previous footage.",
  kind: 'video',
  recommendedFor: ['first-frame-animation', 'video-to-video', 'high-resolution', 'cinematic'],
  // Same model floored to 360p: kie prices 360p/720p/1080p identically, so this
  // only saves credits on 4K nodes (−84/run) — but 360p generates up to 60%
  // faster, which is what draft iteration is for. A node already at 360p
  // resolves to null and is never stamped draft.
  draftEquivalent: { modelId: 'google/gemini-omni-flash-1-1', params: { resolution: '360p' } },
  paramsSchema,
  paramFields: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', defaultValue: '' },
    {
      key: 'duration',
      label: 'Duration (s)',
      type: 'number',
      min: 4,
      max: 10,
      step: 2,
      defaultValue: 8,
      description:
        'Whole seconds — the API accepts 4, 6, 8 or 10 (other values snap to the nearest). Ignored when a source video is wired: the model then decides the output length.'
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect ratio',
      type: 'select',
      defaultValue: '16:9',
      options: ASPECT.map((v) => ({ value: v, label: v }))
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'select',
      defaultValue: '720p',
      options: RESOLUTION.map((v) => ({ value: v, label: v })),
      description:
        '360p drafts generate up to 60% faster at the same credit price as 720p/1080p; 4K adds a flat +84 credits per run.'
    },
    {
      key: 'video_start',
      label: 'Source video start (s)',
      type: 'number',
      min: 0,
      max: 30,
      defaultValue: 0,
      description: 'Where the trim of the wired source video begins. Only used with a source video.'
    },
    {
      key: 'video_end',
      label: 'Source video end (s)',
      type: 'number',
      min: 0,
      max: 30,
      defaultValue: 10,
      description:
        'Where the trim ends — the API caps the window at 10 s after the start (an invalid window snaps to the longest legal one). Only used with a source video.'
    }
  ],
  inputs: [
    {
      key: 'first_frame_url',
      label: 'First frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        "This image IS the opening frame (literal anchor — a clean scene still or hero shot; never design sheets, and never the previous clip's lastFrame). First-frame mode is exclusive on the API side: with it set, reference images and the source video cannot be sent."
    },
    {
      key: 'last_frame_url',
      label: 'Last frame',
      accepts: ['image'],
      maxCount: 1,
      frameAnchor: true,
      description:
        'This image IS the closing frame. The API only accepts it together with a first frame — the model generates the motion between the two keyframes (zooms, orbits, seamless loops).'
    },
    {
      key: 'image_urls',
      label: 'Reference images',
      accepts: ['image'],
      multiple: true,
      maxCount: 7,
      description:
        'References GUIDE characters, scenes, styles or storyboards and do NOT appear on screen. Up to 7 images (≤20 MB each) — a wired source video takes 2 of those 7 slots. Mutually exclusive with the First frame anchor.'
    },
    {
      key: 'video_list',
      label: 'Source video',
      accepts: ['video'],
      maxCount: 1,
      description:
        'One source video (≤100 MB, ≤30 s), trimmed by the Source video start/end params to a ≤10 s window — the scene-extension / video-to-video channel (the model reads up to 10 s of context). Counts as 2 of the 7 reference slots; output duration is decided by the model (the Duration param is ignored). Mutually exclusive with the First frame anchor.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'Two exclusive input modes per run: keyframe mode (First frame, optionally + Last frame — literal anchors that appear on screen) OR multimodal mode (reference images + one source video — they GUIDE and never appear). The API rejects a run mixing both.\n' +
    'Reference budget: 7 slots — each image takes 1, the source video takes 2. Wire the SAME character/style sheets on every shot for consistency; never wire a design sheet to the frame anchors.\n' +
    'Duration is 4/6/8/10 s and only applies without a source video; with one wired, the model decides the output length and reads up to 10 s of the trimmed window as context — that is the reliable way to extend a scene.\n' +
    "Between shots, CUT — do not chain. Wiring the previous node's lastFrame as this clip's first frame glitches the seam (a generated closing frame is motion-blurred and compressed); for genuine continuity, wire the previous CLIP as the source video instead.\n" +
    'Iterate at 360p (up to 60% faster, same credit price as 720p/1080p), then re-run the keeper at 1080p or 4K (+84 credits flat).',
  // Distilled from kie.ai's Gemini Omni 1.1 Flash model page and the
  // google/gemini-omni-flash-1-1 createTask OpenAPI spec.
  promptGuide: `ANATOMY: one paragraph describing, in order — visual content (subject, setting, era) →
style (medium, grade, mood) → cinematography (shot size, lens, movement) → character actions.
The model parses intentional camera direction: dolly zooms, snap zooms, push-ins, pull-backs,
360-degree orbits, seamless loops.

INPUT MODES (mutually exclusive per run — the API rejects a mix):
  - KEYFRAME MODE: First frame alone anchors the opening image; First + Last frame make the model
    generate the motion between the two stills — use it for cinematic zooms, camera orbits, loops
    and controlled transitions. Both images appear literally on screen: wire clean stills only.
  - MULTIMODAL MODE: up to 7 reference slots. Reference images (1 slot each) guide characters,
    scenes, styles or storyboards without appearing on screen. One source video (2 slots, ≤30 s
    file, trimmed to a ≤10 s window) guides movement and scene details — and is the
    scene-extension channel: the model reads up to 10 s of previous footage as context and
    continues it with consistent characters, environments and motion.

DURATION & OUTPUT:
  - 4 / 6 / 8 / 10 s without a source video; WITH one, the model decides the length and the
    duration param is ignored — plan the timeline around the trimmed context window instead.
  - 16:9 or 9:16. Draft at 360p (up to 60% faster, same credit price as 720p/1080p), then re-run
    the keeper at 1080p or 4K for the final master.

PITFALLS:
  - A Last frame without a First frame is rejected — the pair is what defines the in-between.
  - Budget the 7 slots before wiring: 1 video + 5 images is full; first-frame mode locks out
    every reference input.
  - Consistency across cuts = the same reference sheets wired on every shot, never a lastFrame
    chain; true continuity = the previous clip as the source video.

FULL EXAMPLE:
  "A rain-slicked neon street in a futuristic city at night, cinematic photorealism with teal and
  magenta practicals. Slow push-in at eye level as a courier in a reflective jacket steps out of
  a noodle stall into the crowd; steam drifts through the frame. Shallow depth of field, anamorphic
  flares, handheld micro-shake. She pauses, looks up at a holographic billboard, and smiles."`,
  // Official kie.ai rates (https://kie.ai/gemini-omni-1-1-flash): 360p/720p/1080p
  // share one price — 63/84/105/126 credits at 4/6/8/10 s — and 4K adds a flat
  // +84. A run WITH a source video is billed flat instead (168, 4K 252);
  // estimateCredits only sees params, never the wired handles, so the
  // duration-based rate is what we quote.
  estimateCredits: (params) =>
    ({ 4: 63, 6: 84, 8: 105, 10: 126 })[snapDuration(params.duration)] +
    (params.resolution === '4k' ? 84 : 0),
  buildPayload: ({ params, inputs }) => {
    const first = inputs.first_frame_url?.[0]
    const last = inputs.last_frame_url?.[0]
    const images = inputs.image_urls ?? []
    const video = inputs.video_list?.[0]
    // The API requires 0 < ends - start ≤ 10: snap an invalid window to the
    // longest legal one instead of failing after the credits are committed.
    const start = Math.max(0, params.video_start)
    const ends = params.video_end > start ? Math.min(params.video_end, start + 10) : start + 10
    return {
      prompt: params.prompt,
      // First-frame mode locks out every other media input on the API side —
      // optional fields are omitted rather than sent empty (presence is intent).
      ...(first ? { first_frame_url: first } : {}),
      ...(last ? { last_frame_url: last } : {}),
      ...(images.length > 0 ? { image_urls: images } : {}),
      ...(video ? { video_list: [{ url: video, start, ends }] } : {}),
      duration: String(snapDuration(params.duration)), // the API expects "4" | "6" | "8" | "10"
      aspect_ratio: params.aspect_ratio,
      resolution: params.resolution
    }
  }
}
