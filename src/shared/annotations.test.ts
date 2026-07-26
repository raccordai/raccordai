import { describe, expect, it } from 'vitest'
import {
  buildAssistantRequest,
  buildEditPrompt,
  describeAnnotation,
  describeRegion,
  formatTimecode,
  isDegenerateRegion,
  normalizeRegion,
  type Annotation
} from './annotations'

const note = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: 'a1',
  region: null,
  timecodeSec: null,
  comment: 'the hand is deformed',
  ...overrides
})

describe('normalizeRegion', () => {
  it('flips a rectangle dragged up-left and clamps it to the frame', () => {
    expect(normalizeRegion({ x: 0.8, y: 0.6, w: -0.3, h: -0.2 })).toEqual({
      x: expect.closeTo(0.5, 6),
      y: expect.closeTo(0.4, 6),
      w: expect.closeTo(0.3, 6),
      h: expect.closeTo(0.2, 6)
    })
    expect(normalizeRegion({ x: -0.5, y: -0.5, w: 2, h: 2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('rejects a mis-click as degenerate', () => {
    expect(isDegenerateRegion({ x: 0.5, y: 0.5, w: 0.005, h: 0.4 })).toBe(true)
    expect(isDegenerateRegion({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(false)
  })
})

describe('describeRegion', () => {
  it('names the corner areas', () => {
    expect(describeRegion({ x: 0.02, y: 0.02, w: 0.2, h: 0.2 })).toBe(
      'the upper-left area of the frame'
    )
    expect(describeRegion({ x: 0.75, y: 0.75, w: 0.2, h: 0.2 })).toBe(
      'the lower-right area of the frame'
    )
  })

  it('names the center and the bands', () => {
    expect(describeRegion({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('the center of the frame')
    expect(describeRegion({ x: 0, y: 0.7, w: 1, h: 0.3 })).toBe('the lower third of the frame')
    expect(describeRegion({ x: 0.75, y: 0, w: 0.25, h: 1 })).toBe('the right side of the frame')
  })

  it('collapses a near-full box to the whole frame', () => {
    expect(describeRegion({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 })).toBe('the whole frame')
  })
})

describe('formatTimecode', () => {
  it('renders minutes and padded seconds', () => {
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(4.6)).toBe('0:05')
    expect(formatTimecode(93)).toBe('1:33')
    expect(formatTimecode(-3)).toBe('0:00')
  })
})

describe('describeAnnotation', () => {
  it('prefixes with the region, the timecode, or nothing', () => {
    expect(describeAnnotation(note({ region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } }))).toBe(
      'In the center of the frame: the hand is deformed'
    )
    expect(describeAnnotation(note({ timecodeSec: 12 }))).toBe('At 0:12: the hand is deformed')
    expect(describeAnnotation(note())).toBe('the hand is deformed')
  })
})

describe('buildEditPrompt', () => {
  it('returns an empty prompt when there is nothing to say', () => {
    expect(buildEditPrompt([], 'image')).toBe('')
    expect(buildEditPrompt([note({ comment: '   ' })], 'image')).toBe('')
  })

  it('adds the "change nothing else" clause on images', () => {
    const prompt = buildEditPrompt(
      [note({ region: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 } })],
      'image'
    )
    expect(prompt).toContain('In the upper-left area of the frame: the hand is deformed')
    expect(prompt).toContain('change nothing else')
  })

  it('bullets several notes and frames video notes as a regeneration', () => {
    const prompt = buildEditPrompt(
      [note({ timecodeSec: 2 }), note({ id: 'a2', comment: 'remove the logo' })],
      'video'
    )
    expect(prompt.startsWith('Regenerate this shot')).toBe(true)
    expect(prompt).toContain('- At 0:02: the hand is deformed')
    expect(prompt).toContain('- remove the logo')
    expect(prompt).not.toContain('change nothing else')
  })
})

describe('buildAssistantRequest', () => {
  it('names the node and asks for the cost before running', () => {
    const text = buildAssistantRequest('Shot 02', [note({ timecodeSec: 5 })], 'video')
    expect(text).toContain('On the "Shot 02" shot')
    expect(text).toContain('- At 0:05: the hand is deformed')
    expect(text).toContain('cost')
  })
})
