import {
  transcriptFromAlignment,
  splitSentences,
  type SpeechAlignment,
  type SpeechTranscript
} from '@shared/speech'
import { getElevenLabsApiKey } from './settings'

/**
 * ElevenLabs client — thin fetch shell (out of coverage, like kie.ts). Unlike
 * kie.ai's job queue, generation is SYNCHRONOUS: one POST returns the audio
 * (base64) plus a character-level alignment. The run engine therefore treats
 * an ElevenLabs "task" as already settled — see the elevenlabs branches in
 * runEngine.ts. RACCORD_ELEVENLABS_BASE overrides the host for the E2E mock.
 */

export const ELEVENLABS_BASE = process.env['RACCORD_ELEVENLABS_BASE'] ?? 'https://api.elevenlabs.io'

/** Every request asks for plain mp3 — the rest of the media pipeline expects it. */
const OUTPUT_FORMAT = 'mp3_44100_128'

function getApiKey(): string {
  const key = getElevenLabsApiKey()
  if (!key) {
    throw new Error('ElevenLabs API key is not configured. Add it in Settings → Integrations.')
  }
  return key
}

interface RawAlignment {
  characters?: string[]
  character_start_times_seconds?: number[]
  character_end_times_seconds?: number[]
}

interface SpeechResponse {
  audio_base64?: string
  alignment?: RawAlignment | null
  normalized_alignment?: RawAlignment | null
  detail?: unknown
}

function toAlignment(raw: RawAlignment | null | undefined): SpeechAlignment | null {
  if (!raw?.characters || !raw.character_start_times_seconds || !raw.character_end_times_seconds) {
    return null
  }
  return {
    characters: raw.characters,
    startTimes: raw.character_start_times_seconds,
    endTimes: raw.character_end_times_seconds
  }
}

export interface SpeechResult {
  audio: Buffer
  mimeType: string
  transcript: SpeechTranscript
}

async function postSpeech(path: string, body: Record<string, unknown>): Promise<SpeechResponse> {
  const res = await fetch(`${ELEVENLABS_BASE}${path}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': getApiKey() },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  let json: SpeechResponse
  try {
    json = JSON.parse(raw) as SpeechResponse
  } catch {
    throw new Error(`ElevenLabs returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`)
  }
  if (!res.ok || !json.audio_base64) {
    // Keep the HTTP status in the message: genQueue's retry classifier reads
    // it to tell permanent (4xx) from transient failures.
    const detail =
      typeof json.detail === 'string'
        ? json.detail
        : JSON.stringify(json.detail ?? raw.slice(0, 300))
    throw new Error(`ElevenLabs request failed (HTTP ${res.status}): ${detail}`)
  }
  return json
}

/**
 * The payload contract with the model files (buildPayload output, replayed
 * verbatim from input snapshots on retry): `kind` discriminates the endpoint,
 * everything else mirrors the ElevenLabs body it becomes.
 */
export async function elevenlabsGenerateAudio(
  payload: Record<string, unknown>
): Promise<SpeechResult> {
  if (payload['kind'] === 'dialogue') return generateDialogue(payload)
  return generateTts(payload)
}

async function generateTts(payload: Record<string, unknown>): Promise<SpeechResult> {
  const voiceId = String(payload['voice_id'] ?? '').trim()
  const text = String(payload['text'] ?? '').trim()
  if (!voiceId) throw new Error('ElevenLabs run is missing a voice id (400).')
  if (!text) throw new Error('ElevenLabs run has an empty text (400).')

  const json = await postSpeech(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps`,
    {
      text,
      model_id: String(payload['model_id'] ?? 'eleven_v3'),
      ...(payload['language_code'] ? { language_code: payload['language_code'] } : {}),
      ...(payload['stability'] !== undefined
        ? { voice_settings: { stability: Number(payload['stability']) } }
        : {})
    }
  )
  const alignment = toAlignment(json.alignment ?? json.normalized_alignment)
  return {
    audio: Buffer.from(String(json.audio_base64), 'base64'),
    mimeType: 'audio/mpeg',
    transcript: transcriptFromAlignment(
      splitSentences(text).map((sentence) => ({ text: sentence })),
      alignment
    )
  }
}

async function generateDialogue(payload: Record<string, unknown>): Promise<SpeechResult> {
  const inputs = Array.isArray(payload['inputs'])
    ? (payload['inputs'] as Array<{ text?: unknown; voice_id?: unknown; speaker?: unknown }>)
    : []
  if (inputs.length === 0) throw new Error('ElevenLabs dialogue has no cues (400).')

  const json = await postSpeech('/v1/text-to-dialogue/with-timestamps', {
    // `speaker` is transcript-only metadata — never sent to the API.
    inputs: inputs.map((cue) => ({
      text: String(cue.text ?? ''),
      voice_id: String(cue.voice_id ?? '')
    })),
    model_id: String(payload['model_id'] ?? 'eleven_v3'),
    ...(payload['language_code'] ? { language_code: payload['language_code'] } : {}),
    ...(payload['stability'] !== undefined
      ? { settings: { stability: Number(payload['stability']) } }
      : {})
  })
  const alignment = toAlignment(json.alignment ?? json.normalized_alignment)
  return {
    audio: Buffer.from(String(json.audio_base64), 'base64'),
    mimeType: 'audio/mpeg',
    transcript: transcriptFromAlignment(
      inputs.map((cue) => ({
        text: String(cue.text ?? ''),
        speaker: String(cue.speaker ?? '') || undefined
      })),
      alignment
    )
  }
}

// ── Voices (picker + custom-id validation) ───────────────────────────────────

export interface ElevenLabsVoice {
  voiceId: string
  name: string
  category: string | null
  previewUrl: string | null
  labels: Record<string, string>
}

interface VoicesResponse {
  voices?: Array<{
    voice_id?: string
    name?: string
    category?: string | null
    preview_url?: string | null
    labels?: Record<string, string> | null
  }>
  has_more?: boolean
  detail?: unknown
}

/** Searches the account's voice library (personal + premade). */
export async function elevenlabsListVoices(args: {
  search?: string
  pageSize?: number
}): Promise<{ voices: ElevenLabsVoice[]; hasMore: boolean }> {
  const params = new URLSearchParams()
  params.set('page_size', String(args.pageSize ?? 30))
  if (args.search) params.set('search', args.search)
  const res = await fetch(`${ELEVENLABS_BASE}/v2/voices?${params}`, {
    headers: { 'xi-api-key': getApiKey() }
  })
  const raw = await res.text()
  let json: VoicesResponse
  try {
    json = JSON.parse(raw) as VoicesResponse
  } catch {
    throw new Error(
      `ElevenLabs voices returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 300)}`
    )
  }
  if (!res.ok) {
    const detail = typeof json.detail === 'string' ? json.detail : raw.slice(0, 300)
    throw new Error(`ElevenLabs voices failed (HTTP ${res.status}): ${detail}`)
  }
  return {
    voices: (json.voices ?? [])
      .filter((v) => v.voice_id && v.name)
      .map((v) => ({
        voiceId: String(v.voice_id),
        name: String(v.name),
        category: v.category ?? null,
        previewUrl: v.preview_url ?? null,
        labels: v.labels ?? {}
      })),
    hasMore: json.has_more === true
  }
}
