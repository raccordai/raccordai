import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@shared/ipc/contracts'
import { buildFcpxml, extForMime, type FcpxmlAudioTrack } from './fcpxml'

let seq = 0
function node(overrides: Partial<GraphNode> = {}): GraphNode {
  seq += 1
  return {
    id: `n${seq}`,
    videoId: 'v1',
    key: `node-${seq}`,
    modelId: 'bytedance/seedance-2',
    label: null,
    intent: null,
    position: { x: 0, y: 0 },
    params: {},
    selectedGenerationId: null,
    createdAt: seq,
    updatedAt: seq,
    ...overrides
  }
}

describe('buildFcpxml audio lanes', () => {
  const clip = {
    node: node({ label: 'Shot 1', params: { duration: 8 } }),
    mediaPath: 'media/01-shot_1.mp4',
    media: { width: 1920, height: 1080, duration: 8 }
  }

  function audioTrack(overrides: Partial<FcpxmlAudioTrack> = {}): FcpxmlAudioTrack {
    return {
      node: node({ modelId: 'elevenlabs/text-to-speech', label: 'VO 1' }),
      mediaPath: 'media/audio-01-vo_1.mp3',
      role: 'speech',
      duration: 4,
      startSec: 2,
      ...overrides
    }
  }

  it('connects each track to the first spine clip on its lane, at its start', () => {
    const xml = buildFcpxml('Film', [clip], {
      audio: [
        audioTrack(),
        audioTrack({
          node: node({ modelId: 'suno/generate-music', label: 'Bed' }),
          mediaPath: 'media/audio-02-bed.mp3',
          role: 'music',
          duration: 10,
          startSec: 0
        })
      ]
    })
    // Both audio assets are declared, and both connected clips live INSIDE the
    // first (and only) spine asset-clip — lane -2 speech, lane -1 music.
    expect(xml).toContain('src="media/audio-01-vo_1.mp3"')
    expect(xml).toContain('hasAudio="1"')
    const spineClip = xml.slice(xml.indexOf('<spine>'), xml.indexOf('</spine>'))
    expect(spineClip).toContain('lane="-2"')
    expect(spineClip).toContain('lane="-1"')
    expect(spineClip).toContain('audioRole="dialogue"')
    expect(spineClip).toContain('audioRole="music"')
    // 25 fps default: 2 s = frame 50 → "5000/2500s".
    expect(spineClip).toContain('offset="5000/2500s"')
    // The connected clips are children of the spine element (before its close).
    expect(spineClip.indexOf('lane="-2"')).toBeGreaterThan(spineClip.indexOf('<asset-clip '))
  })

  it('shifts connected offsets by the first clip trim in-point (parent-local time)', () => {
    const trimmed = {
      ...clip,
      node: node({ label: 'Shot 1', params: { duration: 8 }, trimStartSec: 1 })
    }
    const xml = buildFcpxml('Film', [trimmed], { audio: [audioTrack({ startSec: 2 })] })
    // Parent start = 1 s (frame 25): the 2 s mark is offset 75 in parent time.
    expect(xml).toContain('offset="7500/2500s"')
  })

  it('translates a track volume into an adjust-volume in dB', () => {
    const half = audioTrack({ node: node({ modelId: 'suno/generate-music', volume: 0.5 }) })
    const xml = buildFcpxml('Film', [clip], { audio: [half] })
    expect(xml).toContain('<adjust-volume amount="-6.0dB"/>')
  })

  it('audio without any video clip rides a silent gap', () => {
    const xml = buildFcpxml('Film', [], { audio: [audioTrack({ startSec: 0, duration: 4 })] })
    expect(xml).toContain('<gap name="Audio"')
    expect(xml).toContain('lane="-2"')
  })
})

describe('extForMime audio', () => {
  it('maps the common audio containers', () => {
    expect(extForMime('audio/mpeg')).toBe('mp3')
    expect(extForMime('audio/wav')).toBe('wav')
    expect(extForMime('audio/x-m4a')).toBe('m4a')
    expect(extForMime('audio/weird')).toBe('mp3')
  })
})
