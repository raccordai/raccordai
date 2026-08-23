import { describe, expect, it } from 'vitest'
import type { GraphNode } from './ipc/contracts'
import type { ResolvedTimelineEntry } from './timeline'
import {
  CROSSFADE_SECONDS,
  DEFAULT_CLIP_SECONDS,
  DEFAULT_STILL_SECONDS,
  audioLaneStarts,
  entryAtTimecode,
  bestGeneration,
  clipDuration,
  clipResolution,
  clipTransitionAfter,
  clipLook,
  clipSegments,
  clipSpeed,
  clipTimelineOffset,
  clipTrim,
  clipVolume,
  collectAudioNodes,
  collectTimelineClips,
  collectTimelineEntries,
  segmentTransitionAfter,
  segmentTrim,
  isStillClip,
  resolveTimeline,
  shotNumber,
  stillClipSeconds,
  stillMotionOf,
  timelineOrder,
  transitionOverlapSeconds,
  trimmedClipDuration
} from './timeline'

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

describe('shotNumber', () => {
  it('reads the first number in the label', () => {
    expect(shotNumber(node({ label: 'Clip — Shot 28' }))).toBe(28)
    expect(shotNumber(node({ label: '03 - finale' }))).toBe(3)
  })

  it('falls back to the key, then undefined', () => {
    expect(shotNumber(node({ label: null, key: 'shot-7' }))).toBe(7)
    expect(shotNumber(node({ label: 'intro', key: 'intro' }))).toBeUndefined()
  })
})

describe('timelineOrder', () => {
  it('sorts numbered nodes numerically (2 before 12), unnumbered last by position', () => {
    const a = node({ label: 'Shot 12' })
    const b = node({ label: 'Shot 2' })
    const c = node({ label: 'outro', key: 'outro', position: { x: 0, y: 10 } })
    const d = node({ label: 'intro', key: 'intro', position: { x: 0, y: 5 } })
    expect(timelineOrder([a, c, b, d]).map((n) => n.id)).toEqual([b.id, a.id, d.id, c.id])
  })

  it('breaks position ties on X', () => {
    const right = node({ label: 'x', key: 'x', position: { x: 10, y: 0 } })
    const left = node({ label: 'y', key: 'y', position: { x: 0, y: 0 } })
    expect(timelineOrder([right, left]).map((n) => n.id)).toEqual([left.id, right.id])
  })

  it('an explicit timelineOrder beats the label number and comes first', () => {
    const dragged = node({ label: 'Shot 9', timelineOrder: 0 })
    const alsoDragged = node({ label: 'Shot 1', timelineOrder: 1 })
    const legacy = node({ label: 'Shot 2' })
    expect(timelineOrder([legacy, alsoDragged, dragged]).map((n) => n.id)).toEqual([
      dragged.id,
      alsoDragged.id,
      legacy.id
    ])
  })
})

describe('clip trim', () => {
  it('defaults to the whole clip and clamps bad data', () => {
    expect(clipTrim(node({ params: { duration: 8 } }))).toEqual({ start: 0, end: 8 })
    // Negative in-point → 0; out-point beyond the media → raw end.
    expect(clipTrim(node({ params: { duration: 8 }, trimStartSec: -2, trimEndSec: 30 }))).toEqual({
      start: 0,
      end: 8
    })
    // Inverted window → ignored entirely.
    expect(clipTrim(node({ params: { duration: 8 }, trimStartSec: 5, trimEndSec: 3 }))).toEqual({
      start: 0,
      end: 8
    })
  })

  it('prefers the probed duration over the declared one', () => {
    expect(clipTrim(node({ params: { duration: 8 }, trimEndSec: 7 }), 7.6)).toEqual({
      start: 0,
      end: 7
    })
    expect(
      trimmedClipDuration(node({ params: { duration: 8 }, trimStartSec: 1 }), 7.6)
    ).toBeCloseTo(6.6)
  })

  it('trimmedClipDuration is undefined when nothing bounds the clip', () => {
    expect(trimmedClipDuration(node({ params: {} }))).toBeUndefined()
  })
})

describe('transitions', () => {
  it('reads the transition and sums the overlaps (last clip ignored)', () => {
    const a = node({ transitionAfter: 'crossfade' })
    const b = node({})
    const c = node({ transitionAfter: 'crossfade' })
    expect(clipTransitionAfter(a)).toBe('crossfade')
    expect(clipTransitionAfter(b)).toBeNull()
    // a→b crossfades; b→c cuts; c's transition has nothing after it.
    expect(transitionOverlapSeconds([a, b, c])).toBeCloseTo(CROSSFADE_SECONDS)
  })
})

describe('clipSpeed / clipLook / stillMotionOf', () => {
  it('clipSpeed defaults to 1 and clamps into 0.25–4', () => {
    expect(clipSpeed(node())).toBe(1)
    expect(clipSpeed(node({ speed: null }))).toBe(1)
    expect(clipSpeed(node({ speed: 0 }))).toBe(1)
    expect(clipSpeed(node({ speed: 2 }))).toBe(2)
    expect(clipSpeed(node({ speed: 0.1 }))).toBe(0.25)
    expect(clipSpeed(node({ speed: 99 }))).toBe(4)
  })

  it('clipLook / stillMotionOf only resolve registry ids', () => {
    expect(clipLook(node({ look: 'mono' }))).toBe('mono')
    expect(clipLook(node({ look: 'nope' }))).toBeNull()
    expect(clipLook(node())).toBeNull()
    expect(stillMotionOf(node({ stillMotion: 'pan-left' }))).toBe('pan-left')
    expect(stillMotionOf(node({ stillMotion: 'spin' }))).toBeNull()
  })
})

describe('split clips (segments & entries)', () => {
  it('a never-split node normalizes to ONE implicit segment from its columns', () => {
    const n = node({ trimStartSec: 1, trimEndSec: 5, transitionAfter: 'crossfade' })
    expect(clipSegments(n)).toEqual([
      {
        trimStartSec: 1,
        trimEndSec: 5,
        transitionAfter: 'crossfade',
        transitionDurationSec: null
      }
    ])
    expect(clipSegments(node({ segments: [] }))).toHaveLength(1)
  })

  it('collectTimelineEntries expands split nodes into adjacent entries', () => {
    const plain = node({ label: 'Shot 1' })
    const split = node({
      label: 'Shot 2',
      segments: [
        { trimStartSec: 0, trimEndSec: 3 },
        { trimStartSec: 3, trimEndSec: 6, transitionAfter: 'crossfade' }
      ]
    })
    const entries = collectTimelineEntries([split, plain])
    expect(entries.map((e) => e.entryId)).toEqual([
      `${plain.id}#0`,
      `${split.id}#0`,
      `${split.id}#1`
    ])
    expect(segmentTransitionAfter(entries[1]!.segment)).toBeNull()
    expect(segmentTransitionAfter(entries[2]!.segment)).toBe('crossfade')
  })

  it('segmentTrim clamps like clipTrim (inverted windows fall back whole)', () => {
    expect(segmentTrim({ trimStartSec: 1, trimEndSec: 4 }, 10)).toEqual({ start: 1, end: 4 })
    expect(segmentTrim({ trimStartSec: 2, trimEndSec: 99 }, 10)).toEqual({ start: 2, end: 10 })
    expect(segmentTrim({ trimStartSec: 5, trimEndSec: 2 }, 10)).toEqual({ start: 0, end: 10 })
  })
})

describe('audio lane layout', () => {
  it('clipTimelineOffset only accepts finite ≥ 0 values', () => {
    expect(clipTimelineOffset(node())).toBeNull()
    expect(clipTimelineOffset(node({ timelineOffsetSec: 2.5 }))).toBe(2.5)
    expect(clipTimelineOffset(node({ timelineOffsetSec: -1 }))).toBeNull()
  })

  it('chains offset-less tracks and places explicit offsets absolutely', () => {
    // Historical layout: no offsets → pure concatenation from 0.
    expect(
      audioLaneStarts([
        { offsetSec: null, durationSeconds: 5 },
        { offsetSec: null, durationSeconds: 3 }
      ])
    ).toEqual([0, 5])
    // An offset places its track; the next offset-less track chains after it.
    expect(
      audioLaneStarts([
        { offsetSec: null, durationSeconds: 5 },
        { offsetSec: 10, durationSeconds: 3 },
        { offsetSec: null, durationSeconds: 2 }
      ])
    ).toEqual([0, 10, 13])
  })
})

describe('clipVolume', () => {
  it('defaults to 1 when unset or garbage', () => {
    expect(clipVolume(node())).toBe(1)
    expect(clipVolume(node({ volume: null }))).toBe(1)
    expect(clipVolume(node({ volume: Number.NaN }))).toBe(1)
  })

  it('clamps into the 0–2 gain range', () => {
    expect(clipVolume(node({ volume: 0.5 }))).toBe(0.5)
    expect(clipVolume(node({ volume: -3 }))).toBe(0)
    expect(clipVolume(node({ volume: 9 }))).toBe(2)
  })
})

describe('collectTimelineClips', () => {
  it('keeps only video-kind model nodes', () => {
    const video = node({ label: 'Shot 1' })
    const image = node({ modelId: 'nano-banana-2' })
    const audio = node({ modelId: 'suno/generate-music' })
    const asset = node({ modelId: 'studio/asset' })
    const unknown = node({ modelId: 'ghost/none' })
    expect(collectTimelineClips([video, image, audio, asset, unknown]).map((n) => n.id)).toEqual([
      video.id
    ])
  })

  it('deduplicates a shot number: a node with a selected generation wins', () => {
    const failed = node({ label: 'Shot 1', updatedAt: 100 })
    const replacement = node({ label: 'Shot 1 bis', selectedGenerationId: 'g1', updatedAt: 50 })
    expect(collectTimelineClips([failed, replacement]).map((n) => n.id)).toEqual([replacement.id])
  })

  it('deduplicates on updatedAt when neither has a selection', () => {
    const old = node({ label: 'Shot 1', updatedAt: 10 })
    const fresh = node({ label: 'Shot 1 v2', updatedAt: 20 })
    expect(collectTimelineClips([old, fresh]).map((n) => n.id)).toEqual([fresh.id])
  })

  it('keeps all unnumbered clips', () => {
    const a = node({ label: 'intro', key: 'intro' })
    const b = node({ label: 'outro', key: 'outro' })
    expect(collectTimelineClips([a, b])).toHaveLength(2)
  })

  it('includes image/asset stills only when explicitly placed (timelineOrder)', () => {
    const video = node({ label: 'Shot 1' })
    const placedImage = node({ modelId: 'nano-banana-2', timelineOrder: 1 })
    const placedAsset = node({ modelId: 'studio/asset', timelineOrder: 2 })
    const workingImage = node({ modelId: 'nano-banana-2' })
    expect(
      collectTimelineClips([video, placedImage, placedAsset, workingImage]).map((n) => n.id)
    ).toEqual([placedImage.id, placedAsset.id, video.id])
  })
})

describe('stills', () => {
  it('isStillClip covers image models and asset nodes, never video', () => {
    expect(isStillClip(node({ modelId: 'nano-banana-2' }))).toBe(true)
    expect(isStillClip(node({ modelId: 'studio/asset' }))).toBe(true)
    expect(isStillClip(node())).toBe(false)
  })

  it('stillClipSeconds reads the trim window, defaulting to 5 s', () => {
    expect(stillClipSeconds(node())).toBe(DEFAULT_STILL_SECONDS)
    expect(stillClipSeconds(node({ trimEndSec: 7.5 }))).toBe(7.5)
    expect(stillClipSeconds(node({ trimStartSec: 1, trimEndSec: 7 }))).toBe(6)
    // Inverted window → default, like clipTrim's bad-data rule.
    expect(stillClipSeconds(node({ trimStartSec: 9, trimEndSec: 7 }))).toBe(DEFAULT_STILL_SECONDS)
  })
})

describe('collectAudioNodes', () => {
  it('returns only audio-kind nodes, in timeline order', () => {
    const music2 = node({ modelId: 'suno/generate-music', label: 'Music 2' })
    const music1 = node({ modelId: 'suno/generate-music', label: 'Music 1' })
    const video = node({ label: 'Shot 1' })
    expect(collectAudioNodes([music2, video, music1]).map((n) => n.id)).toEqual([
      music1.id,
      music2.id
    ])
  })
})

describe('resolveTimeline', () => {
  it('places entries with trims, speed and transition overlaps subtracted', () => {
    const a = node({ label: 'Shot 1', params: { duration: 8 }, trimStartSec: 1, trimEndSec: 7 })
    const b = node({
      label: 'Shot 2',
      params: { duration: 4 },
      speed: 2,
      transitionAfter: 'crossfade',
      transitionDurationSec: 0.5
    })
    const c = node({ label: 'Shot 3', params: { duration: 4 } })
    const resolved = resolveTimeline([c, a, b])
    // a: 6 s trimmed; b: 4 s / speed 2 = 2 s minus the 0.5 s crossfade into c.
    expect(resolved.entries.map((e) => [e.startSec, e.durationSec])).toEqual([
      [0, 6],
      [6, 1.5],
      [7.5, 4]
    ])
    expect(resolved.entries[1]).toMatchObject({
      speed: 2,
      transitionAfter: 'crossfade',
      transitionSec: 0.5,
      durationSource: 'declared'
    })
    // The last entry never carries a transition (nothing follows).
    expect(resolved.entries[2]!.transitionAfter).toBeNull()
    expect(resolved.totalSeconds).toBe(11.5)
  })

  it('prefers measured media durations and falls back to the default', () => {
    const measured = node({ label: 'Shot 1', params: { duration: 8 } })
    const bare = node({ label: 'Shot 2', params: {} })
    const resolved = resolveTimeline([measured, bare], { [measured.id]: 7.6 })
    expect(resolved.entries[0]).toMatchObject({ durationSec: 7.6, durationSource: 'measured' })
    expect(resolved.entries[1]).toMatchObject({
      durationSec: DEFAULT_CLIP_SECONDS,
      durationSource: 'default'
    })
  })

  it('lays audio lanes out like the render: chained, then absolute offsets', () => {
    const shot = node({ label: 'Shot 1', params: { duration: 10 } })
    const bed = node({ modelId: 'suno/generate-music', label: 'Music 1' })
    const vo = node({
      modelId: 'elevenlabs/text-to-speech',
      label: 'VO 1',
      timelineOffsetSec: 3.5,
      volume: 0.8
    })
    const resolved = resolveTimeline([shot, bed, vo], { [bed.id]: 20, [vo.id]: 4 })
    expect(resolved.music).toHaveLength(1)
    expect(resolved.music[0]).toMatchObject({
      startSec: 0,
      durationSec: 20,
      offsetSec: null,
      durationSource: 'measured'
    })
    expect(resolved.speech[0]).toMatchObject({
      startSec: 3.5,
      endSec: 7.5,
      offsetSec: 3.5,
      volume: 0.8,
      role: 'speech'
    })
  })

  it('a still slot lasts its trim window', () => {
    const still = node({ modelId: 'studio/asset', timelineOrder: 0, trimEndSec: 3 })
    const resolved = resolveTimeline([still])
    expect(resolved.entries[0]).toMatchObject({ still: true, durationSec: 3 })
  })
})

describe('bestGeneration', () => {
  const gens = [
    { id: 'g3', status: 'failed', url: null },
    { id: 'g2', status: 'success', url: 'media://generation/g2/result' },
    { id: 'g1', status: 'success', url: 'media://generation/g1/result' }
  ]

  it('returns the selected generation when it is a playable success', () => {
    expect(bestGeneration(node({ selectedGenerationId: 'g1' }), gens)?.id).toBe('g1')
  })

  it('falls back to the newest success when the selection is failed or stale', () => {
    expect(bestGeneration(node({ selectedGenerationId: 'g3' }), gens)?.id).toBe('g2')
    expect(bestGeneration(node({ selectedGenerationId: 'gone' }), gens)?.id).toBe('g2')
  })

  it('returns the selected failure when nothing succeeded (error display)', () => {
    const onlyFailed = [{ id: 'g9', status: 'failed', url: null }]
    expect(bestGeneration(node({ selectedGenerationId: 'g9' }), onlyFailed)?.id).toBe('g9')
    expect(bestGeneration(node(), onlyFailed)).toBeUndefined()
    expect(bestGeneration(node(), undefined)).toBeUndefined()
  })
})

describe('clipDuration / clipResolution', () => {
  it('reads numeric duration and formats resolution + aspect ratio', () => {
    const n = node({ params: { duration: 10, resolution: '1080p', aspect_ratio: '16:9' } })
    expect(clipDuration(n)).toBe(10)
    expect(clipResolution(n)).toBe('1080p · 16:9')
  })

  it('tolerates partial or missing params', () => {
    expect(clipDuration(node({ params: { duration: '10' } }))).toBeUndefined()
    expect(clipResolution(node({ params: { resolution: '720p' } }))).toBe('720p')
    expect(clipResolution(node({ params: { aspect_ratio: '9:16' } }))).toBe('9:16')
    expect(clipResolution(node({ params: {} }))).toBeUndefined()
  })
})

describe('entryAtTimecode', () => {
  const entry = (over: Partial<ResolvedTimelineEntry>): ResolvedTimelineEntry => ({
    nodeId: 'n1',
    nodeKey: 'node_1',
    label: null,
    modelId: 'bytedance/seedance-2-fast',
    segmentIndex: 0,
    still: false,
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    trimStartSec: 0,
    trimEndSec: null,
    speed: 1,
    transitionAfter: null,
    transitionSec: 0,
    durationSource: 'measured',
    ...over
  })

  it('maps a final timecode into the right entry and media time', () => {
    const entries = [
      entry({ nodeId: 'a', startSec: 0, endSec: 4, durationSec: 4, trimStartSec: 1 }),
      entry({ nodeId: 'b', startSec: 4, endSec: 9, durationSec: 5 })
    ]
    expect(entryAtTimecode(entries, 2)).toMatchObject({
      entry: { nodeId: 'a' },
      mediaSec: 3
    })
    expect(entryAtTimecode(entries, 4)).toMatchObject({ entry: { nodeId: 'b' }, mediaSec: 0 })
  })

  it('applies speed and clamps inside the trim window', () => {
    const entries = [
      entry({ trimStartSec: 2, trimEndSec: 6, speed: 2, startSec: 0, endSec: 2, durationSec: 2 })
    ]
    // 1.5s of timeline at 2x = 3s of media past the 2s in-point.
    expect(entryAtTimecode(entries, 1.5)?.mediaSec).toBeCloseTo(5)
    // The exact end clamps just short of the out-point instead of past it.
    expect(entryAtTimecode(entries, 2)?.mediaSec).toBeCloseTo(5.95)
  })

  it('resolves stills to media time 0 and rejects timecodes outside the film', () => {
    const entries = [entry({ still: true, startSec: 0, endSec: 3, durationSec: 3 })]
    expect(entryAtTimecode(entries, 1)).toMatchObject({ mediaSec: 0 })
    expect(entryAtTimecode(entries, -1)).toBeNull()
    expect(entryAtTimecode(entries, 3.5)).toBeNull()
    expect(entryAtTimecode([], 0)).toBeNull()
  })
})
