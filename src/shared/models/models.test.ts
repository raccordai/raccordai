import { describe, expect, it } from 'vitest'
import { MODELS, defaultParamsFor, estimateCreditsFor, getModel, getModelOrThrow } from './index'

describe('model registry invariants', () => {
  it('has unique model ids', () => {
    const ids = MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const model of MODELS) {
    describe(model.id, () => {
      it('accepts its own paramField defaults (plus a prompt) in its zod schema', () => {
        // Some models require a non-empty prompt at run time while the UI default is ''.
        const params = { ...defaultParamsFor(model.id), prompt: 'test prompt' }
        const parsed = model.paramsSchema.safeParse(params)
        expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true)
      })

      it('has unique input/output handle keys', () => {
        const inputKeys = model.inputs.map((i) => i.key)
        const outputKeys = model.outputs.map((o) => o.key)
        expect(new Set(inputKeys).size).toBe(inputKeys.length)
        expect(new Set(outputKeys).size).toBe(outputKeys.length)
      })

      it('has at least one output', () => {
        expect(model.outputs.length).toBeGreaterThan(0)
      })

      it('estimates a positive, finite credit cost when rates are declared', () => {
        if (!model.estimateCredits) return
        const credits = estimateCreditsFor(model.id, {
          ...defaultParamsFor(model.id),
          prompt: 'test prompt'
        })
        expect(credits).not.toBeNull()
        expect(credits!).toBeGreaterThan(0)
        expect(Number.isFinite(credits)).toBe(true)
      })

      it('builds a payload from schema defaults and empty inputs', () => {
        // min(1) prompts need a value; everything else must come from defaults.
        const params = model.paramsSchema.parse({ prompt: 'test prompt' })
        const payload = model.buildPayload({ params, inputs: {} })
        expect(payload).toBeTypeOf('object')
        expect(Object.keys(payload).length).toBeGreaterThan(0)
      })
    })
  }
})

describe('model lookup', () => {
  it('resolves a known id', () => {
    expect(getModel('bytedance/seedance-2-fast')?.label).toBe('Seedance 2 Fast')
  })

  it('returns undefined for an unknown id', () => {
    expect(getModel('does-not-exist')).toBeUndefined()
  })

  it('getModelOrThrow throws with the offending id in the message', () => {
    expect(() => getModelOrThrow('nope')).toThrowError(/nope/)
  })

  it('resolves legacy aliases to the replacement model', () => {
    // Workflows saved with Grok Imagine 1.0 must keep running on 1.5.
    const model = getModel('grok-imagine/image-to-video')
    expect(model?.id).toBe('grok-imagine-video-1-5-preview')
  })
})

describe('estimateCreditsFor', () => {
  it('scales video cost with duration and resolution', () => {
    const short = estimateCreditsFor('bytedance/seedance-2-fast', {
      duration: 4,
      resolution: '480p'
    })
    const long = estimateCreditsFor('bytedance/seedance-2-fast', {
      duration: 15,
      resolution: '720p'
    })
    expect(short).not.toBeNull()
    expect(long!).toBeGreaterThan(short!)
  })

  it('returns null for unknown models and invalid params', () => {
    expect(estimateCreditsFor('nope', {})).toBeNull()
    // gpt-image requires a non-empty prompt — invalid params → no estimate.
    expect(estimateCreditsFor('gpt-image-2-text-to-image', {})).toBeNull()
    expect(estimateCreditsFor('gpt-image-2-text-to-image', { prompt: 'x', resolution: '4K' })).toBe(
      30
    )
  })
})

describe('defaultParamsFor', () => {
  it('collects paramField defaults', () => {
    expect(defaultParamsFor('bytedance/seedance-2-fast')).toMatchObject({
      prompt: '',
      duration: 15,
      aspect_ratio: '16:9',
      resolution: '720p',
      generate_audio: true
    })
  })

  it('throws on unknown model', () => {
    expect(() => defaultParamsFor('nope')).toThrow()
  })
})

describe('buildPayload shapes', () => {
  it('seedance-2-fast forwards reference inputs and params', () => {
    const model = getModelOrThrow('bytedance/seedance-2-fast')
    const params = model.paramsSchema.parse({ prompt: 'a cat', duration: 8 })
    const payload = model.buildPayload({
      params,
      inputs: { reference_image_urls: ['https://x/img.png'] }
    })
    expect(payload).toMatchObject({
      prompt: 'a cat',
      duration: 8,
      reference_image_urls: ['https://x/img.png'],
      reference_video_urls: [],
      reference_audio_urls: []
    })
  })

  it('gpt-image-2-t2i requires a non-empty prompt', () => {
    const model = getModelOrThrow('gpt-image-2-text-to-image')
    expect(model.paramsSchema.safeParse({ prompt: '' }).success).toBe(false)
    expect(model.paramsSchema.safeParse({ prompt: 'sunset' }).success).toBe(true)
  })
})

describe('suno/generate-music', () => {
  const suno = getModelOrThrow('suno/generate-music')

  it('non-custom mode requires a prompt and nothing else', () => {
    expect(suno.paramsSchema.safeParse({}).success).toBe(false)
    expect(suno.paramsSchema.safeParse({ prompt: 'upbeat synthwave' }).success).toBe(true)
  })

  it('custom mode requires style, title and lyrics unless instrumental', () => {
    expect(suno.paramsSchema.safeParse({ customMode: true }).success).toBe(false)
    expect(
      suno.paramsSchema.safeParse({ customMode: true, style: 'lo-fi', title: 'Rain' }).success
    ).toBe(false) // vocal mode still needs lyrics
    expect(
      suno.paramsSchema.safeParse({
        customMode: true,
        style: 'lo-fi',
        title: 'Rain',
        prompt: 'test lyrics'
      }).success
    ).toBe(true)
    expect(
      suno.paramsSchema.safeParse({
        customMode: true,
        instrumental: true,
        style: 'lo-fi',
        title: 'Rain'
      }).success
    ).toBe(true)
  })

  it('omits custom-mode fields from the payload in non-custom mode', () => {
    const params = suno.paramsSchema.parse({ prompt: 'a calm piano piece', style: 'ignored' })
    const payload = suno.buildPayload({ params, inputs: {} })
    expect(payload).toEqual({
      prompt: 'a calm piano piece',
      customMode: false,
      instrumental: false,
      model: 'V4_5'
    })
  })

  it('includes only the non-empty custom-mode fields', () => {
    const params = suno.paramsSchema.parse({
      customMode: true,
      style: 'synthwave',
      title: 'Neon',
      prompt: 'lyrics here',
      vocalGender: 'f'
    })
    const payload = suno.buildPayload({ params, inputs: {} })
    expect(payload).toMatchObject({ style: 'synthwave', title: 'Neon', vocalGender: 'f' })
    expect(payload).not.toHaveProperty('negativeTags')
  })
})
