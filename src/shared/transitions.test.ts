import { describe, expect, it } from 'vitest'
import enCommon from './i18n/locales/en/common.json'
import frCommon from './i18n/locales/fr/common.json'
import {
  CLIP_TRANSITIONS,
  CLIP_TRANSITION_IDS,
  TRANSITION_DEFAULT_SECONDS,
  TRANSITION_MAX_SECONDS,
  TRANSITION_MIN_SECONDS,
  clampTransitionSeconds,
  isClipTransitionId,
  xfadeNameFor
} from './transitions'

/**
 * The xfade transitions shipped by the bundled ffmpeg (6.x, ffmpeg-static).
 * An id mapped outside this list would silently render as a plain fade.
 */
const FFMPEG_XFADE_NAMES = new Set([
  'fade',
  'fadeblack',
  'fadewhite',
  'fadegrays',
  'distance',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'rectcrop',
  'circlecrop',
  'circleclose',
  'circleopen',
  'horzclose',
  'horzopen',
  'vertclose',
  'vertopen',
  'diagbl',
  'diagbr',
  'diagtl',
  'diagtr',
  'hlslice',
  'hrslice',
  'vuslice',
  'vdslice',
  'dissolve',
  'pixelize',
  'radial',
  'hblur',
  'wipetl',
  'wipetr',
  'wipebl',
  'wipebr',
  'squeezeh',
  'squeezev',
  'zoomin',
  'fadefast',
  'fadeslow'
])

const LOCALES = [
  ['fr', frCommon],
  ['en', enCommon]
] as const

describe('CLIP_TRANSITIONS registry', () => {
  it('has unique ids', () => {
    expect(new Set(CLIP_TRANSITION_IDS).size).toBe(CLIP_TRANSITION_IDS.length)
  })

  it('maps every id to an xfade the bundled ffmpeg actually ships', () => {
    for (const t of CLIP_TRANSITIONS) {
      expect(FFMPEG_XFADE_NAMES.has(t.xfade), `${t.id} → ${t.xfade}`).toBe(true)
    }
  })

  it('every transition has a label in both locales, and no orphan label survives', () => {
    for (const [locale, resource] of LOCALES) {
      const labels = (resource as { timeline: { transitions: Record<string, string> } }).timeline
        .transitions
      for (const id of CLIP_TRANSITION_IDS) {
        expect(typeof labels[id], `${locale}: timeline.transitions.${id}`).toBe('string')
      }
      for (const key of Object.keys(labels)) {
        expect(isClipTransitionId(key), `${locale}: orphan label timeline.transitions.${key}`).toBe(
          true
        )
      }
    }
  })

  it('resolves ids and falls back to a plain fade on unknown ones', () => {
    expect(xfadeNameFor('crossfade')).toBe('fade')
    expect(xfadeNameFor('zoomin')).toBe('zoomin')
    expect(xfadeNameFor('not-a-transition')).toBe('fade')
    expect(isClipTransitionId('radial')).toBe(true)
    expect(isClipTransitionId(null)).toBe(false)
  })

  it('clamps durations into the shared bounds', () => {
    expect(clampTransitionSeconds(undefined)).toBe(TRANSITION_DEFAULT_SECONDS)
    expect(clampTransitionSeconds(0)).toBe(TRANSITION_MIN_SECONDS)
    expect(clampTransitionSeconds(99)).toBe(TRANSITION_MAX_SECONDS)
    expect(clampTransitionSeconds(1.2)).toBe(1.2)
  })
})
