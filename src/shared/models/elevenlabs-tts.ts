import { z } from 'zod'
import { SPEECH_STABILITY_VALUES } from '../speech'
import type { ModelDefinition } from './types'

/**
 * ElevenLabs premade "Rachel" — the out-of-the-box narrator so a freshly
 * created node runs without configuration. Replace with a custom voice id or
 * a voice persona's id for the channel's real voice.
 */
export const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'

const paramsSchema = z.object({
  prompt: z.string().max(5000).default(''),
  voiceId: z.string().max(200).default(DEFAULT_ELEVENLABS_VOICE_ID),
  stability: z.enum(['creative', 'natural', 'robust']).default('natural'),
  languageCode: z.string().max(10).default('')
})

type Params = z.infer<typeof paramsSchema>

export const elevenlabsTts: ModelDefinition<Params> = {
  id: 'elevenlabs/text-to-speech',
  label: 'ElevenLabs — Text to Speech',
  description:
    'Voice-over from text with Eleven v3: one voice (premade, cloned or a voice persona), ' +
    'expressive audio tags, and a timed transcript stored on the generation.',
  kind: 'audio',
  audioRole: 'speech',
  provider: 'elevenlabs',
  recommendedFor: ['voice-over', 'narration', 'youtube'],
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Text',
      type: 'textarea',
      defaultValue: '',
      description:
        'What the voice says. Eleven v3 honors bracketed audio tags: [whispers], [laughs], [sighs], [excited]…'
    },
    {
      key: 'voiceId',
      label: 'Voice',
      type: 'text',
      defaultValue: DEFAULT_ELEVENLABS_VOICE_ID,
      description:
        'ElevenLabs voice id. Pick a voice persona to keep the same narrator across every video of the channel.'
    },
    {
      key: 'stability',
      label: 'Delivery',
      type: 'select',
      defaultValue: 'natural',
      options: [
        { value: 'creative', label: 'Creative (expressive)' },
        { value: 'natural', label: 'Natural (balanced)' },
        { value: 'robust', label: 'Robust (consistent)' }
      ],
      description:
        'Eleven v3 stability bracket: creative follows the audio tags hardest, robust stays closest to the base voice.'
    },
    {
      key: 'languageCode',
      label: 'Language (optional)',
      type: 'text',
      defaultValue: '',
      description: 'ISO 639-1 code ("fr", "en"…). Leave empty to auto-detect from the text.'
    }
  ],
  // Pure generator: no media inputs. The audio output joins the timeline's
  // speech lane and can feed a Seedance node's reference_audio_urls.
  inputs: [],
  outputs: [{ key: 'output', label: 'Speech', kind: 'audio' }],
  promptingNotes:
    'Write the text exactly as it should be spoken — the transcript stored on the generation is the spoken text with timestamps.\n' +
    'Eleven v3 audio tags (in brackets, sparingly): [whispers], [laughs], [sighs], [excited], [curious], [sarcastic].\n' +
    'Punctuation is the pacing instrument: ellipses… slow down, CAPITALIZATION emphasizes, short sentences punch.\n' +
    'Keep one node per narration block so each clip of the film gets its own timed voice-over.',
  promptGuide: `ELEVEN V3 DELIVERY:
  - Audio tags steer emotion and non-verbal sounds: [laughs], [whispers], [sighs], [exhales],
    [excited], [curious], [mischievously]. Place the tag RIGHT BEFORE the text it colors.
    2-3 tags per paragraph max — over-tagging degrades the read.
  - Pacing: punctuation is the instrument. Ellipses… create pauses; CAPS emphasize a word;
    short sentences read punchy, long flowing sentences read calm.
  - stability picks the bracket: creative = maximum expressiveness (tags hit hardest, most
    variation between takes), natural = balanced default, robust = most consistent takes
    (tags are damped) — use robust for a channel narrator that must sound identical per video.
  - The voice matters more than the text: a whispery voice won't shout. Pick (or clone) a
    voice whose base delivery matches the register, then nudge with tags.

TRANSCRIPT:
  The generation stores what was spoken with per-sentence timestamps ([m:ss]) — reuse it for
  subtitles, matching visuals to the narration beats, or the YouTube description.

PITFALLS:
  - Numbers/abbreviations are auto-normalized ("Dr." → "Doctor") — spell out anything ambiguous.
  - Don't paste stage directions as prose ("she says softly") — they get READ. Use [softly].
  - One language per node: mixing languages confuses auto-detection, set languageCode instead.`,
  buildPayload: ({ params }) => ({
    kind: 'tts',
    voice_id: params.voiceId.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
    text: params.prompt,
    model_id: 'eleven_v3',
    stability: SPEECH_STABILITY_VALUES[params.stability],
    ...(params.languageCode.trim() ? { language_code: params.languageCode.trim() } : {})
  })
}
