import { describe, expect, it } from 'vitest'
import {
  MODELS,
  clampParamToField,
  defaultParamsFor,
  describeParamsError,
  estimateCreditsFor,
  getModel,
  getModelOrThrow,
  videoDefaultParams
} from './index'
import type { ParamField } from './types'

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

      it('declares at least one kebab-case recommendedFor tag (§4.7 recommendation layer)', () => {
        expect(model.recommendedFor.length).toBeGreaterThan(0)
        for (const tag of model.recommendedFor) {
          expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        }
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

      // The API's numeric limits are only real if they are declared on the
      // field: the params panel clamps to them, the prompt lint checks them and
      // list_models/docs publish them to the agents. An undeclared bound is a
      // 3-second Seedance clip that only fails once the credits are committed.
      it('declares bounds on every number field, and its schema agrees with them', () => {
        const numberFields = model.paramFields.filter((f) => f.type === 'number')
        for (const field of numberFields) {
          expect(field.min, `${field.key} has no min`).toBeTypeOf('number')
          expect(field.max, `${field.key} has no max`).toBeTypeOf('number')
          const base = { ...defaultParamsFor(model.id), prompt: 'test prompt' }
          // Both bounds must be reachable…
          for (const bound of [field.min!, field.max!]) {
            const parsed = model.paramsSchema.safeParse({ ...base, [field.key]: bound })
            expect(parsed.success, `${field.key} rejects its own bound ${bound}`).toBe(true)
          }
          // …and past the ceiling must be refused (the floor may be deliberately
          // tolerant: grok i2v snaps old sub-6s nodes up in buildPayload).
          const tooHigh = model.paramsSchema.safeParse({
            ...base,
            [field.key]: field.max! + (field.step ?? 1)
          })
          expect(tooHigh.success, `${field.key} accepts more than its max`).toBe(false)
        }
      })

      // A handle whose sources have a combined-length budget must declare it as
      // a number (the lint adds the sources up), not only in prose.
      it('declares maxTotalSeconds as a positive number when it has one', () => {
        for (const handle of model.inputs) {
          if (handle.maxTotalSeconds === undefined) continue
          expect(handle.maxTotalSeconds).toBeGreaterThan(0)
          expect(handle.multiple, `${handle.key} budgets seconds but is single`).toBe(true)
        }
      })

      it('declares a coherent draftEquivalent when it has one (§6.1 draft mode)', () => {
        const draft = model.draftEquivalent
        if (!draft) return
        const target = getModel(draft.modelId)
        // Target must exist, be runnable the same way (kind drives result
        // handling, provider drives polling) and not chain into another draft.
        expect(target, `unknown draft model ${draft.modelId}`).toBeDefined()
        expect(target!.kind).toBe(model.kind)
        expect(target!.provider ?? 'jobs').toBe(model.provider ?? 'jobs')
        if (target!.id !== model.id) expect(target!.draftEquivalent).toBeUndefined()
        // Overridden params must pass the target's schema on top of this
        // model's defaults (zod strips params the target doesn't declare).
        const params = {
          ...defaultParamsFor(model.id),
          prompt: 'test prompt',
          ...(draft.params ?? {})
        }
        const parsed = target!.paramsSchema.safeParse(params)
        expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true)
        // Every input handle must land on a target handle (renamed via the
        // mapping or verbatim) with the same media types and anchor semantics.
        const mapping = draft.inputs ?? {}
        for (const key of Object.keys(mapping)) {
          expect(
            model.inputs.some((h) => h.key === key),
            `mapping source ${key}`
          ).toBe(true)
        }
        for (const handle of model.inputs) {
          const mappedKey = mapping[handle.key] ?? handle.key
          const targetHandle = target!.inputs.find((h) => h.key === mappedKey)
          expect(targetHandle, `no draft handle for ${model.id}.${handle.key}`).toBeDefined()
          expect(targetHandle!.accepts).toEqual(handle.accepts)
          expect(Boolean(targetHandle!.frameAnchor)).toBe(Boolean(handle.frameAnchor))
        }
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

  it('resolves legacy 1.5 nodes to the restored Grok 1.5 model, not an alias', () => {
    // The 1.5 id was aliased to the plain Grok i2v while the model was retired;
    // it is a real model again and MUST NOT be shadowed by a leftover alias.
    const model = getModel('grok-imagine-video-1-5-preview')
    expect(model?.id).toBe('grok-imagine-video-1-5-preview')
    expect(model?.label).toContain('1.5')
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

  // kie.ai pricing (2026-07): per-second rates per tier, audio surcharge below 4K.
  it('prices Kling 3.0 per mode, duration and audio', () => {
    expect(estimateCreditsFor('kling-3.0/video', { prompt: 'x', mode: 'std', duration: 5 })).toBe(
      70
    )
    expect(estimateCreditsFor('kling-3.0/video', { prompt: 'x', mode: 'pro', duration: 5 })).toBe(
      90
    )
    expect(
      estimateCreditsFor('kling-3.0/video', { prompt: 'x', mode: 'pro', duration: 5, sound: true })
    ).toBe(135)
    expect(
      estimateCreditsFor('kling-3.0/video', { prompt: 'x', mode: '4K', duration: 5, sound: true })
    ).toBe(335)
  })

  // kie.ai pricing (2026-07): grok-imagine — 1.6 cr/s at 480p, 3 cr/s at 720p.
  it('prices Grok Imagine per resolution and duration, floor-snapped on i2v', () => {
    expect(
      estimateCreditsFor('grok-imagine/text-to-video', {
        prompt: 'x',
        resolution: '480p',
        duration: 10
      })
    ).toBe(16)
    expect(
      estimateCreditsFor('grok-imagine/image-to-video', {
        prompt: 'x',
        resolution: '720p',
        duration: 8
      })
    ).toBe(24)
    // Legacy Grok 1.5 nodes may store sub-6s durations; the API bills 6s.
    expect(
      estimateCreditsFor('grok-imagine/image-to-video', {
        prompt: 'x',
        resolution: '480p',
        duration: 4
      })
    ).toBeCloseTo(9.6)
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

describe('videoDefaultParams', () => {
  it('keeps only the defaults the model actually supports', () => {
    // seedance-2-fast: 9:16 is a valid aspect option, 1080p is NOT a resolution option.
    expect(
      videoDefaultParams('bytedance/seedance-2-fast', {
        defaultAspectRatio: '9:16',
        defaultResolution: '1080p'
      })
    ).toEqual({ aspect_ratio: '9:16' })
    // gpt-image: NK resolutions apply, Np ones don't.
    expect(
      videoDefaultParams('gpt-image-2-text-to-image', {
        defaultAspectRatio: '9:16',
        defaultResolution: '2K'
      })
    ).toEqual({ aspect_ratio: '9:16', resolution: '2K' })
  })

  it('is empty without defaults, for null values and for unknown models', () => {
    expect(videoDefaultParams('bytedance/seedance-2-fast', null)).toEqual({})
    expect(
      videoDefaultParams('bytedance/seedance-2-fast', {
        defaultAspectRatio: null,
        defaultResolution: null
      })
    ).toEqual({})
    expect(videoDefaultParams('studio/asset', { defaultAspectRatio: '16:9' })).toEqual({})
  })

  it('ignores values outside the model enum (never produces invalid params)', () => {
    // suno has neither field; kling-3 has aspect_ratio but no resolution field.
    expect(videoDefaultParams('suno/generate-music', { defaultAspectRatio: '16:9' })).toEqual({})
    expect(
      videoDefaultParams('kling-3.0/video', {
        defaultAspectRatio: '16:9',
        defaultResolution: '1080p'
      })
    ).toEqual({ aspect_ratio: '16:9' })
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

describe('seedance 2 family', () => {
  const FAMILY = [
    'bytedance/seedance-2',
    'bytedance/seedance-2-fast',
    'bytedance/seedance-2-mini',
    'bytedance/seedance-2-5'
  ]

  for (const id of FAMILY) {
    it(`${id} declares first/last frame handles as single-connection frame anchors`, () => {
      const model = getModelOrThrow(id)
      for (const key of ['first_frame_url', 'last_frame_url']) {
        const handle = model.inputs.find((i) => i.key === key)
        expect(handle?.frameAnchor).toBe(true)
        expect(handle?.maxCount).toBe(1)
      }
      // Reference handles stay guides, never anchors.
      for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
        expect(model.inputs.find((i) => i.key === key)?.frameAnchor).toBeUndefined()
      }
    })

    it(`${id} omits frame anchors from the payload when unconnected, sends them when wired`, () => {
      const model = getModelOrThrow(id)
      const params = model.paramsSchema.parse({ prompt: 'a cat' })
      const bare = model.buildPayload({ params, inputs: {} })
      expect(bare).not.toHaveProperty('first_frame_url')
      expect(bare).not.toHaveProperty('last_frame_url')
      const anchored = model.buildPayload({
        params,
        inputs: { first_frame_url: ['https://x/a.png'], last_frame_url: ['https://x/b.png'] }
      })
      expect(anchored).toMatchObject({
        first_frame_url: 'https://x/a.png',
        last_frame_url: 'https://x/b.png'
      })
    })
  }

  it('resolution tiers match kie.ai: mini/fast cap at 720p, 2.5 at 1080p, seedance-2 reaches 4k', () => {
    const full = getModelOrThrow('bytedance/seedance-2')
    expect(full.paramsSchema.safeParse({ resolution: '4k' }).success).toBe(true)
    for (const id of ['bytedance/seedance-2-fast', 'bytedance/seedance-2-mini']) {
      const model = getModelOrThrow(id)
      expect(model.paramsSchema.safeParse({ resolution: '1080p' }).success).toBe(false)
      expect(model.paramsSchema.safeParse({ resolution: '720p' }).success).toBe(true)
    }
    const v25 = getModelOrThrow('bytedance/seedance-2-5')
    expect(v25.paramsSchema.safeParse({ resolution: '1080p' }).success).toBe(true)
    expect(v25.paramsSchema.safeParse({ resolution: '4k' }).success).toBe(false)
  })

  it('2.5 spans 4-30 s, pins mp4 output and never sends return_last_frame', () => {
    const model = getModelOrThrow('bytedance/seedance-2-5')
    expect(model.paramsSchema.safeParse({ duration: 30 }).success).toBe(true)
    expect(model.paramsSchema.safeParse({ duration: 31 }).success).toBe(false)
    expect(model.paramsSchema.safeParse({ duration: 3 }).success).toBe(false)
    // duration=-1 (API auto-length) is deliberately not exposed — the timeline
    // and the credit estimate need a declared duration.
    expect(model.paramsSchema.safeParse({ duration: -1 }).success).toBe(false)
    const params = model.paramsSchema.parse({ prompt: 'a cat', duration: 30 })
    const payload = model.buildPayload({ params, inputs: {} })
    expect(payload).toMatchObject({ duration: 30, output_format: 'mp4' })
    expect(payload).not.toHaveProperty('return_last_frame')
  })

  it('2.5 widens the reference budget (30 images, 10 videos/audios, 30 s combined)', () => {
    const model = getModelOrThrow('bytedance/seedance-2-5')
    const images = model.inputs.find((i) => i.key === 'reference_image_urls')
    const videos = model.inputs.find((i) => i.key === 'reference_video_urls')
    const audios = model.inputs.find((i) => i.key === 'reference_audio_urls')
    expect(images?.maxCount).toBe(30)
    expect(videos?.maxCount).toBe(10)
    expect(videos?.maxTotalSeconds).toBe(30)
    expect(audios?.maxCount).toBe(10)
    expect(audios?.maxTotalSeconds).toBe(30)
  })

  it('each generation gets its own prompt guide budgets (2.0 unchanged, 2.5 widened)', () => {
    const v20 = getModelOrThrow('bytedance/seedance-2-fast')
    const v25 = getModelOrThrow('bytedance/seedance-2-5')
    expect(v20.promptGuide).toContain('@Image1-@Image9')
    expect(v20.promptGuide).toContain('≤12 files total')
    expect(v25.promptGuide).toContain('@Image1-@Image30')
    expect(v25.promptGuide).toContain('@Video1-@Video10')
    expect(v25.promptGuide).toContain('LONG TAKES')
    expect(v25.promptGuide).not.toContain('≤12 files total')
    // The handle declarations mirror the guide's budgets — same source of truth.
    const budget = v25.inputs.find((i) => i.key === 'reference_video_urls')
    expect(v25.promptGuide).toContain(`≤${budget!.maxTotalSeconds} s total`)
  })
})

describe('nano banana family', () => {
  it('nano-banana-pro charges 18 credits at 1K/2K and 24 at 4K', () => {
    expect(estimateCreditsFor('nano-banana-pro', { prompt: 'x' })).toBe(18)
    expect(estimateCreditsFor('nano-banana-pro', { prompt: 'x', resolution: '2K' })).toBe(18)
    expect(estimateCreditsFor('nano-banana-pro', { prompt: 'x', resolution: '4K' })).toBe(24)
  })

  it('nano-banana-2 scales credits with resolution', () => {
    expect(estimateCreditsFor('nano-banana-2', { prompt: 'x' })).toBe(8)
    expect(estimateCreditsFor('nano-banana-2', { prompt: 'x', resolution: '2K' })).toBe(12)
    expect(estimateCreditsFor('nano-banana-2', { prompt: 'x', resolution: '4K' })).toBe(18)
  })

  it('nano-banana-2 forwards inputs on image_input with resolution and format', () => {
    const model = getModelOrThrow('nano-banana-2')
    const params = model.paramsSchema.parse({ prompt: 'a cat', output_format: 'jpg' })
    const payload = model.buildPayload({
      params,
      inputs: { image_input: ['https://x/img.png'] }
    })
    expect(payload).toEqual({
      prompt: 'a cat',
      image_input: ['https://x/img.png'],
      aspect_ratio: 'auto',
      resolution: '1K',
      output_format: 'jpg'
    })
  })

  it('nano-banana-2-lite sends image_urls and no resolution/format', () => {
    const model = getModelOrThrow('nano-banana-2-lite')
    const params = model.paramsSchema.parse({ prompt: 'a pig on the grass' })
    const payload = model.buildPayload({
      params,
      inputs: { image_urls: ['https://x/a.png'] }
    })
    expect(payload).toEqual({
      prompt: 'a pig on the grass',
      image_urls: ['https://x/a.png'],
      aspect_ratio: 'auto'
    })
  })
})

describe('grok imagine family', () => {
  it('i2v snaps sub-6s durations from old Grok 1.5 nodes to the API floor', () => {
    const model = getModelOrThrow('grok-imagine/image-to-video')
    // Old nodes stored duration 1-15 with default 8 — 4s must still parse…
    const params = model.paramsSchema.parse({ prompt: 'walks', duration: 4 })
    // …but the API floor is 6s.
    const payload = model.buildPayload({ params, inputs: { image_urls: ['https://x/a.png'] } })
    expect(payload).toMatchObject({ duration: 6, image_urls: ['https://x/a.png'] })
  })

  it('i2v omits aspect_ratio on auto and sends it when fixed', () => {
    const model = getModelOrThrow('grok-imagine/image-to-video')
    const auto = model.buildPayload({
      params: model.paramsSchema.parse({ prompt: 'x' }),
      inputs: {}
    })
    expect(auto).not.toHaveProperty('aspect_ratio')
    const fixed = model.buildPayload({
      params: model.paramsSchema.parse({ prompt: 'x', aspect_ratio: '9:16' }),
      inputs: {}
    })
    expect(fixed).toMatchObject({ aspect_ratio: '9:16' })
  })

  it('1.5 preview accepts sub-6s durations and runs without images (t2v)', () => {
    const model = getModelOrThrow('grok-imagine-video-1-5-preview')
    const params = model.paramsSchema.parse({ prompt: 'a fox runs', duration: 3 })
    const payload = model.buildPayload({ params, inputs: {} })
    expect(payload).toMatchObject({ prompt: 'a fox runs', duration: 3 })
    expect(payload).not.toHaveProperty('image_urls')
  })

  it('1.5 preview maps legacy 4:3/3:4 ratios to the closest current enum value', () => {
    const model = getModelOrThrow('grok-imagine-video-1-5-preview')
    for (const [legacy, mapped] of [
      ['4:3', '3:2'],
      ['3:4', '2:3']
    ]) {
      const params = model.paramsSchema.parse({ prompt: 'x', aspect_ratio: legacy })
      expect(model.buildPayload({ params, inputs: {} })).toMatchObject({ aspect_ratio: mapped })
    }
    // …and the UI never offers the legacy values.
    const field = model.paramFields.find((f) => f.key === 'aspect_ratio')
    expect(field?.options?.some((o) => o.value === '4:3')).toBe(false)
  })

  it('1.5 preview rejects several images at 1080p (API limit) before the spend', () => {
    const model = getModelOrThrow('grok-imagine-video-1-5-preview')
    const params = model.paramsSchema.parse({ prompt: 'x', resolution: '1080p' })
    expect(() =>
      model.buildPayload({
        params,
        inputs: { image_urls: ['https://x/a.png', 'https://x/b.png'] }
      })
    ).toThrowError(/single source image/)
    const one = model.buildPayload({ params, inputs: { image_urls: ['https://x/a.png'] } })
    expect(one).toMatchObject({ image_urls: ['https://x/a.png'], resolution: '1080p' })
  })

  it('i2v never offers spicy mode (rejected with external image URLs)', () => {
    const model = getModelOrThrow('grok-imagine/image-to-video')
    expect(model.paramsSchema.safeParse({ mode: 'spicy' }).success).toBe(false)
    expect(
      getModelOrThrow('grok-imagine/text-to-video').paramsSchema.safeParse({ mode: 'spicy' })
        .success
    ).toBe(true)
  })
})

describe('kling-3.0/video', () => {
  const kling = getModelOrThrow('kling-3.0/video')

  it('declares first/last frame handles as single-connection frame anchors', () => {
    for (const key of ['first_frame', 'last_frame']) {
      const handle = kling.inputs.find((i) => i.key === key)
      expect(handle?.frameAnchor).toBe(true)
      expect(handle?.maxCount).toBe(1)
    }
  })

  it('text-to-video: sends aspect_ratio, a string duration and single-shot mode', () => {
    const params = kling.paramsSchema.parse({ prompt: 'a fox', duration: 10 })
    const payload = kling.buildPayload({ params, inputs: {} })
    expect(payload).toEqual({
      prompt: 'a fox',
      sound: false,
      duration: '10',
      mode: 'pro',
      multi_shots: false,
      aspect_ratio: '16:9'
    })
  })

  it('anchored: composes image_urls as [first, last] and drops aspect_ratio', () => {
    const params = kling.paramsSchema.parse({ prompt: 'a fox' })
    const payload = kling.buildPayload({
      params,
      inputs: { first_frame: ['https://x/a.png'], last_frame: ['https://x/b.png'] }
    })
    expect(payload).toMatchObject({ image_urls: ['https://x/a.png', 'https://x/b.png'] })
    expect(payload).not.toHaveProperty('aspect_ratio')
  })

  it('rejects a last frame without a first frame (image_urls[0] IS the first frame)', () => {
    const params = kling.paramsSchema.parse({ prompt: 'a fox' })
    expect(() =>
      kling.buildPayload({ params, inputs: { last_frame: ['https://x/b.png'] } })
    ).toThrowError(/First frame/)
  })
})

describe('volcengine/video-to-video-lip-sync', () => {
  const lipSync = getModelOrThrow('volcengine/video-to-video-lip-sync')

  it('requires exactly one video and one audio source', () => {
    for (const key of ['video_url', 'audio_url']) {
      const handle = lipSync.inputs.find((i) => i.key === key)
      expect(handle?.required).toBe(true)
      expect(handle?.maxCount).toBe(1)
    }
  })

  it('lite mode sends the loop switches and omits the basic-only ones', () => {
    const params = lipSync.paramsSchema.parse({})
    const payload = lipSync.buildPayload({
      params,
      inputs: { video_url: ['https://x/clip.mp4'], audio_url: ['https://x/voice.mp3'] }
    })
    expect(payload).toEqual({
      mode: 'lite',
      separate_vocal: false,
      video_url: 'https://x/clip.mp4',
      audio_url: 'https://x/voice.mp3',
      align_audio: true,
      align_audio_reverse: false
    })
  })

  it('basic mode sends open_scenedet and omits the lite-only switches', () => {
    const params = lipSync.paramsSchema.parse({
      mode: 'basic',
      open_scenedet: true,
      templ_start_seconds: 5
    })
    const payload = lipSync.buildPayload({ params, inputs: {} })
    expect(payload).toEqual({ mode: 'basic', separate_vocal: false, open_scenedet: true })
  })

  it('sends templ_start_seconds when set and drops align_audio_reverse when the loop is off', () => {
    const params = lipSync.paramsSchema.parse({ templ_start_seconds: 3, align_audio: false })
    const payload = lipSync.buildPayload({ params, inputs: {} })
    expect(payload).toMatchObject({ align_audio: false, templ_start_seconds: 3 })
    expect(payload).not.toHaveProperty('align_audio_reverse')
  })
})

describe('omnihuman-1-5', () => {
  const omni = getModelOrThrow('omnihuman-1-5')

  it('declares the portrait as a required single frame anchor and masks as optional', () => {
    const portrait = omni.inputs.find((i) => i.key === 'image_url')
    expect(portrait?.required).toBe(true)
    expect(portrait?.maxCount).toBe(1)
    expect(portrait?.frameAnchor).toBe(true)
    const masks = omni.inputs.find((i) => i.key === 'mask_url')
    expect(masks?.required).toBeUndefined()
    expect(masks?.maxCount).toBe(5)
  })

  it('omits the optional fields at their defaults (empty prompt, seed -1, no masks)', () => {
    const params = omni.paramsSchema.parse({})
    const payload = omni.buildPayload({
      params,
      inputs: { image_url: ['https://x/face.png'], audio_url: ['https://x/voice.mp3'] }
    })
    expect(payload).toEqual({
      output_resolution: '1080',
      pe_fast_mode: false,
      image_url: 'https://x/face.png',
      audio_url: 'https://x/voice.mp3'
    })
  })

  it('sends prompt, seed and masks when set', () => {
    const params = omni.paramsSchema.parse({ prompt: 'sings joyfully', seed: 42 })
    const payload = omni.buildPayload({
      params,
      inputs: { mask_url: ['https://x/m1.png', 'https://x/m2.png'] }
    })
    expect(payload).toMatchObject({
      prompt: 'sings joyfully',
      seed: 42,
      mask_url: ['https://x/m1.png', 'https://x/m2.png']
    })
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

describe('clampParamToField', () => {
  const duration = (overrides: Partial<ParamField> = {}): ParamField => ({
    key: 'duration',
    label: 'Duration (s)',
    type: 'number',
    min: 4,
    max: 15,
    step: 1,
    defaultValue: 5,
    ...overrides
  })

  it('lifts a value below the floor and drops one above the ceiling', () => {
    expect(clampParamToField(3, duration())).toBe(4)
    expect(clampParamToField(0, duration())).toBe(4)
    expect(clampParamToField(20, duration())).toBe(15)
  })

  it('leaves a legal value alone', () => {
    expect(clampParamToField(4, duration())).toBe(4)
    expect(clampParamToField(9, duration())).toBe(9)
  })

  it('snaps to the step when the field describes a discrete set, ties downwards', () => {
    const seedance15 = duration({ min: 4, max: 12, step: 4, defaultValue: 8 })
    expect(clampParamToField(5, seedance15)).toBe(4)
    expect(clampParamToField(6, seedance15)).toBe(4) // tie → the cheaper clip
    expect(clampParamToField(7, seedance15)).toBe(8)
    expect(clampParamToField(11, seedance15)).toBe(12)
    // …and matches what buildPayload actually sends.
    const model = getModelOrThrow('bytedance/seedance-1.5-pro')
    const params = model.paramsSchema.parse({ prompt: 'p', duration: 7 })
    expect(model.buildPayload({ params, inputs: {} }).duration).toBe('8')
  })

  it('falls back to the default for a non-number (an emptied input field)', () => {
    expect(clampParamToField(Number.NaN, duration())).toBe(5)
    expect(clampParamToField(Number.NaN, duration({ defaultValue: undefined }))).toBe(4)
  })
})

describe('describeParamsError', () => {
  const model = getModelOrThrow('bytedance/seedance-2-fast')

  it('names the field and its bounds instead of dumping zod', () => {
    const result = model.paramsSchema.safeParse({ prompt: 'p', duration: 3 })
    const message = describeParamsError((result as { error: unknown }).error, model)
    expect(message).toBe('"Duration (s)" must be between 4 and 15.')
  })

  it('lists the accepted values of an enum field', () => {
    const result = model.paramsSchema.safeParse({ prompt: 'p', resolution: '1080p' })
    const message = describeParamsError((result as { error: unknown }).error, model)
    expect(message).toContain('"Resolution" must be one of 480p, 720p')
  })

  it('passes a non-zod error through unchanged', () => {
    expect(describeParamsError(new Error('boom'), model)).toBe('boom')
  })
})
