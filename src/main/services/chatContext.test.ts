import { describe, expect, it } from 'vitest'
import type { Niche, NicheRoadmapItem, VoicePersona } from '@shared/ipc/contracts'
import { formatAppContext, formatProjectInstructions, formatRoadmapContext } from './chatContext'

describe('formatProjectInstructions', () => {
  it('renders the priority header, the project name and the markdown verbatim', () => {
    const md = '# Méthode\n\n- Toujours 3 shots\n- Jamais de zoom'
    const block = formatProjectInstructions('Ma chaîne', md)
    expect(block).toMatch(/^PROJECT INSTRUCTIONS — /)
    expect(block).toContain('project "Ma chaîne"')
    expect(block).toContain('PRIORITY')
    expect(block).toContain('EVERY video')
    expect(block).toContain('set_project_instructions')
    // The markdown itself is passed through untouched, after the header line.
    expect(block.endsWith(`\n${md}`)).toBe(true)
  })
})

describe('formatAppContext', () => {
  it('returns null without a context', () => {
    expect(formatAppContext(undefined)).toBeNull()
  })

  it('returns null for an empty context (no block injected)', () => {
    expect(formatAppContext({})).toBeNull()
  })

  it('treats empty strings as absent', () => {
    expect(formatAppContext({ route: '', videoId: '', lastError: '' })).toBeNull()
  })

  it('renders only the provided fields, wrapped in <app-context>', () => {
    const block = formatAppContext({ route: '/', projectId: 'p1' })
    expect(block).toMatch(/^<app-context>\n/)
    expect(block).toMatch(/\n<\/app-context>$/)
    expect(block).toContain('route: /')
    expect(block).toContain('projectId: p1')
    expect(block).not.toContain('videoId')
    expect(block).not.toContain('selectedNodeId')
  })

  it('renders every field in a stable order', () => {
    const block = formatAppContext({
      route: '/projects/p1/videos/v1',
      projectId: 'p1',
      videoId: 'v1',
      selectedNodeId: 'n1',
      selectedGenerationId: 'g1',
      lastError: 'content policy violation'
    })!
    const order = [
      'route: /projects/p1/videos/v1',
      'projectId: p1',
      'videoId: v1',
      'selectedNodeId: n1',
      'selectedGenerationId: g1',
      'lastGenerationError: content policy violation'
    ]
    let cursor = -1
    for (const line of order) {
      const at = block.indexOf(line)
      expect(at, line).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('flags the block as app-injected, not user-written', () => {
    expect(formatAppContext({ route: '/' })).toContain('not written by the user')
  })

  it('renders the nicheId when on a niche page', () => {
    expect(formatAppContext({ route: '/niches/n1', nicheId: 'n1' })).toContain('nicheId: n1')
  })
})

describe('formatRoadmapContext', () => {
  const niche: Niche = {
    id: 'n1',
    name: 'Finance EN',
    description: 'US retail investors',
    languageCode: 'en',
    locationCode: 2840,
    styleId: 'anime',
    aspectRatio: '16:9',
    targetSeconds: 480,
    createdAt: 0,
    updatedAt: 0
  }
  const item: NicheRoadmapItem = {
    id: 'i1',
    nicheId: 'n1',
    title: 'The title',
    titleVariants: ['Alt 1', 'Alt 2'],
    angle: 'the angle',
    description: 'yt description',
    thumbnailBrief: 'shocked trader',
    evidence: 'video X at 12x',
    videoType: 'long',
    status: 'in_production',
    videoId: 'v1',
    projectId: 'p1',
    publishedVideoId: null,
    published: null,
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0
  }
  const persona: VoicePersona = {
    id: 'vp1',
    name: 'Narrateur',
    voiceId: 'voice_123',
    description: 'calm, warm',
    nicheId: 'n1',
    createdAt: 0,
    updatedAt: 0
  }

  it('renders the full bridge: profile, packaging, evidence and voices', () => {
    const block = formatRoadmapContext({ niche, item, voicePersonas: [persona] })
    expect(block).toContain('NICHE CONTEXT')
    expect(block).toContain('Niche: Finance EN')
    expect(block).toContain('Positioning brief: US retail investors')
    expect(block).toContain('target length 480s — pass it to write_scenario')
    expect(block).toContain('Roadmap item: "The title" (long, status in_production)')
    expect(block).toContain('Title variants: Alt 1 | Alt 2')
    expect(block).toContain('Angle: the angle')
    expect(block).toContain('Evidence (the tracked videos proving demand): video X at 12x')
    expect(block).toContain('Thumbnail brief: shocked trader')
    expect(block).toContain('Narrateur = voice_123 (calm, warm)')
  })

  it('a short overrides the niche aspect with 9:16 and omits empty fields', () => {
    const block = formatRoadmapContext({
      niche: { ...niche, description: null, targetSeconds: null },
      item: {
        ...item,
        videoType: 'short',
        titleVariants: null,
        angle: null,
        evidence: null,
        description: null,
        thumbnailBrief: null
      },
      voicePersonas: []
    })
    expect(block).toContain('aspect 9:16 (short)')
    expect(block).not.toContain('Positioning brief')
    expect(block).not.toContain('Title variants')
    expect(block).not.toContain('Channel voices')
  })
})
