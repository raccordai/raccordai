/**
 * Speech (ElevenLabs) — the pure half. Everything decision-shaped lives here,
 * tested and in coverage: the dialogue script syntax, the voice map, and the
 * timed transcript derived from ElevenLabs' character-level alignment. The
 * main-process client (services/elevenlabs.ts) stays a thin fetch shell.
 */

export interface DialogueCue {
  /** Speaker name as written in the script (e.g. "Léa"). */
  speaker: string
  text: string
}

export interface SpeechAlignment {
  characters: string[]
  startTimes: number[]
  endTimes: number[]
}

export interface SpeechTranscriptSegment {
  /** Seconds from the start of the audio; null when the alignment could not locate the text. */
  start: number | null
  end: number | null
  text: string
  /** Present on dialogue segments only. */
  speaker?: string
}

/** Stored on generations.transcript — the exploitable form of what was spoken. */
export interface SpeechTranscript {
  text: string
  segments: SpeechTranscriptSegment[]
}

/**
 * eleven_v3 exposes stability as three creative brackets, not a continuum —
 * the model registry publishes these names and the payload maps them back.
 */
export const SPEECH_STABILITY_VALUES = {
  creative: 0.0,
  natural: 0.5,
  robust: 1.0
} as const

export type SpeechStability = keyof typeof SPEECH_STABILITY_VALUES

/**
 * Dialogue script syntax: one cue per `Name: text` line; a line without a
 * `Name:` prefix continues the previous cue (multi-line text). Speaker names
 * are limited to 40 chars so a colon inside prose never starts a bogus cue.
 */
export function parseDialogueScript(script: string): DialogueCue[] {
  const cues: DialogueCue[] = []
  for (const rawLine of script.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^([^:\n]{1,40}):\s*(.*)$/.exec(line)
    const speaker = match?.[1]?.trim()
    const text = match?.[2]?.trim()
    const last = cues[cues.length - 1]
    if (speaker && text) {
      cues.push({ speaker, text })
    } else if (last) {
      last.text = `${last.text} ${line}`.trim()
    }
    // A continuation line before any cue has no speaker — dropped on purpose.
  }
  return cues
}

/**
 * Voice map syntax: one `Name = voice_id` line per speaker (`:` also accepted).
 * Keys are matched case- and accent-insensitively against script speakers.
 */
export function parseVoiceMap(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^([^=:\n]{1,40})[=:]\s*(\S+)\s*$/.exec(line)
    if (match?.[1] && match[2]) map[normalizeSpeaker(match[1])] = match[2]
  }
  return map
}

function normalizeSpeaker(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export interface DialogueInput {
  text: string
  voice_id: string
  /** Not part of the ElevenLabs payload — kept for the transcript's speaker labels. */
  speaker: string
}

/**
 * Resolves a script against a voice map into the ElevenLabs `inputs` array.
 * Throws with every missing speaker named — the error is the user's checklist.
 */
export function buildDialogueInputs(script: string, voiceMap: string): DialogueInput[] {
  const cues = parseDialogueScript(script)
  if (cues.length === 0) {
    throw new Error('The dialogue script is empty — write one "Name: line" per cue.')
  }
  const voices = parseVoiceMap(voiceMap)
  const missing = [
    ...new Set(cues.map((c) => c.speaker).filter((s) => !voices[normalizeSpeaker(s)]))
  ]
  if (missing.length > 0) {
    throw new Error(
      `No voice mapped for: ${missing.join(', ')}. Add one "Name = voice_id" line per speaker in the voices field.`
    )
  }
  return cues.map((c) => ({
    text: c.text,
    voice_id: voices[normalizeSpeaker(c.speaker)] ?? '',
    speaker: c.speaker
  }))
}

/**
 * Locates each text chunk inside the character-level alignment and stamps its
 * start/end seconds. Chunks are matched in order with a moving cursor, so a
 * sentence repeated twice resolves to its own occurrence. A chunk the
 * alignment cannot locate (normalization rewrote it) keeps null times — the
 * transcript text is still complete.
 */
export function transcriptFromAlignment(
  chunks: Array<{ text: string; speaker?: string }>,
  alignment: SpeechAlignment | null
): SpeechTranscript {
  const fullText = chunks
    .map((c) => (c.speaker ? `${c.speaker}: ${c.text}` : c.text))
    .join('\n')
    .trim()
  const joined = alignment ? alignment.characters.join('') : ''
  let cursor = 0
  const segments: SpeechTranscriptSegment[] = chunks.map((chunk) => {
    const needle = chunk.text.trim()
    const idx = needle === '' || !alignment ? -1 : joined.indexOf(needle, cursor)
    if (idx === -1 || !alignment) {
      return {
        start: null,
        end: null,
        text: chunk.text,
        ...(chunk.speaker ? { speaker: chunk.speaker } : {})
      }
    }
    cursor = idx + needle.length
    return {
      start: alignment.startTimes[idx] ?? null,
      end: alignment.endTimes[idx + needle.length - 1] ?? null,
      text: chunk.text,
      ...(chunk.speaker ? { speaker: chunk.speaker } : {})
    }
  })
  return { text: fullText, segments }
}

/** Sentence-level chunks for a single-voice text (the TTS transcript grain). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** `[m:ss] Speaker: text` lines — same timestamp shape as the niche transcripts. */
export function formatTranscript(transcript: SpeechTranscript): string {
  return transcript.segments
    .map((seg) => {
      const stamp = seg.start === null ? '' : `[${formatTimestamp(seg.start)}] `
      const speaker = seg.speaker ? `${seg.speaker}: ` : ''
      return `${stamp}${speaker}${seg.text}`
    })
    .join('\n')
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
