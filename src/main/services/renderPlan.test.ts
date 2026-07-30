import { describe, expect, it } from 'vitest'
import {
  buildConcatArgs,
  buildConcatListContent,
  buildLastFrameArgs,
  buildMuxArgs,
  buildNormalizeArgs,
  canConcatLosslessly,
  computeStageSpans,
  decideSequenceSpec,
  overallPercent,
  parseFfprobeJson,
  parseProgressLine,
  sequenceDurationSeconds,
  type ClipProbe,
  type PlannedClip
} from './renderPlan'

function probe(overrides: Partial<ClipProbe> = {}): ClipProbe {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 24,
    durationSeconds: 5,
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    ...overrides
  }
}

function clip(overrides: Partial<PlannedClip> = {}): PlannedClip {
  return {
    path: '/media/a.mp4',
    isStill: false,
    stillDurationSeconds: 5,
    probe: probe(),
    ...overrides
  }
}

describe('parseFfprobeJson', () => {
  it('extracts codec, dimensions, fps, duration and audio info', () => {
    const parsed = parseFfprobeJson({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          avg_frame_rate: '30000/1001',
          r_frame_rate: '30/1'
        },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100' }
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '7.42' }
    })
    expect(parsed.codec).toBe('h264')
    expect(parsed.width).toBe(1280)
    expect(parsed.height).toBe(720)
    expect(parsed.fps).toBeCloseTo(29.97, 2)
    expect(parsed.durationSeconds).toBeCloseTo(7.42)
    expect(parsed.hasAudio).toBe(true)
    expect(parsed.audioCodec).toBe('aac')
    expect(parsed.audioSampleRate).toBe(44100)
  })

  it('falls back to r_frame_rate and the video stream duration', () => {
    const parsed = parseFfprobeJson({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          avg_frame_rate: '0/0',
          r_frame_rate: '25/1',
          duration: '3.5'
        }
      ],
      format: { format_name: 'webm' }
    })
    expect(parsed.fps).toBe(25)
    expect(parsed.durationSeconds).toBe(3.5)
    expect(parsed.hasAudio).toBe(false)
  })

  it('survives garbage input', () => {
    const parsed = parseFfprobeJson(null)
    expect(parsed.codec).toBeNull()
    expect(parsed.fps).toBeNull()
    expect(parsed.durationSeconds).toBeNull()
    expect(parsed.hasAudio).toBe(false)
  })
})

describe('decideSequenceSpec', () => {
  it('uses the first real video clip and rounds dimensions down to even', () => {
    const clips = [
      clip({ isStill: true, probe: null }),
      clip({ probe: probe({ width: 1081, height: 607, fps: 30 }) })
    ]
    expect(decideSequenceSpec(clips)).toEqual({ width: 1080, height: 606, fps: 30 })
  })

  it('applies overrides per field and defaults to 1080p24 for stills-only', () => {
    expect(decideSequenceSpec([clip({ isStill: true, probe: null })])).toEqual({
      width: 1920,
      height: 1080,
      fps: 24
    })
    expect(
      decideSequenceSpec([clip()], { fps: 30, resolution: { width: 720, height: 1280 } })
    ).toEqual({ width: 720, height: 1280, fps: 30 })
  })
})

describe('canConcatLosslessly', () => {
  const spec = { width: 1920, height: 1080, fps: 24 }

  it('accepts homogeneous h264 mp4 clips', () => {
    expect(canConcatLosslessly([clip(), clip({ path: '/media/b.mp4' })], spec)).toBe(true)
  })

  it('rejects stills, codec/resolution/fps/audio mismatches and non-mp4 containers', () => {
    expect(canConcatLosslessly([], spec)).toBe(false)
    expect(canConcatLosslessly([clip(), clip({ isStill: true, probe: null })], spec)).toBe(false)
    expect(canConcatLosslessly([clip({ probe: probe({ codec: 'vp9' }) })], spec)).toBe(false)
    expect(canConcatLosslessly([clip({ probe: probe({ formatName: 'webm' }) })], spec)).toBe(false)
    expect(canConcatLosslessly([clip({ probe: probe({ width: 1280, height: 720 }) })], spec)).toBe(
      false
    )
    expect(canConcatLosslessly([clip({ probe: probe({ fps: 25 }) })], spec)).toBe(false)
    expect(
      canConcatLosslessly(
        [clip(), clip({ probe: probe({ hasAudio: false, audioCodec: null }) })],
        spec
      )
    ).toBe(false)
    expect(
      canConcatLosslessly([clip(), clip({ probe: probe({ audioSampleRate: 44100 }) })], spec)
    ).toBe(false)
  })

  it('accepts uniformly silent clips and tolerates tiny fps drift', () => {
    const silent = probe({ hasAudio: false, audioCodec: null, audioSampleRate: null })
    expect(
      canConcatLosslessly(
        [clip({ probe: silent }), clip({ probe: { ...silent, fps: 24.001 } })],
        spec
      )
    ).toBe(true)
  })
})

describe('sequenceDurationSeconds', () => {
  it('sums probed video durations and still holds', () => {
    const clips = [
      clip({ probe: probe({ durationSeconds: 5.5 }) }),
      clip({ isStill: true, probe: null, stillDurationSeconds: 4 }),
      clip({ probe: probe({ durationSeconds: null }) })
    ]
    expect(sequenceDurationSeconds(clips)).toBeCloseTo(9.5)
  })
})

describe('buildNormalizeArgs', () => {
  const spec = { width: 1280, height: 720, fps: 24 }

  it('scales, pads and re-encodes a video clip with audio', () => {
    const args = buildNormalizeArgs(clip(), spec, '/tmp/seg.mp4')
    expect(args).toContain('/media/a.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('scale=1280:720:force_original_aspect_ratio=decrease')
    expect(filter).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black')
    expect(filter).toContain('fps=24')
    expect(args).toContain('libx264')
    expect(args.join(' ')).toContain('-map [v] -map 0:a')
    expect(args).not.toContain('-shortest')
    expect(args.at(-1)).toBe('/tmp/seg.mp4')
  })

  it('adds a finite silent track to silent clips (-shortest)', () => {
    const args = buildNormalizeArgs(
      clip({ probe: probe({ hasAudio: false, audioCodec: null }) }),
      spec,
      '/tmp/seg.mp4'
    )
    expect(args.join(' ')).toContain('anullsrc')
    expect(args.join(' ')).toContain('-map [v] -map 1:a')
    expect(args).toContain('-shortest')
  })

  it('loops a still for its slot duration with silence of the same length', () => {
    const args = buildNormalizeArgs(
      clip({ isStill: true, probe: null, stillDurationSeconds: 6, path: '/media/still.png' }),
      spec,
      '/tmp/seg.mp4'
    )
    const joined = args.join(' ')
    expect(joined).toContain('-loop 1 -t 6 -i /media/still.png')
    expect(joined).toContain('-t 6 -i anullsrc')
    expect(args).not.toContain('-shortest')
  })

  it('formats fractional fps with 3 decimals', () => {
    const args = buildNormalizeArgs(clip(), { ...spec, fps: 29.97002997 }, '/tmp/seg.mp4')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('fps=29.970')
  })
})

describe('concat helpers', () => {
  it('escapes single quotes in the list file', () => {
    expect(buildConcatListContent(["/tmp/l'été.mp4", '/tmp/b.mp4'])).toBe(
      "file '/tmp/l'\\''été.mp4'\nfile '/tmp/b.mp4'\n"
    )
  })

  it('builds a stream-copy concat command', () => {
    const args = buildConcatArgs('/tmp/list.txt', '/tmp/out.mp4')
    const joined = args.join(' ')
    expect(joined).toContain('-f concat -safe 0 -i /tmp/list.txt -c copy')
    expect(args.at(-1)).toBe('/tmp/out.mp4')
  })
})

describe('buildLastFrameArgs', () => {
  it('seeks from the end and writes exactly one image', () => {
    const args = buildLastFrameArgs('/tmp/gen-1.mp4', '/tmp/frame-1.jpg')
    const joined = args.join(' ')
    expect(joined).toContain('-sseof -0.1 -i /tmp/gen-1.mp4')
    expect(joined).toContain('-frames:v 1')
    expect(joined).toContain('-update 1')
    expect(args.at(-1)).toBe('/tmp/frame-1.jpg')
  })
})

describe('buildMuxArgs', () => {
  it('mixes a single music track over video audio, capped at the sequence duration', () => {
    const args = buildMuxArgs('/tmp/video.mp4', ['/tmp/music.mp3'], true, 12.5, '/tmp/out.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toBe('[1:a]apad[mpad];[0:a][mpad]amix=inputs=2:duration=first:normalize=0[mix]')
    const joined = args.join(' ')
    expect(joined).toContain('-map 0:v -map [mix] -c:v copy')
    expect(joined).toContain('-t 12.500')
  })

  it('chains multiple music tracks and maps them directly on a silent video', () => {
    const args = buildMuxArgs('/tmp/video.mp4', ['/a.mp3', '/b.mp3'], false, 20, '/tmp/out.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a][2:a]concat=n=2:v=0:a=1[mcat]')
    expect(filter).toContain('[mcat]apad[mpad]')
    expect(filter).not.toContain('amix')
    expect(args.join(' ')).toContain('-map 0:v -map [mpad]')
  })
})

describe('progress mapping', () => {
  it('parses -progress output lines (out_time_us/ms are microseconds)', () => {
    expect(parseProgressLine('out_time_us=1500000')).toBe(1.5)
    expect(parseProgressLine('out_time_ms=2500000')).toBe(2.5)
    expect(parseProgressLine('out_time=00:01:30.500000')).toBeCloseTo(90.5)
    expect(parseProgressLine('frame=42')).toBeNull()
  })

  it('allocates stage budgets that always end at 100', () => {
    for (const normalize of [true, false]) {
      for (const music of [true, false]) {
        const spans = computeStageSpans(normalize, music)
        expect(spans.at(-1)!.to).toBeCloseTo(100)
        expect(spans[0]!.from).toBe(0)
        expect(spans.some((s) => s.step === 'mux')).toBe(music)
        expect(spans.some((s) => s.step === 'normalize')).toBe(normalize)
      }
    }
  })

  it('maps a stage-local fraction to the overall percent, clamped', () => {
    const spans = computeStageSpans(true, true)
    expect(overallPercent(spans, 'probe', 0)).toBe(0)
    expect(overallPercent(spans, 'normalize', 0.5)).toBe(37)
    expect(overallPercent(spans, 'mux', 2)).toBe(100)
    expect(overallPercent(spans, 'concat', -1)).toBe(overallPercent(spans, 'concat', 0))
    expect(overallPercent(computeStageSpans(false, false), 'mux', 0.5)).toBe(0)
  })
})
