import { describe, expect, it } from 'vitest'
import type { LintFinding } from '@shared/promptLint'
import {
  buildClipQcUserText,
  imageReferenceUrls,
  isClipQcEligible,
  buildQcUserText,
  foldLintIntoVerdict,
  isQcEligible,
  parseQcVerdict
} from './qcPlan'

describe('isQcEligible', () => {
  it('accepts only image models', () => {
    expect(isQcEligible('image')).toBe(true)
    expect(isQcEligible('video')).toBe(false)
    expect(isQcEligible('audio')).toBe(false)
    expect(isQcEligible(undefined)).toBe(false)
  })
})

describe('buildQcUserText', () => {
  it('describes the block layout when references are attached', () => {
    const text = buildQcUserText({
      prompt: 'a knight in the rain',
      referenceCount: 2,
      isStoryboard: false
    })
    expect(text).toContain('2 following image(s)')
    expect(text).toContain('a knight in the rain')
    expect(text).not.toContain('storyboard')
  })

  it('adds the storyboard checks and the design subject when relevant', () => {
    const text = buildQcUserText({
      prompt: 'storyboard of the chase',
      referenceCount: 0,
      isStoryboard: true,
      designSubject: 'Mira, 12, red scarf'
    })
    expect(text).toContain('The image above is the generated output.')
    expect(text).toContain('9-panel storyboard')
    expect(text).toContain('Mira, 12, red scarf')
  })

  it('handles an empty prompt', () => {
    expect(buildQcUserText({ prompt: '', referenceCount: 0, isStoryboard: false })).toContain(
      '(empty prompt)'
    )
  })
})

describe('parseQcVerdict', () => {
  it('parses a bare JSON verdict', () => {
    expect(parseQcVerdict('{"verdict":"pass","notes":""}')).toEqual({ verdict: 'pass', notes: '' })
  })

  it('parses a verdict wrapped in prose or a markdown fence', () => {
    expect(
      parseQcVerdict(
        'Here is my review:\n```json\n{"verdict":"warn","notes":"6 fingers on the left hand"}\n```'
      )
    ).toEqual({ verdict: 'warn', notes: '6 fingers on the left hand' })
  })

  it('defaults missing notes to an empty string and trims them', () => {
    expect(parseQcVerdict('{"verdict":"pass"}')).toEqual({ verdict: 'pass', notes: '' })
    expect(parseQcVerdict('{"verdict":"warn","notes":"  x  "}').notes).toBe('x')
  })

  it('throws on missing JSON, malformed JSON and unknown verdicts', () => {
    expect(() => parseQcVerdict('looks good to me')).toThrow(/no JSON verdict/)
    expect(() => parseQcVerdict('{"verdict":')).toThrow(/no JSON verdict|malformed/)
    expect(() => parseQcVerdict('{"verdict":"maybe"}')).toThrow(/unknown verdict/)
  })
})

describe('foldLintIntoVerdict', () => {
  const warning: LintFinding = {
    rule: 'video-prompt-without-motion',
    severity: 'warning',
    message: 'No motion described.'
  }
  const error: LintFinding = {
    rule: 'param-out-of-enum',
    severity: 'error',
    message: '"Resolution" is set to "4k", which this model does not accept.'
  }

  it('leaves the verdict untouched when the lint is clean', () => {
    const result = { verdict: 'pass', notes: '' } as const
    expect(foldLintIntoVerdict(result, [])).toBe(result)
  })

  it('keeps a pass on non-blocking findings only', () => {
    const result = { verdict: 'pass', notes: '' } as const
    expect(foldLintIntoVerdict(result, [warning])).toEqual(result)
  })

  it('degrades a pass to warn on a blocking finding and reports it', () => {
    const folded = foldLintIntoVerdict({ verdict: 'pass', notes: '' }, [error])
    expect(folded.verdict).toBe('warn')
    expect(folded.notes).toContain('Prompt lint:')
    expect(folded.notes).toContain('does not accept')
  })

  it('appends the lint under the existing notes of a warn', () => {
    const folded = foldLintIntoVerdict(
      { verdict: 'warn', notes: 'Her left hand has six fingers.' },
      [warning]
    )
    expect(folded.verdict).toBe('warn')
    expect(folded.notes.startsWith('Her left hand has six fingers.')).toBe(true)
    expect(folded.notes).toContain('⚠ No motion described.')
  })
})

describe('clip QC helpers', () => {
  it('is eligible for video models only', () => {
    expect(isClipQcEligible('video')).toBe(true)
    expect(isClipQcEligible('image')).toBe(false)
    expect(isClipQcEligible('audio')).toBe(false)
    expect(isClipQcEligible(undefined)).toBe(false)
  })

  it('builds the clip user text with frame count, duration and references', () => {
    const text = buildClipQcUserText({
      prompt: 'A tracking shot of Léa',
      frameCount: 3,
      referenceCount: 2,
      durationSec: 8.04
    })
    expect(text).toContain('3 images above are frames sampled in playback order of a 8.0s clip')
    expect(text).toContain('2 following image(s) are the reference sheets')
    expect(text).toContain('A tracking shot of Léa')
  })

  it('omits the reference line without references and survives an empty prompt', () => {
    const text = buildClipQcUserText({ prompt: '', frameCount: 3, referenceCount: 0 })
    expect(text).not.toContain('reference sheets')
    expect(text).toContain('(empty prompt)')
  })
})

describe('imageReferenceUrls', () => {
  const model = {
    inputs: [
      { key: 'reference_image_urls', accepts: ['image'] as const },
      { key: 'reference_video_urls', accepts: ['video'] as const },
      { key: 'first_frame_url', accepts: ['image'] as const }
    ]
  }

  it('keeps only urls wired to image-accepting handles, in handle order', () => {
    const urls = imageReferenceUrls(
      {
        reference_video_urls: ['https://kie/video.mp4'],
        first_frame_url: ['https://kie/frame.png'],
        reference_image_urls: ['https://kie/sheet1.png', 'https://kie/sheet2.png']
      },
      model
    )
    expect(urls).toEqual([
      'https://kie/sheet1.png',
      'https://kie/sheet2.png',
      'https://kie/frame.png'
    ])
  })

  it('returns nothing without inputs or model, and skips unknown handles', () => {
    expect(imageReferenceUrls(undefined, model)).toEqual([])
    expect(imageReferenceUrls({ x: ['u'] }, undefined)).toEqual([])
    expect(imageReferenceUrls({ mystery_handle: ['u'] }, model)).toEqual([])
  })
})
