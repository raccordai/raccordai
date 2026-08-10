import { z } from 'zod'
import type { ModelDefinition } from './types'

/**
 * Volcengine video-to-video lip sync (kie.ai jobs API).
 * API reference: https://docs.kie.ai/market/volcengine/video-to-video-lip-sync
 * No prompt: the model re-animates the speaker's mouth in the source video to
 * match the wired audio track. Output is MP4 at 25 fps, duration = the audio's
 * (the source video is trimmed if longer, looped if shorter).
 */

const MODES = ['lite', 'basic'] as const

const paramsSchema = z.object({
  // lite = single person facing the camera; basic = complex scenes (scene
  // segmentation + speaker identification available via open_scenedet).
  mode: z.enum(MODES).default('lite'),
  separate_vocal: z.boolean().default(false),
  // basic mode only.
  open_scenedet: z.boolean().default(false),
  // lite mode only.
  align_audio: z.boolean().default(true),
  align_audio_reverse: z.boolean().default(false),
  templ_start_seconds: z.number().min(0).max(3600).default(0)
})

type Params = z.infer<typeof paramsSchema>

export const volcengineLipSync: ModelDefinition<Params> = {
  id: 'volcengine/video-to-video-lip-sync',
  label: 'Volcengine Lip Sync',
  description:
    'Video-to-video lip sync: re-animates the mouth of the speaker in an existing video to match a new audio track (dubbing, translation, voice swap).',
  kind: 'video',
  recommendedFor: ['lip-sync', 'dubbing', 'video-to-video'],
  paramsSchema,
  // No estimateCredits: kie.ai publishes no per-run rate for this model — the
  // UI shows nothing rather than a guess (https://kie.ai/pricing).
  paramFields: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      defaultValue: 'lite',
      options: [
        { value: 'lite', label: 'Lite (single person, frontal)' },
        { value: 'basic', label: 'Basic (complex scenes)' }
      ],
      description:
        'Lite handles one person facing the camera; Basic handles complex scenes and enables scene segmentation.'
    },
    {
      key: 'separate_vocal',
      label: 'Separate vocals',
      type: 'boolean',
      defaultValue: false,
      description:
        'Extract the voice from the audio track first — enable when the audio has background music or noise.'
    },
    {
      key: 'open_scenedet',
      label: 'Scene detection',
      type: 'boolean',
      defaultValue: false,
      description: 'Scene segmentation and speaker identification. Basic mode only.'
    },
    {
      key: 'align_audio',
      label: 'Loop video to audio',
      type: 'boolean',
      defaultValue: true,
      description:
        'Loop the source video when the audio is longer than it (off = the result stops with the video). Lite mode only.'
    },
    {
      key: 'align_audio_reverse',
      label: 'Ping-pong loop',
      type: 'boolean',
      defaultValue: false,
      description:
        'Loop the video forward-then-backward instead of restarting (needs "Loop video to audio"). Lite mode only.'
    },
    {
      key: 'templ_start_seconds',
      label: 'Video start (s)',
      type: 'number',
      min: 0,
      max: 3600,
      defaultValue: 0,
      description: 'Skip into the source video before syncing starts. Lite mode only.'
    }
  ],
  inputs: [
    {
      key: 'video_url',
      label: 'Source video',
      accepts: ['video'],
      required: true,
      maxCount: 1,
      description:
        'The video whose speaker gets re-lip-synced — it IS the output picture. 360p-1080p, MP4/MOV, H.264 recommended, 24-60 fps, ≤500 MB. Wire a generated clip or an uploaded asset with a clearly visible face.'
    },
    {
      key: 'audio_url',
      label: 'Voice audio',
      accepts: ['audio'],
      required: true,
      maxCount: 1,
      description:
        'The speech to sync the mouth to — pure vocals work best (mp3/wav/aac/m4a/ogg, ≤10 MB). Wire an ElevenLabs speech node, or enable "Separate vocals" for audio with music/noise. The output duration follows this audio.'
    }
  ],
  outputs: [
    { key: 'output', label: 'Output video', kind: 'video' },
    { key: 'lastFrame', label: 'Last frame', kind: 'image' }
  ],
  promptingNotes:
    'No prompt — this model only re-animates the mouth of the speaker in `video_url` to match `audio_url`. Everything else in the picture is preserved verbatim.\n' +
    'Typical pipeline: generate the clip (Seedance/Kling), generate the voice line (ElevenLabs speech), then wire both here to dub the clip — this replaces blank-voice-over tricks when exact speech is needed.\n' +
    'The OUTPUT duration follows the audio: the source video is trimmed when longer, looped when shorter (lite mode, `align_audio`). The timeline cannot read a planned duration from the params — trust the rendered media.\n' +
    'Modes: `lite` for one person facing the camera (supports looping and `templ_start_seconds`); `basic` for complex scenes, with optional scene segmentation + speaker identification (`open_scenedet`).\n' +
    'Audio must be mostly clean speech (≤10 MB); enable `separate_vocal` when it carries music or noise. Video: 360p-1080p, H.264 MP4/MOV, 24-60 fps, ≤500 MB.',
  buildPayload: ({ params, inputs }) => {
    const payload: Record<string, unknown> = {
      mode: params.mode,
      separate_vocal: params.separate_vocal
    }
    const video = inputs.video_url?.[0]
    const audio = inputs.audio_url?.[0]
    if (video) payload.video_url = video
    if (audio) payload.audio_url = audio
    // The remaining switches are mode-scoped — send only what the mode reads.
    if (params.mode === 'basic') {
      payload.open_scenedet = params.open_scenedet
    } else {
      payload.align_audio = params.align_audio
      if (params.align_audio) payload.align_audio_reverse = params.align_audio_reverse
      if (params.templ_start_seconds > 0) payload.templ_start_seconds = params.templ_start_seconds
    }
    return payload
  }
}
