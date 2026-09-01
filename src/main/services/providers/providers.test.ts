import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../kie', () => ({
  kieCreateTask: vi.fn(),
  kieCreateSunoTask: vi.fn(),
  kieGetTaskInfo: vi.fn(),
  kieGetSunoStatus: vi.fn(),
  kieUploadFile: vi.fn(),
  parseResultUrl: (json: string | undefined) =>
    json ? (JSON.parse(json) as { resultUrls?: string[] }).resultUrls?.[0] : undefined
}))
vi.mock('../elevenlabs', () => ({ elevenlabsGenerateAudio: vi.fn() }))
vi.mock('../settings', () => ({
  getKieApiKey: vi.fn(() => 'kie-key'),
  getElevenLabsApiKey: vi.fn(() => 'eleven-key')
}))

import * as kie from '../kie'
import * as elevenlabs from '../elevenlabs'
import * as settings from '../settings'
import { providerFor, providerOf } from './index'
import {
  CLOUD_QUEUE_KEY,
  kieInputPublisher,
  kieJobsProvider,
  kieSunoProvider,
  uploadFresh,
  UPLOAD_TTL_MS
} from './kie'
import { elevenlabsProvider } from './elevenlabs'
import { getModel } from '@shared/models'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.mocked(settings.getKieApiKey).mockReturnValue('kie-key')
  vi.mocked(settings.getElevenLabsApiKey).mockReturnValue('eleven-key')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('providerFor', () => {
  it('maps each model family to its provider', () => {
    expect(providerFor('bytedance/seedance-2-fast').id).toBe('jobs')
    expect(providerFor('suno/generate-music').id).toBe('suno')
    expect(providerFor('elevenlabs/text-to-speech').id).toBe('elevenlabs')
  })

  it('falls back to the default family for unknown ids and asset nodes', () => {
    expect(providerFor('does-not-exist').id).toBe('jobs')
    expect(providerFor('studio/asset').id).toBe('jobs')
    expect(providerOf(undefined).id).toBe('jobs')
    expect(providerOf(getModel('suno/generate-music')).id).toBe('suno')
  })

  it('draws every hosted provider from the single cloud concurrency budget', () => {
    for (const p of [kieJobsProvider, kieSunoProvider, elevenlabsProvider]) {
      expect(p.queueKey).toBe(CLOUD_QUEUE_KEY)
    }
  })
})

describe('kie jobs provider', () => {
  it('refuses to run without the kie key', () => {
    vi.mocked(settings.getKieApiKey).mockReturnValue(null)
    expect(() => kieJobsProvider.assertConfigured()).toThrow(/kie\.ai API key/)
    expect(() => kieSunoProvider.assertConfigured()).toThrow(/kie\.ai API key/)
  })

  it('submits the model + payload and returns the task id', async () => {
    vi.mocked(kie.kieCreateTask).mockResolvedValue('task_1')
    const result = await kieJobsProvider.submit({
      generationId: 'g1',
      modelId: 'bytedance/seedance-2-fast',
      payload: { prompt: 'p' }
    })
    expect(result).toEqual({ taskRef: 'task_1' })
    expect(kie.kieCreateTask).toHaveBeenCalledWith({
      model: 'bytedance/seedance-2-fast',
      input: { prompt: 'p' }
    })
  })

  it('does not retry a 4xx createTask rejection', async () => {
    vi.mocked(kie.kieCreateTask).mockRejectedValue(new Error('kie.ai createTask failed (400): bad'))
    await expect(
      kieJobsProvider.submit({ generationId: 'g', modelId: 'm', payload: {} })
    ).rejects.toThrow(/\(400\)/)
    expect(kie.kieCreateTask).toHaveBeenCalledTimes(1)
  })

  it('normalizes recordInfo into success / fail (with failCode) / pending', async () => {
    const base = { taskId: 't', model: 'm', param: '{}' }
    vi.mocked(kie.kieGetTaskInfo).mockResolvedValueOnce({
      ...base,
      state: 'success',
      resultJson: JSON.stringify({ resultUrls: ['https://cdn/x.mp4'] })
    })
    expect(await kieJobsProvider.status('t')).toEqual({
      state: 'success',
      resultUrl: 'https://cdn/x.mp4'
    })

    vi.mocked(kie.kieGetTaskInfo).mockResolvedValueOnce({
      ...base,
      state: 'fail',
      failCode: '400',
      failMsg: 'Image fetch failed'
    })
    expect(await kieJobsProvider.status('t')).toEqual({
      state: 'fail',
      failMsg: '(400) Image fetch failed'
    })

    vi.mocked(kie.kieGetTaskInfo).mockResolvedValueOnce({ ...base, state: 'fail' })
    expect(await kieJobsProvider.status('t')).toEqual({ state: 'fail', failMsg: undefined })

    vi.mocked(kie.kieGetTaskInfo).mockResolvedValueOnce({ ...base, state: 'generating' })
    expect(await kieJobsProvider.status('t')).toEqual({ state: 'pending' })
  })
})

describe('kie suno provider', () => {
  it('submits the flat payload and delegates status to the Suno poller', async () => {
    vi.mocked(kie.kieCreateSunoTask).mockResolvedValue('suno_1')
    expect(
      await kieSunoProvider.submit({
        generationId: 'g',
        modelId: 'suno/generate-music',
        payload: { a: 1 }
      })
    ).toEqual({ taskRef: 'suno_1' })
    expect(kie.kieCreateSunoTask).toHaveBeenCalledWith({ input: { a: 1 } })

    vi.mocked(kie.kieGetSunoStatus).mockResolvedValue({ state: 'pending' })
    expect(await kieSunoProvider.status('suno_1')).toEqual({ state: 'pending' })
    expect(kie.kieGetSunoStatus).toHaveBeenCalledWith('suno_1')
  })
})

describe('kie input publisher', () => {
  it('uploadFresh keeps a reference inside the TTL only', () => {
    const now = 1_000_000_000
    expect(uploadFresh('https://u', now - 1000, now)).toBe('https://u')
    expect(uploadFresh('https://u', now - UPLOAD_TTL_MS - 1, now)).toBeNull()
    expect(uploadFresh(null, now, now)).toBeNull()
    expect(uploadFresh('https://u', null, now)).toBeNull()
  })

  it('reuses a fresh cached upload that still answers a HEAD probe', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const result = await kieInputPublisher.publish({
      localPath: '/tmp/a.png',
      purpose: 'assets',
      cached: { ref: 'https://kie/a.png', at: Date.now() - 1000 }
    })
    expect(result).toEqual({ ref: 'https://kie/a.png', reused: true })
    expect(fetchMock).toHaveBeenCalledWith('https://kie/a.png', { method: 'HEAD' })
    expect(kie.kieUploadFile).not.toHaveBeenCalled()
  })

  it('re-uploads when the cached upload is dead or expired', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    vi.mocked(kie.kieUploadFile).mockResolvedValue('https://kie/fresh.png')
    const dead = await kieInputPublisher.publish({
      localPath: '/tmp/a.png',
      purpose: 'frames',
      cached: { ref: 'https://kie/old.png', at: Date.now() - 1000 }
    })
    expect(dead).toEqual({ ref: 'https://kie/fresh.png', reused: false })
    expect(kie.kieUploadFile).toHaveBeenCalledWith('/tmp/a.png', 'raccord/frames')

    fetchMock.mockClear()
    const expired = await kieInputPublisher.publish({
      localPath: '/tmp/b.png',
      purpose: 'results',
      cached: { ref: 'https://kie/old.png', at: Date.now() - UPLOAD_TTL_MS - 1 }
    })
    expect(expired.reused).toBe(false)
    // Expired: no probe, straight to the upload.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(kie.kieUploadFile).toHaveBeenLastCalledWith('/tmp/b.png', 'raccord/results')
  })

  it('accepts a remote URL only while it answers, and treats network errors as dead', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true })
    expect(await kieInputPublisher.acceptsRemoteUrl('https://cdn/x')).toBe(true)
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect(await kieInputPublisher.acceptsRemoteUrl('https://cdn/x')).toBe(false)
  })
})

describe('elevenlabs provider', () => {
  const transcript = { text: 'hello', segments: [] }

  it('refuses to run without the ElevenLabs key', () => {
    vi.mocked(settings.getElevenLabsApiKey).mockReturnValue(null)
    expect(() => elevenlabsProvider.assertConfigured()).toThrow(/ElevenLabs API key/)
  })

  it('stages the synchronous result and hands back its file:// URL with the transcript', async () => {
    vi.mocked(elevenlabs.elevenlabsGenerateAudio).mockResolvedValue({
      audio: Buffer.from('MP3'),
      mimeType: 'audio/mpeg',
      transcript
    })
    const result = await elevenlabsProvider.submit({
      generationId: 'gen-1',
      modelId: 'elevenlabs/text-to-speech',
      payload: { kind: 'tts' }
    })
    expect(result.transcript).toEqual(transcript)
    expect(result.taskRef.startsWith('file://')).toBe(true)
    const staged = fileURLToPath(result.taskRef)
    expect(readFileSync(staged, 'utf8')).toBe('MP3')

    // The staged file IS the remote status.
    expect(await elevenlabsProvider.status(result.taskRef)).toEqual({
      state: 'success',
      resultUrl: result.taskRef
    })

    // fetchResult moves it into the store (copy + remove the staging file).
    const store = mkdtempSync(join(tmpdir(), 'raccord-store-'))
    const fetched = await elevenlabsProvider.fetchResult!({
      taskRef: result.taskRef,
      resultUrl: result.taskRef,
      kind: 'audio',
      targetFor: (ext) => join(store, `gen-1${ext}`)
    })
    expect(fetched).toEqual({ path: join(store, 'gen-1.mp3'), mimeType: 'audio/mpeg' })
    expect(readFileSync(fetched.path, 'utf8')).toBe('MP3')
    expect(existsSync(staged)).toBe(false)
  })

  it('reports a lost staging file as a failure (restart mid-run)', async () => {
    const gone = pathToFileURL(join(tmpdir(), 'raccord-speech', 'speech-missing.mp3')).href
    expect((await elevenlabsProvider.status(gone)).state).toBe('fail')
    expect((await elevenlabsProvider.status('task_123')).state).toBe('fail')
  })

  it('fetchResult keeps the staged extension when it is not mp3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raccord-stage-'))
    const staged = join(dir, 'speech-x.wav')
    writeFileSync(staged, 'WAV')
    const fetched = await elevenlabsProvider.fetchResult!({
      taskRef: pathToFileURL(staged).href,
      resultUrl: pathToFileURL(staged).href,
      kind: 'audio',
      targetFor: (ext) => join(dir, `out${ext}`)
    })
    expect(fetched.path).toBe(join(dir, 'out.wav'))
  })
})
