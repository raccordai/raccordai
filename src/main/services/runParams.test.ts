import { describe, expect, it } from 'vitest'
import { getStyle } from '@shared/styles/registry'
import { composeRunParams } from './runParams'

const VIDEO_MODEL = 'bytedance/seedance-2-fast'
const IMAGE_MODEL = 'gpt-image-2-text-to-image'

describe('composeRunParams', () => {
  it('validates against the model schema and applies defaults', () => {
    const { model, validatedParams, draftSub } = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: 'a quiet street' } },
      undefined
    )
    expect(model.id).toBe(VIDEO_MODEL)
    expect(draftSub).toBeNull()
    expect(validatedParams).toMatchObject({ prompt: 'a quiet street', resolution: '720p' })
  })

  it('names the field in a validation error instead of dumping raw zod', () => {
    expect(() =>
      composeRunParams({ modelId: VIDEO_MODEL, params: { duration: 2 } }, undefined)
    ).toThrow(/Invalid params: "Duration \(s\)" must be between 4 and 15/)
  })

  it('throws on an unknown model id', () => {
    expect(() => composeRunParams({ modelId: 'no-such-model', params: {} }, undefined)).toThrow()
  })

  // §6.1 — draft mode substitutes the declared draftEquivalent BEFORE the
  // snapshot is persisted, so retries replay the substituted run.
  it('substitutes the draft equivalent under draft mode', () => {
    const node = { modelId: IMAGE_MODEL, params: { prompt: 'p', resolution: '4K' } }
    const { draftSub, validatedParams } = composeRunParams(node, { draftMode: true })
    expect(draftSub).not.toBeNull()
    expect((validatedParams as { resolution: string }).resolution).toBe('1K')
  })

  it('forceFinal bypasses the draft substitution (finalize path)', () => {
    const node = { modelId: IMAGE_MODEL, params: { prompt: 'p', resolution: '4K' } }
    const { draftSub, validatedParams } = composeRunParams(
      node,
      { draftMode: true },
      { forceFinal: true }
    )
    expect(draftSub).toBeNull()
    expect((validatedParams as { resolution: string }).resolution).toBe('4K')
  })

  // §6.9 — style-at-payload: the bible is composed at run time on nodes
  // carrying the marker; stored prompts stay business-only.
  it('wraps the prompt with the video style when the node carries applyVideoStyle', () => {
    const stored = 'A rider crosses the bridge at dawn.'
    const { validatedParams } = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: stored, applyVideoStyle: true } },
      { styleId: 'anime' }
    )
    const prompt = (validatedParams as { prompt: string }).prompt
    expect(prompt).not.toBe(stored)
    expect(prompt).toContain(stored)
  })

  it('is idempotent: composing an already-wrapped prompt never stacks two universes', () => {
    const stored = 'A rider crosses the bridge at dawn.'
    const once = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: stored, applyVideoStyle: true } },
      { styleId: 'anime' }
    )
    const wrapped = (once.validatedParams as { prompt: string }).prompt
    const twice = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: wrapped, applyVideoStyle: true } },
      { styleId: 'anime' }
    )
    expect((twice.validatedParams as { prompt: string }).prompt).toBe(wrapped)
  })

  it('leaves nodes WITHOUT the marker byte-identical (pre-existing baked prompts)', () => {
    const stored = 'Already baked with its own style bible.'
    const { validatedParams } = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: stored } },
      { styleId: 'anime' }
    )
    expect((validatedParams as { prompt: string }).prompt).toBe(stored)
  })

  it('never wraps when the video has no style', () => {
    expect(getStyle('anime')).toBeDefined()
    const stored = 'No style set on the video.'
    const { validatedParams } = composeRunParams(
      { modelId: VIDEO_MODEL, params: { prompt: stored, applyVideoStyle: true } },
      { styleId: null }
    )
    expect((validatedParams as { prompt: string }).prompt).toBe(stored)
  })
})
