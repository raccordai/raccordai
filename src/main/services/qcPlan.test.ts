import { describe, expect, it } from 'vitest'
import { buildQcUserText, isQcEligible, parseQcVerdict } from './qcPlan'

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
