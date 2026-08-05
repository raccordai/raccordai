import { describe, expect, it } from 'vitest'
import {
  buildDialogueInputs,
  formatTranscript,
  parseDialogueScript,
  parseVoiceMap,
  splitSentences,
  transcriptFromAlignment,
  SPEECH_STABILITY_VALUES,
  type SpeechAlignment
} from './speech'

function alignmentOf(text: string, secondsPerChar = 0.1): SpeechAlignment {
  const characters = [...text]
  return {
    characters,
    startTimes: characters.map((_, i) => i * secondsPerChar),
    endTimes: characters.map((_, i) => (i + 1) * secondsPerChar)
  }
}

describe('parseDialogueScript', () => {
  it('parses one cue per "Name: text" line', () => {
    const cues = parseDialogueScript('Léa: Bonjour !\nMarc: Salut.')
    expect(cues).toEqual([
      { speaker: 'Léa', text: 'Bonjour !' },
      { speaker: 'Marc', text: 'Salut.' }
    ])
  })

  it('folds unprefixed lines into the previous cue', () => {
    const cues = parseDialogueScript('Léa: Regarde les chiffres.\nIls sont formels.')
    expect(cues).toEqual([{ speaker: 'Léa', text: 'Regarde les chiffres. Ils sont formels.' }])
  })

  it('drops continuation lines before any cue and blank lines', () => {
    expect(parseDialogueScript('du texte sans locuteur\n\nLéa: Bonjour')).toEqual([
      { speaker: 'Léa', text: 'Bonjour' }
    ])
  })

  it('does not treat a long prose colon as a speaker (40-char cap)', () => {
    const prose = `${'a'.repeat(45)}: rest`
    expect(parseDialogueScript(prose)).toEqual([])
  })
})

describe('parseVoiceMap', () => {
  it('accepts "=" and ":" separators and normalizes keys', () => {
    const map = parseVoiceMap('Léa = voice-a\nMARC: voice-b')
    expect(map['lea']).toBe('voice-a')
    expect(map['marc']).toBe('voice-b')
  })

  it('ignores malformed lines', () => {
    expect(parseVoiceMap('no separator here\n= orphan')).toEqual({})
  })
})

describe('buildDialogueInputs', () => {
  it('resolves speakers case- and accent-insensitively', () => {
    const inputs = buildDialogueInputs('LÉA: Bonjour !', 'lea = voice-a')
    expect(inputs).toEqual([{ text: 'Bonjour !', voice_id: 'voice-a', speaker: 'LÉA' }])
  })

  it('names every missing speaker in the error', () => {
    expect(() => buildDialogueInputs('Léa: Hi\nMarc: Yo', 'Léa = voice-a')).toThrow(/Marc/)
  })

  it('throws on an empty script', () => {
    expect(() => buildDialogueInputs('', 'Léa = voice-a')).toThrow(/empty/)
  })
})

describe('transcriptFromAlignment', () => {
  it('stamps each chunk with its start/end from the alignment', () => {
    const text = 'Hello world. Second one.'
    const transcript = transcriptFromAlignment(
      splitSentences(text).map((s) => ({ text: s })),
      alignmentOf(text)
    )
    expect(transcript.segments).toHaveLength(2)
    expect(transcript.segments[0]).toMatchObject({ start: 0, text: 'Hello world.' })
    // 'Second one.' starts at index 13 → 1.3 s.
    expect(transcript.segments[1]?.start).toBeCloseTo(1.3)
    expect(transcript.segments[1]?.end).toBeCloseTo(2.4)
  })

  it('matches repeated sentences to their own occurrence (moving cursor)', () => {
    const text = 'Encore. Encore.'
    const transcript = transcriptFromAlignment(
      [{ text: 'Encore.' }, { text: 'Encore.' }],
      alignmentOf(text)
    )
    expect(transcript.segments[0]?.start).toBeCloseTo(0)
    expect(transcript.segments[1]?.start).toBeCloseTo(0.8)
  })

  it('keeps the text with null times when the alignment cannot locate it', () => {
    const transcript = transcriptFromAlignment([{ text: 'absent' }], alignmentOf('different'))
    expect(transcript.segments[0]).toEqual({ start: null, end: null, text: 'absent' })
  })

  it('labels dialogue segments with their speaker and builds the full text', () => {
    const transcript = transcriptFromAlignment(
      [{ text: 'Hi.', speaker: 'Léa' }],
      alignmentOf('Hi.')
    )
    expect(transcript.text).toBe('Léa: Hi.')
    expect(transcript.segments[0]?.speaker).toBe('Léa')
  })

  it('survives a null alignment (transcript without timings)', () => {
    const transcript = transcriptFromAlignment([{ text: 'Hello.' }], null)
    expect(transcript.segments[0]?.start).toBeNull()
    expect(transcript.text).toBe('Hello.')
  })
})

describe('formatTranscript', () => {
  it('renders [m:ss] stamps and speaker labels, omitting unknown times', () => {
    const formatted = formatTranscript({
      text: 'x',
      segments: [
        { start: 0, end: 2, text: 'Intro.' },
        { start: 65.4, end: 70, text: 'Bonjour !', speaker: 'Léa' },
        { start: null, end: null, text: 'Sans timing.' }
      ]
    })
    expect(formatted).toBe('[0:00] Intro.\n[1:05] Léa: Bonjour !\nSans timing.')
  })
})

describe('SPEECH_STABILITY_VALUES', () => {
  it('exposes the three eleven_v3 brackets', () => {
    expect(SPEECH_STABILITY_VALUES).toEqual({ creative: 0.0, natural: 0.5, robust: 1.0 })
  })
})
