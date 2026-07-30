import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger, describeCause, formatLogLine } from './logger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raccord-log-'))
})

describe('formatLogLine', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')

  it('renders timestamp, level, scope and message', () => {
    expect(formatLogLine(now, 'info', 'chat', 'turn started')).toBe(
      '2026-07-30T12:00:00.000Z [info] [chat] turn started'
    )
  })

  it('appends the cause and indents multi-line stacks', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n  at somewhere'
    const line = formatLogLine(now, 'error', 'engine', 'poll failed', err)
    expect(line).toContain('[error] [engine] poll failed — Error: boom')
    expect(line).toContain('\n    ')
    expect(line).not.toMatch(/\n(?! {4})/)
  })

  it('stringifies non-Error causes', () => {
    expect(describeCause('raw string')).toBe('raw string')
    expect(describeCause(42)).toBe('42')
  })
})

describe('createLogger', () => {
  it('appends one line per call to main.log', () => {
    const logger = createLogger({ dir })
    logger.info('scope', 'first')
    logger.error('scope', 'second', new Error('cause'))
    const content = readFileSync(logger.filePath, 'utf8')
    const lines = content.trimEnd().split('\n')
    expect(lines[0]).toContain('[info] [scope] first')
    expect(lines[1]).toContain('[error] [scope] second — Error: cause')
  })

  it('rotates to main.log.1 past maxBytes and starts a fresh file', () => {
    const logger = createLogger({ dir, maxBytes: 100 })
    for (let i = 0; i < 10; i++) logger.info('rot', `line ${i} ${'x'.repeat(40)}`)
    expect(existsSync(`${logger.filePath}.1`)).toBe(true)
    // The live file stays under one rotation's worth of content.
    expect(readFileSync(logger.filePath, 'utf8').length).toBeLessThan(300)
  })
})
