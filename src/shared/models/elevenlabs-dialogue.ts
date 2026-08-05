import { z } from 'zod'
import {
  buildDialogueInputs,
  parseDialogueScript,
  parseVoiceMap,
  SPEECH_STABILITY_VALUES
} from '../speech'
import { DEFAULT_ELEVENLABS_VOICE_ID } from './elevenlabs-tts'
import type { ModelDefinition } from './types'

const paramsSchema = z.object({
  prompt: z.string().max(5000).default(''),
  voiceMap: z.string().max(2000).default(''),
  stability: z.enum(['creative', 'natural', 'robust']).default('natural'),
  languageCode: z.string().max(10).default('')
})

type Params = z.infer<typeof paramsSchema>

export const elevenlabsDialogue: ModelDefinition<Params> = {
  id: 'elevenlabs/text-to-dialogue',
  label: 'ElevenLabs — Dialogue',
  description:
    'Multi-voice conversation with Eleven v3: one "Name: line" per cue, each speaker mapped to ' +
    'their own voice (up to 10), rendered as a single audio with a per-speaker timed transcript.',
  kind: 'audio',
  audioRole: 'speech',
  provider: 'elevenlabs',
  recommendedFor: ['dialogue', 'multi-voice', 'podcast', 'youtube'],
  paramsSchema,
  paramFields: [
    {
      key: 'prompt',
      label: 'Script',
      type: 'textarea',
      defaultValue: '',
      description:
        'One cue per line: "Léa: Bonjour !". A line without a "Name:" prefix continues the previous cue. Audio tags work per cue: "Léa: [laughs] Sérieusement ?"'
    },
    {
      key: 'voiceMap',
      label: 'Voices',
      type: 'textarea',
      defaultValue: '',
      description:
        'One "Name = voice_id" line per speaker. Use your voice personas to keep each character\'s voice consistent across every video.'
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
      ]
    },
    {
      key: 'languageCode',
      label: 'Language (optional)',
      type: 'text',
      defaultValue: '',
      description: 'ISO 639-1 code ("fr", "en"…). Leave empty to auto-detect.'
    }
  ],
  inputs: [],
  outputs: [{ key: 'output', label: 'Dialogue', kind: 'audio' }],
  promptingNotes:
    'Script syntax: one "Name: line" per cue; unprefixed lines continue the previous cue.\n' +
    'Voices: one "Name = voice_id" line per speaker (max 10 voices, ≤2000 chars total) — resolve names from the voice personas so characters keep their voice across videos.\n' +
    'Audio tags color a single cue: "Léa: [whispers] Il est là." Reactions get their own cue: "Marc: [laughs]".\n' +
    'The stored transcript keeps speaker labels and timestamps — reuse it for subtitles or shot timing.\n' +
    'A script with no "Name:" prefix at all falls back to a single narrator voice (first mapped voice).',
  promptGuide: `DIALOGUE SCRIPT:
  Léa: [excited] On a réussi !
  Marc: Attends… tu es sûre ?
  Léa: Regarde les chiffres.
       Ils sont formels.        ← continuation of Léa's cue (no "Name:" prefix)

VOICES FIELD:
  Léa = <voice_id_A>
  Marc = <voice_id_B>
  Names match case- and accent-insensitively ("léa" = "Léa"). Every speaker in the script MUST
  be mapped or the run fails, listing the missing names. Max 10 distinct voices, ≤2000 chars
  of text per run — split long scenes into several nodes at natural beats.

DELIVERY:
  - eleven_v3 renders the exchange as ONE take: pacing, overlaps and reactions are inferred
    from the cue order — write reaction cues ("Marc: [sighs]") instead of stage directions.
  - stability: creative for played scenes, robust for an interview/podcast register.
  - Keep each cue under ~3 sentences: v3 breathes between cues, long monologues belong to the
    Text-to-Speech node.

CONSISTENT CHARACTERS ACROSS VIDEOS:
  Create one voice persona per recurring character (the channel's cast) and reuse their ids in
  every voices field — same doctrine as the visual casting: the NAME is the stable identity,
  the id is what the API consumes.`,
  buildPayload: ({ params }) => {
    const cues = parseDialogueScript(params.prompt)
    if (cues.length === 0) {
      // No "Name:" cues — forgiving single-narrator fallback (first mapped
      // voice, else the default narrator) so a plain text still runs.
      const voices = Object.values(parseVoiceMap(params.voiceMap))
      return {
        kind: 'dialogue',
        inputs: [
          {
            text: params.prompt,
            voice_id: voices[0] ?? DEFAULT_ELEVENLABS_VOICE_ID,
            speaker: ''
          }
        ],
        model_id: 'eleven_v3',
        stability: SPEECH_STABILITY_VALUES[params.stability],
        ...(params.languageCode.trim() ? { language_code: params.languageCode.trim() } : {})
      }
    }
    return {
      kind: 'dialogue',
      inputs: buildDialogueInputs(params.prompt, params.voiceMap),
      model_id: 'eleven_v3',
      stability: SPEECH_STABILITY_VALUES[params.stability],
      ...(params.languageCode.trim() ? { language_code: params.languageCode.trim() } : {})
    }
  }
}
