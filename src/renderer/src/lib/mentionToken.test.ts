import { describe, expect, it } from 'vitest'
import { applyMention, detectMentionToken, normalizeMentionQuery } from './mentionToken'

const TRIGGERS = [{ char: '/', startOnly: true }, { char: '@' }]

describe('detectMentionToken', () => {
  it('detects a slash token at the start of the value', () => {
    expect(detectMentionToken('/run', 4, TRIGGERS)).toEqual({ char: '/', start: 0, query: 'run' })
  })

  it('ignores a slash that is not the first character', () => {
    expect(detectMentionToken('a /run', 6, TRIGGERS)).toBeNull()
    expect(detectMentionToken('16/9', 4, TRIGGERS)).toBeNull()
  })

  it('detects an @ token at the start and mid-text after whitespace', () => {
    expect(detectMentionToken('@Nova', 5, TRIGGERS)).toEqual({ char: '@', start: 0, query: 'Nova' })
    expect(detectMentionToken('use @No', 7, TRIGGERS)).toEqual({ char: '@', start: 4, query: 'No' })
  })

  it('allows spaces in the query (names contain them)', () => {
    expect(detectMentionToken('@Nova Rift', 10, TRIGGERS)).toEqual({
      char: '@',
      start: 0,
      query: 'Nova Rift'
    })
  })

  it('does not fire on emails or mid-word @', () => {
    expect(detectMentionToken('mail@example', 12, TRIGGERS)).toBeNull()
  })

  it('stops at newlines', () => {
    expect(detectMentionToken('@Nova\nrift', 10, TRIGGERS)).toBeNull()
  })

  it('gives up on long queries (user is writing prose)', () => {
    const value = `@${'x'.repeat(41)}`
    expect(detectMentionToken(value, value.length, TRIGGERS)).toBeNull()
  })

  it('only considers text before the caret', () => {
    expect(detectMentionToken('@Nova', 1, TRIGGERS)).toEqual({ char: '@', start: 0, query: '' })
    expect(detectMentionToken('hello @world', 5, TRIGGERS)).toBeNull()
  })
})

describe('applyMention', () => {
  it('replaces the token with the insert plus a trailing space', () => {
    const token = { char: '@', start: 4, query: 'No' }
    expect(applyMention('use @No now', token, 7, '@Nova Rift')).toEqual({
      value: 'use @Nova Rift  now',
      caret: 15
    })
  })

  it('keeps an existing trailing space on the insert', () => {
    const token = { char: '/', start: 0, query: 'ru' }
    expect(applyMention('/ru', token, 3, '/run_batch ')).toEqual({
      value: '/run_batch ',
      caret: 11
    })
  })
})

describe('normalizeMentionQuery', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeMentionQuery('RéFérence')).toBe('reference')
  })
})
