import { describe, expect, it } from 'vitest'
import { STYLES } from '../styles/registry'
import {
  ANTI_AI_TERMS,
  BOOSTER_STACKS,
  CAMERA_MODES,
  CAPTURE_DECLARATIONS,
  FOV_STEPS,
  MAX_CAPS_TRANSIENTS,
  ONER_DECLARATIONS,
  SHOT_SIZES,
  beatCountFor,
  beatRanges,
  bracketFor,
  buildSeedanceBody,
  buildSeedancePrompt,
  countCapsTransients,
  detectCameraDoctrines,
  findAntiAiTerms,
  getBoosterStack,
  getCaptureDeclaration,
  hasCaptureDeclaration,
  hasRampSpine,
  mentionsSpeedRamp,
  snapFov,
  wrapSeedanceSandwich
} from './seedance'

describe('capture declarations', () => {
  it('have unique ids and resolve by id', () => {
    const ids = CAPTURE_DECLARATIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of CAPTURE_DECLARATIONS) expect(getCaptureDeclaration(d.id)).toBe(d)
    expect(getCaptureDeclaration('nope')).toBeUndefined()
  })

  it('stay inside the 15-40 word window that makes them a selector', () => {
    for (const d of CAPTURE_DECLARATIONS) {
      const words = d.text.trim().split(/\s+/).length
      // Longer and it stops selecting a domain and starts being noise.
      expect(words, `${d.id}: ${words} words`).toBeGreaterThanOrEqual(15)
      expect(words, `${d.id}: ${words} words`).toBeLessThanOrEqual(60)
    }
  })

  it('open on a noun of provenance, never on an adjective of quality', () => {
    for (const d of CAPTURE_DECLARATIONS) {
      expect(findAntiAiTerms(d.text, d.mode), `${d.id}`).toEqual([])
      expect(hasCaptureDeclaration(d.text), `${d.id}: own medium not detectable`).toBe(true)
    }
  })

  it('name their own camera doctrine and never the other one', () => {
    for (const d of CAPTURE_DECLARATIONS) {
      const found = detectCameraDoctrines(d.text)
      expect(found.embodied && found.disembodied, `${d.id}: declares a body AND a ghost`).toBe(
        false
      )
      // A ghost has to be declared explicitly — an undeclared camera drifts.
      if (d.doctrine === 'disembodied') expect(found.disembodied, `${d.id}`).toBe(true)
    }
  })

  it('point at a booster stack that exists and matches their register', () => {
    for (const d of CAPTURE_DECLARATIONS) {
      const booster = getBoosterStack(d.boosterId)
      expect(booster, `${d.id}: unknown booster ${d.boosterId}`).toBeDefined()
      // A kinetic declaration cannot close on a documentary stack.
      if (d.mode === 'kinetic') expect(booster!.mode).toBe('kinetic')
    }
  })

  it('declares ramping up front on every kinetic declaration', () => {
    for (const d of CAPTURE_DECLARATIONS.filter((x) => x.mode === 'kinetic')) {
      expect(hasRampSpine(d.text), `${d.id}: ramps not declared as the governing style`).toBe(true)
    }
  })
})

describe('booster stacks', () => {
  it('have unique ids and are all used by at least one declaration', () => {
    const ids = BOOSTER_STACKS.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    const used = new Set(CAPTURE_DECLARATIONS.map((d) => d.boosterId))
    for (const id of ids)
      expect(used.has(id), `booster "${id}" is used by no declaration`).toBe(true)
  })

  it('re-state the medium rather than adding adjectives of quality', () => {
    for (const b of BOOSTER_STACKS) {
      expect(findAntiAiTerms(b.text, b.mode), `${b.id}`).toEqual([])
    }
  })
})

describe('camera modes', () => {
  it('have unique ids and brackets', () => {
    expect(new Set(CAMERA_MODES.map((m) => m.id)).size).toBe(CAMERA_MODES.length)
    expect(new Set(CAMERA_MODES.map((m) => m.bracket)).size).toBe(CAMERA_MODES.length)
    for (const m of CAMERA_MODES) expect(m.bracket).toMatch(/^\[.+\]$/)
  })

  it('bind the kinetic family to the ghost and the handheld family to a body', () => {
    for (const m of CAMERA_MODES) {
      if (m.family === 'kinetic') expect(m.doctrine, m.id).toBe('disembodied')
      if (m.family === 'handheld') expect(m.doctrine, m.id).toBe('embodied')
    }
  })

  it('never hands back a bracket that contradicts the doctrine', () => {
    // A handheld bracket asked for under the ghost falls back to a legal one.
    const ghostBracket = bracketFor('close-handheld-tracking', 'disembodied')
    expect(CAMERA_MODES.find((m) => m.bracket === ghostBracket)?.doctrine).toBe('disembodied')
    expect(bracketFor('slow-orbit', 'embodied')).toBe('[Slow Continuous Orbit]')
    expect(bracketFor('nope', 'embodied')).toMatch(/^\[.+\]$/)
  })
})

describe('optics', () => {
  it('snaps an arbitrary FOV onto a declared step', () => {
    expect(snapFov(23)).toBe(18)
    expect(snapFov(50)).toBe(47)
    expect(snapFov(1)).toBe(8)
    for (const step of FOV_STEPS) expect(snapFov(step.degrees)).toBe(step.degrees)
  })

  it('declares shot sizes with what is in frame', () => {
    expect(new Set(SHOT_SIZES.map((s) => s.id)).size).toBe(SHOT_SIZES.length)
    for (const s of SHOT_SIZES) expect(s.inFrame.length).toBeGreaterThan(5)
  })
})

describe('the anti-AI lexicon', () => {
  it('matches whole words only', () => {
    expect(findAntiAiTerms('an epic wide shot', 'flow').map((t) => t.term)).toContain('epic')
    // "epicentre" is not "epic".
    expect(findAntiAiTerms('the epicentre of the blast', 'flow')).toEqual([])
  })

  it('is register-aware: what fights a medium declaration is fine in stylized work', () => {
    expect(findAntiAiTerms('epic scale, 8K', 'flow').length).toBeGreaterThan(0)
    expect(findAntiAiTerms('epic scale, 8K', 'kinetic')).toEqual([])
  })

  it('with no register, only reports what hurts everywhere', () => {
    expect(findAntiAiTerms('epic scale', undefined)).toEqual([])
    expect(findAntiAiTerms('a beautiful shot', undefined).map((t) => t.term)).toEqual(['beautiful'])
  })

  it('proposes a replacement for every term', () => {
    for (const t of ANTI_AI_TERMS) {
      expect(t.instead.length, t.term).toBeGreaterThan(5)
      expect(t.modes.length, t.term).toBeGreaterThan(0)
    }
  })
})

describe('doctrine detection', () => {
  it('reads a body, a ghost, or the ugly middle', () => {
    expect(detectCameraDoctrines('heavy shoulder-mounted handheld shake')).toEqual({
      embodied: true,
      disembodied: false
    })
    expect(detectCameraDoctrines('the camera is a weightless invisible presence')).toEqual({
      embodied: false,
      disembodied: true
    })
    const mixed = detectCameraDoctrines(
      'handheld, and the camera is a weightless invisible presence'
    )
    expect(mixed.embodied && mixed.disembodied).toBe(true)
  })

  it('separates asking for a ramp from declaring ramping', () => {
    const beatOnly = '3-6s: [Ramp Into the Kill] the blade ramps into extreme slow motion.'
    expect(mentionsSpeedRamp(beatOnly)).toBe(true)
    expect(hasRampSpine(beatOnly)).toBe(false)
    const declared = `Single continuous take with aggressive in-camera speed ramps. ${beatOnly}`
    expect(hasRampSpine(declared)).toBe(true)
  })

  it('counts uppercase transients without counting shot-size abbreviations', () => {
    expect(countCapsTransients('ECU on the hand, MCU on the face, FOV 18°')).toBe(0)
    expect(countCapsTransients('SNAP IN. CRASH ZOOM. HOLD.')).toBe(3)
    // The sandwich's own section headers are structure, not shouting.
    expect(countCapsTransients('[STYLE + CAMERA + ATMOSPHERE]\n[TIMELINE]\n[AUDIO]')).toBe(0)
    expect(MAX_CAPS_TRANSIENTS).toBe(6)
  })
})

describe('the sandwich', () => {
  const body = buildSeedanceBody({
    beats: [
      { from: 0, to: 3, bracket: '[Slow Dolly Push-In]', action: 'She steps into the doorway.' },
      { from: 3, to: 6, bracket: '[Slow Dolly Push-In]', action: 'She stops and looks back.' }
    ],
    audio: 'Rain on the metal roof. Natural sound only, no music.'
  })

  it('builds a bracketed timeline with one camera mode per beat', () => {
    expect(body).toContain('[TIMELINE]')
    expect(body).toContain('0-3s: [Slow Dolly Push-In]')
    expect(body).toContain('3-6s: [Slow Dolly Push-In]')
    expect(body).toContain('[AUDIO]')
  })

  it('keeps the declaration and the booster OUT of the stored body', () => {
    // They are provenance and texture enforcement: they belong to the video's
    // art direction and are composed in at payload time.
    expect(body).not.toContain('[STYLE + CAMERA + ATMOSPHERE]')
    expect(body).not.toContain('[STYLE & QUALITY BOOSTERS]')
  })

  it('wraps declaration on top, body in the middle, booster at the bottom', () => {
    const wrapped = wrapSeedanceSandwich(body, {
      declaration: 'Gritty 16mm cinéma vérité.',
      lookCompact: 'Available natural light, honest textures.',
      booster: 'Photorealistic 16mm film emulation, heavy organic grain.'
    })
    expect(wrapped.indexOf('[STYLE + CAMERA + ATMOSPHERE]')).toBe(0)
    expect(wrapped.indexOf('[TIMELINE]')).toBeGreaterThan(
      wrapped.indexOf('[STYLE + CAMERA + ATMOSPHERE]')
    )
    expect(wrapped.indexOf('[STYLE & QUALITY BOOSTERS]')).toBeGreaterThan(
      wrapped.indexOf('[TIMELINE]')
    )
  })

  it('never stacks two universes on a re-wrap', () => {
    const spec = { declaration: 'Gritty 16mm cinéma vérité.', booster: 'Heavy organic grain.' }
    const once = wrapSeedanceSandwich(body, spec)
    expect(wrapSeedanceSandwich(once, spec)).toBe(once)
    expect(
      wrapSeedanceSandwich(once, { declaration: 'Raw found footage style.', booster: 'Other.' })
    ).toBe(once)
  })

  it('says a oner three times, in its three places', () => {
    const oner = buildSeedancePrompt({
      beats: [{ from: 0, to: 5, bracket: '[Steadicam Glide]', action: 'He walks the corridor.' }],
      oner: true,
      declaration: 'Photorealistic 35mm cinema.',
      booster: 'Fine grain.'
    })
    expect(oner).toContain(ONER_DECLARATIONS.opening)
    expect(oner).toContain(ONER_DECLARATIONS.timeline)
    expect(oner).toContain(ONER_DECLARATIONS.booster)
  })

  it('survives an empty body', () => {
    const wrapped = wrapSeedanceSandwich('', { declaration: 'A.', booster: 'B.' })
    expect(wrapped).toBe('[STYLE + CAMERA + ATMOSPHERE]\nA.\n\n[STYLE & QUALITY BOOSTERS]\nB.')
  })
})

describe('beat arithmetic', () => {
  it('matches the beat count to the clip length', () => {
    expect(beatCountFor(4)).toBe(2)
    expect(beatCountFor(8)).toBe(3)
    expect(beatCountFor(12)).toBe(4)
    expect(beatCountFor(15)).toBe(5)
  })

  it('covers the clip exactly once, contiguously', () => {
    for (const seconds of [4, 5, 6, 8, 10, 12, 15]) {
      const ranges = beatRanges(seconds, beatCountFor(seconds))
      expect(ranges[0]!.from).toBe(0)
      expect(ranges.at(-1)!.to).toBe(seconds)
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i]!.from, `${seconds}s: gap at beat ${i + 1}`).toBe(ranges[i - 1]!.to)
      }
    }
  })
})

describe('every art direction is anchored to the doctrine', () => {
  it('names a declaration that exists and a compressed bible that fits the opening', () => {
    for (const style of STYLES) {
      const declaration = getCaptureDeclaration(style.captureId)
      expect(declaration, `${style.id}: unknown captureId ${style.captureId}`).toBeDefined()
      const words = style.styleBibleCompact.trim().split(/\s+/).length
      expect(words, `${style.id}: compact bible is ${words} words`).toBeLessThanOrEqual(45)
      expect(words, `${style.id}: compact bible is ${words} words`).toBeGreaterThanOrEqual(10)
      // The compression must not smuggle the anti-AI lexicon back in.
      expect(findAntiAiTerms(style.styleBibleCompact, declaration!.mode), style.id).toEqual([])
    }
  })

  it('covers both camera doctrines across the catalogue', () => {
    const doctrines = new Set(STYLES.map((s) => getCaptureDeclaration(s.captureId)!.doctrine))
    expect(doctrines.has('embodied')).toBe(true)
    expect(doctrines.has('disembodied')).toBe(true)
  })
})
