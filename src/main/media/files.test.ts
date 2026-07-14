import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteMediaFile, importFileToStore, mediaKindFor, mimeTypeFor } from './files'

describe('mimeTypeFor', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeTypeFor('/a/b/photo.PNG')).toBe('image/png')
    expect(mimeTypeFor('clip.mp4')).toBe('video/mp4')
    expect(mimeTypeFor('track.m4a')).toBe('audio/mp4')
  })

  it('returns null for unknown extensions', () => {
    expect(mimeTypeFor('archive.zip')).toBeNull()
    expect(mimeTypeFor('noext')).toBeNull()
  })
})

describe('mediaKindFor', () => {
  it('classifies image / video / audio', () => {
    expect(mediaKindFor('x.webp')).toBe('image')
    expect(mediaKindFor('x.mov')).toBe('video')
    expect(mediaKindFor('x.flac')).toBe('audio')
    expect(mediaKindFor('x.pdf')).toBeNull()
  })
})

describe('managed store', () => {
  it('imports a file under media/<projectId>/<ownerId>.<ext> and reports its size', () => {
    const src = join(mkdtempSync(join(tmpdir(), 'raccord-src-')), 'Source.JPG')
    writeFileSync(src, 'fake-image-bytes')

    const { filePath, size } = importFileToStore('proj1', 'owner1', src)
    expect(filePath.endsWith(join('media', 'proj1', 'owner1.jpg'))).toBe(true)
    expect(size).toBe('fake-image-bytes'.length)
    expect(existsSync(filePath)).toBe(true)
  })

  it('deleteMediaFile tolerates null and missing paths', () => {
    expect(() => deleteMediaFile(null)).not.toThrow()
    expect(() => deleteMediaFile('/does/not/exist.mp4')).not.toThrow()
  })
})
