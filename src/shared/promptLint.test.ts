import { describe, expect, it } from 'vitest'
import { ANTI_GRID_GUARD } from './models/seedance2-prompting'
import {
  formatFindings,
  hasAntiGridGuard,
  hasBlockingFinding,
  lintNode,
  mentionsMotion,
  type LintConnection
} from './promptLint'

const VIDEO_MODEL = 'bytedance/seedance-2-fast'
const IMAGE_MODEL = 'gpt-image-2-image-to-image'

const rules = (findings: ReturnType<typeof lintNode>): string[] => findings.map((f) => f.rule)

function reference(overrides: Partial<LintConnection> = {}): LintConnection {
  return {
    edgeId: 'e1',
    handleKey: 'reference_image_urls',
    alias: '@Image1',
    sourceLabel: 'Mira sheet',
    ...overrides
  }
}

describe('lintNode', () => {
  it('says nothing about an unknown model', () => {
    expect(lintNode({ modelId: 'studio/asset', params: {}, connections: [] })).toEqual([])
    expect(lintNode({ modelId: 'nope/none', params: { prompt: '' }, connections: [] })).toEqual([])
  })

  it('flags an empty prompt as blocking', () => {
    const findings = lintNode({ modelId: VIDEO_MODEL, params: { prompt: '   ' }, connections: [] })
    expect(rules(findings)).toContain('empty-prompt')
    expect(hasBlockingFinding(findings)).toBe(true)
  })

  it('stays silent on a well-formed prompt', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'The camera pans across the harbour as Mira walks into frame.' },
      connections: []
    })
    expect(findings).toEqual([])
  })

  it('flags a required input that is not connected', () => {
    const findings = lintNode({
      // Grok i2v cannot run without its source image — say so before the click.
      modelId: 'grok-imagine/image-to-video',
      params: { prompt: 'she turns around, camera pushes in' },
      connections: []
    })
    expect(rules(findings)).toContain('required-input-missing')
    expect(findings.find((f) => f.rule === 'required-input-missing')?.subject).toBe('image_urls')
  })

  it('does not flag an optional input left unconnected', () => {
    const findings = lintNode({
      modelId: IMAGE_MODEL,
      params: { prompt: 'repaint the sky' },
      connections: []
    })
    expect(rules(findings)).not.toContain('required-input-missing')
  })

  it('flags a wired reference that the prompt never mentions, and proposes a role', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'Mira walks along the pier, camera tracking her.' },
      connections: [reference({ designId: 'character' })]
    })
    const finding = findings.find((f) => f.rule === 'reference-role-undeclared')
    expect(finding?.severity).toBe('warning')
    expect(finding?.fix).toEqual({
      kind: 'appendPrompt',
      text: expect.stringContaining('@Image1 is the character sheet')
    })
  })

  it('tailors the proposed role sentence to the kind of sheet', () => {
    const roleFor = (designId?: string): string => {
      const findings = lintNode({
        modelId: VIDEO_MODEL,
        params: { prompt: 'She walks in, camera tracking.' },
        connections: [reference(designId ? { designId } : {})]
      })
      const fix = findings.find((f) => f.rule === 'reference-role-undeclared')?.fix
      return fix && fix.kind === 'appendPrompt' ? fix.text : ''
    }
    expect(roleFor('decor')).toContain('décor sheet')
    expect(roleFor('prop')).toContain('prop sheet')
    expect(roleFor('storyboard')).toContain('9-panel storyboard')
    // No design marker: a neutral role the user fills in.
    expect(roleFor()).toContain('is the reference')
  })

  it('accepts a reference whose alias appears in the prompt', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: '@Image1 is the character sheet. She walks, camera tracking her.' },
      connections: [reference({ designId: 'character' })]
    })
    expect(rules(findings)).not.toContain('reference-role-undeclared')
  })

  it('treats a design sheet on a frame anchor as an error and offers a rewire', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'Mira walks in, camera pans.' },
      connections: [
        reference({ handleKey: 'first_frame_url', alias: undefined, designId: 'character' })
      ]
    })
    const finding = findings.find((f) => f.rule === 'storyboard-on-frame-anchor')
    expect(finding?.severity).toBe('error')
    expect(finding?.fix).toEqual({
      kind: 'rewire',
      edgeId: 'e1',
      targetHandle: 'reference_image_urls'
    })
    // The anchored sheet is reported once — not also as an undeclared reference.
    expect(rules(findings).filter((r) => r === 'reference-role-undeclared')).toHaveLength(0)
  })

  it('demands the anti-grid guard on a storyboard-driven shot', () => {
    const prompt = '@Image1 is the 9-panel storyboard, covering panels 1-3. Camera pans right.'
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt },
      connections: [reference({ designId: 'storyboard' })]
    })
    const finding = findings.find((f) => f.rule === 'storyboard-guard-missing')
    expect(finding?.fix).toEqual({ kind: 'appendPrompt', text: ANTI_GRID_GUARD })

    const guarded = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: `${prompt} ${ANTI_GRID_GUARD}` },
      connections: [reference({ designId: 'storyboard' })]
    })
    expect(rules(guarded)).not.toContain('storyboard-guard-missing')
  })

  it('flags a video prompt with no motion at all', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'A red lighthouse on a cliff at golden hour, dramatic clouds.' },
      connections: []
    })
    expect(rules(findings)).toContain('video-prompt-without-motion')
  })

  it('does not ask an image model for motion', () => {
    const findings = lintNode({
      modelId: 'gpt-image-2-text-to-image',
      params: { prompt: 'A red lighthouse on a cliff at golden hour.' },
      connections: []
    })
    expect(rules(findings)).not.toContain('video-prompt-without-motion')
  })

  it('flags a param outside the model enum and proposes the default', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'She walks, camera tracking.', resolution: '4k' },
      connections: []
    })
    const finding = findings.find((f) => f.rule === 'param-out-of-enum')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject).toBe('resolution')
    expect(finding?.fix?.kind).toBe('setParam')
  })

  it('ignores params the model leaves unset', () => {
    const findings = lintNode({
      modelId: VIDEO_MODEL,
      params: { prompt: 'She walks, camera tracking.', resolution: undefined },
      connections: []
    })
    expect(rules(findings)).not.toContain('param-out-of-enum')
  })
})

describe('helpers', () => {
  it('detects motion vocabulary without matching inside words', () => {
    expect(mentionsMotion('slow dolly in on her face')).toBe(true)
    expect(mentionsMotion('la caméra recule lentement')).toBe(true)
    expect(mentionsMotion('a still portrait, soft light')).toBe(false)
    // "panorama" must not count as "pan".
    expect(mentionsMotion('a wide panorama of the bay')).toBe(false)
  })

  it('detects the anti-grid guard in either phrasing', () => {
    expect(hasAntiGridGuard(ANTI_GRID_GUARD)).toBe(true)
    expect(hasAntiGridGuard('… NO PANEL BORDERS anywhere')).toBe(true)
    expect(hasAntiGridGuard('a clean single shot')).toBe(false)
  })

  it('renders findings one per line with a severity marker', () => {
    const findings = lintNode({ modelId: VIDEO_MODEL, params: { prompt: '' }, connections: [] })
    expect(formatFindings(findings).split('\n')[0]).toMatch(/^✗ /)
    expect(formatFindings([])).toBe('')
  })
})
