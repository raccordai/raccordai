import { describe, expect, it } from 'vitest'
import { remapDraftInputs, resolveDraftRun } from './draft'
import { defaultParamsFor, getModelOrThrow } from './index'

describe('resolveDraftRun', () => {
  it('returns null for models without a draftEquivalent', () => {
    expect(resolveDraftRun('nano-banana-2-lite', {})).toBeNull()
    expect(resolveDraftRun('bytedance/seedance-2-fast', {})).toBeNull()
    expect(resolveDraftRun('unknown-model', {})).toBeNull()
  })

  it('substitutes seedance-2 with seedance-2-fast, flooring 4k to the draft default', () => {
    const sub = resolveDraftRun('bytedance/seedance-2', {
      ...defaultParamsFor('bytedance/seedance-2'),
      prompt: 'a chase scene',
      resolution: '4k'
    })
    expect(sub).not.toBeNull()
    expect(sub!.modelId).toBe('bytedance/seedance-2-fast')
    // 4k is not in Fast's enum → floored to Fast's paramField default (720p).
    expect(sub!.params.resolution).toBe('720p')
    expect(sub!.params.prompt).toBe('a chase scene')
    // Raw substituted params must parse with the draft model's schema.
    const parsed = getModelOrThrow(sub!.modelId).paramsSchema.safeParse(sub!.params)
    expect(parsed.success).toBe(true)
  })

  it('keeps values the draft model accepts (480p survives the swap)', () => {
    const sub = resolveDraftRun('bytedance/seedance-2', { prompt: 'x', resolution: '480p' })
    expect(sub!.params.resolution).toBe('480p')
  })

  it('applies declared param overrides (kling std, seedance-1.5 480p)', () => {
    const kling = resolveDraftRun('kling-3.0/video', { prompt: 'x', mode: 'pro' })
    expect(kling!.modelId).toBe('kling-3.0/video')
    expect(kling!.params.mode).toBe('std')
    const seedance = resolveDraftRun('bytedance/seedance-1.5-pro', {
      prompt: 'x',
      resolution: '1080p'
    })
    expect(seedance!.params.resolution).toBe('480p')
  })

  it('returns null for a self-substitution that changes nothing (already at draft cost)', () => {
    expect(resolveDraftRun('kling-3.0/video', { prompt: 'x', mode: 'std' })).toBeNull()
    expect(
      resolveDraftRun('gpt-image-2-text-to-image', { prompt: 'x', resolution: '1K' })
    ).toBeNull()
    // …but a cross-model substitution always applies, even with equal params.
    expect(resolveDraftRun('bytedance/seedance-2', { prompt: 'x', resolution: '720p' })).not.toBe(
      null
    )
  })

  it('seedance-2-5 drafts to itself at 480p, so 30 s durations survive draft mode', () => {
    const sub = resolveDraftRun('bytedance/seedance-2-5', {
      prompt: 'x',
      resolution: '1080p',
      duration: 30
    })
    expect(sub!.modelId).toBe('bytedance/seedance-2-5')
    expect(sub!.params.resolution).toBe('480p')
    expect(sub!.params.duration).toBe(30)
    // Already at draft cost → never stamped draft.
    expect(
      resolveDraftRun('bytedance/seedance-2-5', { prompt: 'x', resolution: '480p' })
    ).toBeNull()
  })

  it('carries marker params through untouched (stripped later by the target schema)', () => {
    const sub = resolveDraftRun('nano-banana-pro', {
      prompt: 'x',
      resolution: '4K',
      applyVideoStyle: true
    })
    expect(sub!.modelId).toBe('nano-banana-2-lite')
    expect(sub!.params.applyVideoStyle).toBe(true)
    const parsed = getModelOrThrow(sub!.modelId).paramsSchema.parse(sub!.params)
    expect('applyVideoStyle' in (parsed as Record<string, unknown>)).toBe(false)
  })
})

describe('remapDraftInputs', () => {
  it('renames handles per the declared mapping and clamps to the draft maxCount', () => {
    const sub = resolveDraftRun('nano-banana-2', { prompt: 'x' })!
    const urls = Array.from({ length: 14 }, (_, i) => `media://asset/${i}`)
    const remapped = remapDraftInputs(sub, { image_input: urls })
    // nano-banana-2 allows 14 inputs, lite caps image_urls at 10.
    expect(Object.keys(remapped)).toEqual(['image_urls'])
    expect(remapped.image_urls).toHaveLength(10)
    expect(remapped.image_urls?.[0]).toBe('media://asset/0')
  })

  it('passes identical handle keys through verbatim (seedance family)', () => {
    const sub = resolveDraftRun('bytedance/seedance-2', { prompt: 'x' })!
    const remapped = remapDraftInputs(sub, {
      first_frame_url: ['media://generation/a/result'],
      reference_image_urls: ['media://asset/1', 'media://asset/2']
    })
    expect(remapped).toEqual({
      first_frame_url: ['media://generation/a/result'],
      reference_image_urls: ['media://asset/1', 'media://asset/2']
    })
  })

  it('drops inputs the draft model has no handle for', () => {
    const sub = resolveDraftRun('nano-banana-pro', { prompt: 'x' })!
    const remapped = remapDraftInputs(sub, { unknown_handle: ['media://asset/1'] })
    expect(remapped).toEqual({})
  })
})
