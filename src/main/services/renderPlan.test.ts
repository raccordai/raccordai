import { describe, expect, it } from 'vitest'
import {
  CROSSFADE_DURATION,
  buildConcatArgs,
  buildConcatListContent,
  buildCrossfadeArgs,
  buildLastFrameArgs,
  buildMuxArgs,
  assColor,
  buildAssContent,
  buildSubtitleBurnArgs,
  clipEffectiveDuration,
  clipIsTrimmed,
  crossfadeGroups,
  escapeSubtitlesFilterPath,
  extractDialogue,
  formatAssTimestamp,
  escapeAssText,
  hasCrossfades,
  renderedDurationSeconds,
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
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/tmp/music.mp3' }],
      true,
      12.5,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toBe('[1:a]apad[mpad];[0:a][mpad]amix=inputs=2:duration=first:normalize=0[mix]')
    const joined = args.join(' ')
    expect(joined).toContain('-map 0:v -map [mix] -c:v copy')
    expect(joined).toContain('-t 12.500')
  })

  it('chains multiple music tracks and maps them directly on a silent video', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3' }, { path: '/b.mp3' }],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a][2:a]concat=n=2:v=0:a=1[mcat]')
    expect(filter).toContain('[mcat]apad[mpad]')
    expect(filter).not.toContain('amix')
    expect(args.join(' ')).toContain('-map 0:v -map [mpad]')
  })

  it('trims a single track through atrim and rebases its timestamps', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3', trimStartSec: 2, trimEndSec: 9.5 }],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a]atrim=start=2:end=9.5,asetpts=PTS-STARTPTS[t1]')
    expect(filter).toContain('[t1]apad[mpad]')
  })

  it('only trimmed tracks go through atrim in a chained lane', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3', trimEndSec: 8 }, { path: '/b.mp3' }],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a]atrim=start=0:end=8,asetpts=PTS-STARTPTS[t1]')
    expect(filter).toContain('[t1][2:a]concat=n=2:v=0:a=1[mcat]')
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

describe('trim on planned clips', () => {
  it('detects a trimmed clip and computes its effective duration', () => {
    expect(clipIsTrimmed(clip())).toBe(false)
    expect(clipIsTrimmed(clip({ trimStartSec: 1 }))).toBe(true)
    expect(clipIsTrimmed(clip({ trimEndSec: 4 }))).toBe(true)
    // An out-point equal to the media end is not a trim.
    expect(clipIsTrimmed(clip({ trimEndSec: 5 }))).toBe(false)

    expect(clipEffectiveDuration(clip())).toBe(5)
    expect(clipEffectiveDuration(clip({ trimStartSec: 1, trimEndSec: 4 }))).toBe(3)
    expect(clipEffectiveDuration(clip({ isStill: true, stillDurationSeconds: 7 }))).toBe(7)
  })

  it('a trim forces the normalize path even on homogeneous clips', () => {
    const clips = [clip(), clip({ trimStartSec: 1 })]
    const spec = decideSequenceSpec(clips)
    expect(canConcatLosslessly(clips, spec)).toBe(false)
    expect(canConcatLosslessly([clip(), clip()], spec)).toBe(true)
  })

  it('buildNormalizeArgs seeks and bounds a trimmed clip', () => {
    const args = buildNormalizeArgs(
      clip({ trimStartSec: 1.5, trimEndSec: 4 }),
      { width: 1920, height: 1080, fps: 24 },
      '/tmp/seg.mp4'
    )
    const joined = args.join(' ')
    expect(joined).toContain('-ss 1.500')
    expect(joined).toContain('-t 2.500 -i /media/a.mp4')
  })
})

describe('crossfades', () => {
  it('groups consecutive crossfaded clips, cuts split the groups', () => {
    const a = clip({ transitionAfter: 'crossfade' })
    const b = clip({ transitionAfter: 'crossfade' })
    const c = clip({})
    const d = clip({})
    expect(crossfadeGroups([a, b, c, d])).toEqual([[0, 1, 2], [3]])
    expect(hasCrossfades([a, b, c, d])).toBe(true)
    expect(hasCrossfades([c, d])).toBe(false)
    // The LAST clip's transition points at nothing.
    expect(hasCrossfades([c, a])).toBe(false)
  })

  it('a crossfade forces the normalize path', () => {
    const clips = [clip({ transitionAfter: 'crossfade' }), clip()]
    expect(canConcatLosslessly(clips, decideSequenceSpec(clips))).toBe(false)
  })

  it('renderedDurationSeconds subtracts one overlap per crossfade', () => {
    const clips = [clip({ transitionAfter: 'crossfade' }), clip(), clip()]
    expect(sequenceDurationSeconds(clips)).toBe(15)
    expect(renderedDurationSeconds(clips)).toBeCloseTo(15 - CROSSFADE_DURATION)
  })

  it('buildCrossfadeArgs chains per-pair transitions with measured offsets', () => {
    const args = buildCrossfadeArgs(
      [
        { path: '/tmp/s1.mp4', durationSeconds: 5 },
        { path: '/tmp/s2.mp4', durationSeconds: 4 },
        { path: '/tmp/s3.mp4', durationSeconds: 6 }
      ],
      [
        { xfade: 'fade', durationSec: 0.5 },
        { xfade: 'wipeleft', durationSec: 1 }
      ],
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    // First fade starts 0.5s before segment 1 ends; the second cut is a 1s wipe
    // whose offset accounts for the first overlap (5+4-0.5-1 = 7.5).
    expect(filter).toContain('xfade=transition=fade:duration=0.5:offset=4.500')
    expect(filter).toContain('xfade=transition=wipeleft:duration=1:offset=7.500')
    expect(filter).toContain('acrossfade=d=0.5')
    expect(filter).toContain('acrossfade=d=1')
    expect(args.at(-1)).toBe('/tmp/out.mp4')
    expect(() =>
      buildCrossfadeArgs([{ path: '/tmp/s1.mp4', durationSeconds: 5 }], [], '/x')
    ).toThrow()
    expect(() =>
      buildCrossfadeArgs(
        [
          { path: '/tmp/s1.mp4', durationSeconds: 5 },
          { path: '/tmp/s2.mp4', durationSeconds: 4 }
        ],
        [],
        '/x'
      )
    ).toThrow(/one fade per cut/)
  })

  it('each transition subtracts its own duration from the rendered length', () => {
    const clips = [
      clip({ transitionAfter: 'wipeleft', transitionDurationSec: 1 }),
      clip({ transitionAfter: 'crossfade' }),
      clip()
    ]
    expect(renderedDurationSeconds(clips)).toBeCloseTo(15 - 1 - CROSSFADE_DURATION)
  })
})

describe('subtitles', () => {
  it('extracts straight and curly quoted dialogue, ignores unquoted prose', () => {
    expect(extractDialogue('She smiles and says: "Back to work." Then leaves.')).toEqual([
      'Back to work.'
    ])
    expect(extractDialogue('Il murmure : “On y va” puis “vite”')).toEqual(['On y va', 'vite'])
    expect(extractDialogue('No dialogue here.')).toEqual([])
  })

  it('formats ASS timestamps and escapes override braces', () => {
    expect(formatAssTimestamp(71.5)).toBe('0:01:11.50')
    expect(formatAssTimestamp(0)).toBe('0:00:00.00')
    expect(escapeAssText('a {\\b1} line\nnext')).toBe('a \\b1 line\\Nnext')
  })

  it('renders a free layer with position, font, size, weight and colour overrides', () => {
    const ass = buildAssContent({ width: 1920, height: 1080 }, [
      {
        kind: 'layer',
        startSec: 2,
        endSec: 6.5,
        text: 'Générique',
        align: 1,
        x: 0.25,
        y: 0.8,
        fontFamily: 'Georgia',
        sizePct: 10,
        bold: true,
        italic: true,
        colorHex: '#ffcc00'
      }
    ])
    expect(ass).toContain('Style: FreeLayer,')
    const line = ass.split('\n').find((l) => l.includes('Générique'))!
    expect(line).toContain('Dialogue: 0,0:00:02.00,0:00:06.50,FreeLayer')
    expect(line).toContain('\\an1')
    expect(line).toContain('\\pos(480,864)')
    expect(line).toContain('\\fnGeorgia')
    expect(line).toContain('\\fs108')
    expect(line).toContain('\\b1')
    expect(line).toContain('\\i1')
    // #ffcc00 → BGR 00ccff.
    expect(line).toContain('\\1c&H0000CCFF')
  })

  it('converts hex colours to ASS BGR', () => {
    expect(assColor('#ffcc00')).toBe('&H0000CCFF')
    expect(assColor('#ffffff')).toBe('&H00FFFFFF')
    expect(assColor('nope')).toBe('&H00FFFFFF')
  })

  it('builds one ASS document with subtitle, title and watermark styles', () => {
    const ass = buildAssContent({ width: 1920, height: 1080 }, [
      { kind: 'subtitle', startSec: 0, endSec: 4, text: 'Hello' },
      { kind: 'title', startSec: 0, endSec: 3, text: 'Chapter 1', align: 8, size: 'lg' },
      { kind: 'watermark', startSec: 0, endSec: 8, text: 'raccord.ai', align: 3 }
    ])
    expect(ass).toContain('PlayResX: 1920')
    expect(ass).toContain('Style: Subtitle,')
    expect(ass).toContain('Style: Title,')
    expect(ass).toContain('Style: Watermark,')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:04.00,Subtitle,,0,0,0,,Hello')
    // Title carries its alignment AND its size override per event.
    expect(ass).toContain('{\\an8\\fs103}Chapter 1')
    expect(ass).toContain('{\\an3}raccord.ai')
    // The watermark style is translucent (alpha in PrimaryColour).
    expect(ass).toMatch(/Style: Watermark,[^,]+,\d+,&H90FFFFFF/)
  })

  it('escapes the ass path for the subtitles filter and copies audio', () => {
    expect(escapeSubtitlesFilterPath("C:\\tmp\\l'ete.ass")).toBe("C\\:\\\\tmp\\\\l\\'ete.ass")
    const args = buildSubtitleBurnArgs('/tmp/in.mp4', '/tmp/layers.ass', '/tmp/out.mp4')
    const joined = args.join(' ')
    expect(joined).toContain("-vf subtitles=filename='/tmp/layers.ass'")
    expect(joined).toContain('-c:a copy')
  })
})

describe('stage spans with transitions and subtitles', () => {
  it('adds spans only when the passes exist, still summing to 100', () => {
    const spans = computeStageSpans(true, true, { hasTransitions: true, hasSubtitles: true })
    expect(spans.map((s) => s.step)).toEqual([
      'probe',
      'normalize',
      'transition',
      'concat',
      'subtitles',
      'mux'
    ])
    expect(spans.at(-1)!.to).toBeCloseTo(100)
    const plain = computeStageSpans(true, false)
    expect(plain.map((s) => s.step)).toEqual(['probe', 'normalize', 'concat'])
  })
})
