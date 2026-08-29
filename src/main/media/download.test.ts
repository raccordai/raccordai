import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertDownloadableUrl, downloadToFile } from './download'

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end('MP4-BYTES')
    } else if (req.url === '/oversized-declared') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4096' })
      res.end(Buffer.alloc(4096))
    } else if (req.url === '/oversized-chunked') {
      // No content-length: the declared-size check can't fire, only the cap.
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.write(Buffer.alloc(2048))
      res.write(Buffer.alloc(2048))
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'raccord-dl-'))

describe('assertDownloadableUrl', () => {
  it('accepts http and https', () => {
    expect(assertDownloadableUrl('http://example.com/a').protocol).toBe('http:')
    expect(assertDownloadableUrl('https://example.com/a').protocol).toBe('https:')
  })

  it('refuses non-http(s) schemes', () => {
    expect(() => assertDownloadableUrl('file:///etc/passwd')).toThrow(/non-http/)
    expect(() => assertDownloadableUrl('ftp://example.com/a')).toThrow(/non-http/)
  })

  it('refuses malformed URLs', () => {
    expect(() => assertDownloadableUrl('not a url')).toThrow(/malformed/)
  })
})

describe('downloadToFile', () => {
  it('streams the body to the target path', async () => {
    const target = join(tmp(), 'out.mp4')
    const result = await downloadToFile(`${base}/ok.mp4`, target)
    expect(result.path).toBe(target)
    expect(result.contentType).toBe('video/mp4')
    expect(result.bytes).toBe(9)
    expect(readFileSync(target, 'utf8')).toBe('MP4-BYTES')
  })

  it('resolves the target from the Content-Type before any byte lands', async () => {
    const dir = tmp()
    const result = await downloadToFile(`${base}/ok.mp4`, (contentType) =>
      join(dir, contentType === 'video/mp4' ? 'typed.mp4' : 'typed.bin')
    )
    expect(result.path).toBe(join(dir, 'typed.mp4'))
    expect(existsSync(result.path)).toBe(true)
  })

  it('a throwing target callback aborts before writing anything', async () => {
    const dir = tmp()
    await expect(
      downloadToFile(`${base}/ok.mp4`, () => {
        throw new Error('Unsupported media type')
      })
    ).rejects.toThrow('Unsupported media type')
    expect(existsSync(join(dir, 'out.mp4'))).toBe(false)
  })

  it('rejects non-http(s) URLs without fetching', async () => {
    await expect(downloadToFile('file:///etc/passwd', join(tmp(), 'out'))).rejects.toThrow(
      /non-http/
    )
  })

  it('rejects HTTP errors', async () => {
    await expect(downloadToFile(`${base}/missing`, join(tmp(), 'out'))).rejects.toThrow(
      'download failed: HTTP 404'
    )
  })

  it('rejects a declared size over the cap before downloading', async () => {
    const target = join(tmp(), 'out.mp4')
    await expect(
      downloadToFile(`${base}/oversized-declared`, target, { maxBytes: 1024 })
    ).rejects.toThrow(/byte limit/)
    expect(existsSync(target)).toBe(false)
  })

  it('aborts a chunked body over the cap and removes the partial file', async () => {
    const target = join(tmp(), 'out.mp4')
    await expect(
      downloadToFile(`${base}/oversized-chunked`, target, { maxBytes: 1024 })
    ).rejects.toThrow(/byte limit/)
    expect(existsSync(target)).toBe(false)
  })
})
