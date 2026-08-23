import { describe, expect, it } from 'vitest'
import {
  CROSSFADE_DURATION,
  atempoChain,
  buildCaptionEvents,
  buildOverlayArgs,
  clipMediaWindow,
  encodeArgsFor,
  stillMotionFilter,
  buildConcatArgs,
  buildConcatListContent,
  buildCrossfadeArgs,
  buildLastFrameArgs,
  buildPreviewArgs,
  resolvePreviewSeek,
  buildMuxArgs,
  assColor,
  buildAssContent,
  buildSubtitleBurnArgs,
  duckingVolumeFilter,
  karaokeWords,
  speechActivityWindows,
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

describe('resolvePreviewSeek', () => {
  it('maps positions to seeks, degrading middle to first without a duration', () => {
    expect(resolvePreviewSeek('first', 10)).toEqual({ atSec: 0 })
    expect(resolvePreviewSeek('middle', 10)).toEqual({ atSec: 5 })
    expect(resolvePreviewSeek('middle', null)).toEqual({ atSec: 0 })
    expect(resolvePreviewSeek('last', 10)).toEqual({ fromEnd: true })
    expect(resolvePreviewSeek('last', null)).toEqual({ fromEnd: true })
  })
})

describe('buildPreviewArgs', () => {
  it('writes one downscaled frame without seeking for stills', () => {
    const args = buildPreviewArgs('/tmp/gen-1.png', '/tmp/preview.jpg')
    const joined = args.join(' ')
    expect(joined).not.toContain('-ss')
    expect(joined).toContain('-i /tmp/gen-1.png')
    expect(joined).toContain('-frames:v 1')
    expect(joined).toContain(
      "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease"
    )
    expect(args.at(-1)).toBe('/tmp/preview.jpg')
  })

  it('seeks before the input and honours maxDim', () => {
    const args = buildPreviewArgs('/tmp/gen-1.mp4', '/tmp/preview.jpg', { atSec: 2.5, maxDim: 512 })
    const joined = args.join(' ')
    expect(joined).toContain('-ss 2.500 -i /tmp/gen-1.mp4')
    expect(joined).toContain('min(512,iw)')
  })

  it('seeks from the end for the last frame', () => {
    const args = buildPreviewArgs('/tmp/gen-1.mp4', '/tmp/preview.jpg', { fromEnd: true })
    expect(args.join(' ')).toContain('-sseof -0.1 -i /tmp/gen-1.mp4')
  })
})

describe('buildMuxArgs', () => {
  it('mixes a single music track over video audio, capped at the sequence duration', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/tmp/music.mp3' }],
      [],
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
      [],
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
      [],
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
      [],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a]atrim=start=0:end=8,asetpts=PTS-STARTPTS[t1]')
    expect(filter).toContain('[t1][2:a]concat=n=2:v=0:a=1[mcat]')
  })

  it('mixes the speech lane OVER the music bed and the video audio (3-input amix)', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/music.mp3' }],
      [{ path: '/vo-1.mp3' }, { path: '/vo-2.mp3' }],
      true,
      30,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    // Speech inputs come after the music inputs: [2:a][3:a].
    expect(filter).toContain('[2:a][3:a]concat=n=2:v=0:a=1[scat]')
    expect(filter).toContain('[scat]apad[spad]')
    expect(filter).toContain('[0:a][mpad][spad]amix=inputs=3:duration=first:normalize=0[mix]')
    expect(args.join(' ')).toContain('-map 0:v -map [mix]')
  })

  it('speech alone on a silent video maps its padded lane directly', () => {
    const args = buildMuxArgs('/tmp/video.mp4', [], [{ path: '/vo.mp3' }], false, 10, '/tmp/o.mp4')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toBe('[1:a]apad[spad]')
    expect(args.join(' ')).toContain('-map 0:v -map [spad]')
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

describe('dynamic captions', () => {
  it('maps transcript segments to the final timeline (lane start + trim window)', () => {
    const events = buildCaptionEvents(
      [
        {
          startSec: 10,
          trimStartSec: 2,
          trimEndSec: 8,
          segments: [
            { start: 0, end: 1.5, text: 'Trimmed away' },
            { start: 3, end: 5, text: 'On screen' },
            { start: null, end: null, text: 'Unlocated' },
            { start: 7, end: 12, text: 'Cut by the out-point' }
          ]
        }
      ],
      'classic',
      60
    )
    expect(events.map((e) => e.text)).toEqual(['On screen', 'Cut by the out-point'])
    expect(events[0]).toMatchObject({ kind: 'caption', startSec: 11, endSec: 13 })
    // 7→12 intersected with the 2–8 trim window → 7–8, mapped to 15–16.
    expect(events[1]).toMatchObject({ startSec: 15, endSec: 16 })
  })

  it('clamps to the film and drops fully out-of-film segments', () => {
    const events = buildCaptionEvents(
      [
        {
          startSec: 0,
          segments: [
            { start: 0, end: 4, text: 'a' },
            { start: 9, end: 11, text: 'b' }
          ]
        }
      ],
      'classic',
      3
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ startSec: 0, endSec: 3 })
  })

  it('an untimed end falls back to two seconds of reading time', () => {
    const events = buildCaptionEvents(
      [{ startSec: 0, segments: [{ start: 1, end: null, text: 'tail' }] }],
      'classic',
      60
    )
    expect(events[0]).toMatchObject({ startSec: 1, endSec: 3 })
  })

  it('karaoke splits the segment duration across words proportionally to length', () => {
    const words = karaokeWords('un deux quatre', 2)
    expect(words.map((w) => w.text)).toEqual(['un', 'deux', 'quatre'])
    const total = words.reduce((acc, w) => acc + w.durationCs, 0)
    expect(total).toBe(200)
    expect(words[2]!.durationCs).toBeGreaterThan(words[0]!.durationCs)
    // The karaoke preset stamps the words on the event.
    const events = buildCaptionEvents(
      [{ startSec: 0, segments: [{ start: 0, end: 2, text: 'un deux quatre' }] }],
      'karaoke',
      60
    )
    expect(events[0]!.words).toHaveLength(3)
  })

  it('renders the Caption style and the preset overrides in the ASS document', () => {
    const ass = buildAssContent({ width: 1920, height: 1080 }, [
      { kind: 'caption', startSec: 0, endSec: 2, text: 'Plain line', captionPreset: 'classic' },
      { kind: 'caption', startSec: 2, endSec: 4, text: 'Pop line', captionPreset: 'pop' },
      {
        kind: 'caption',
        startSec: 4,
        endSec: 6,
        text: 'un deux',
        captionPreset: 'karaoke',
        words: [
          { text: 'un', durationCs: 80 },
          { text: 'deux', durationCs: 120 }
        ]
      }
    ])
    expect(ass).toContain('Style: Caption,')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,Plain line')
    expect(ass).toContain('{\\fad(120,80)\\fscx85\\fscy85\\t(0,120,\\fscx100\\fscy100)}Pop line')
    expect(ass).toContain('{\\k80}un {\\k120}deux')
  })
})

describe('music ducking', () => {
  it('pads and merges the speech windows, whole-track fallback without transcript', () => {
    const windows = speechActivityWindows(
      [
        {
          startSec: 0,
          segments: [
            { start: 1, end: 2, text: 'a' },
            { start: 2.2, end: 4, text: 'b' },
            { start: 10, end: 11, text: 'c' }
          ]
        },
        { startSec: 20, durationSeconds: 5, segments: [] }
      ],
      0.15
    )
    // 1–2 and 2.2–4 merge once padded; 10–11 stays apart; the transcript-less
    // track ducks under its whole measured length.
    expect(windows).toEqual([
      { startSec: 0.85, endSec: 4.15 },
      { startSec: 9.85, endSec: 11.15 },
      { startSec: 19.85, endSec: 25.15 }
    ])
  })

  it('builds a frame-evaluated volume expression, null with nothing to duck', () => {
    expect(duckingVolumeFilter([])).toBeNull()
    expect(duckingVolumeFilter([{ startSec: 1, endSec: 2.5 }], 0.4)).toBe(
      "volume=volume='if(between(t,1.000,2.500),0.4,1)':eval=frame"
    )
  })

  it('ducks the music lane between concat and apad, leaving the speech lane alone', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3' }, { path: '/b.mp3' }],
      [{ path: '/vo.mp3' }],
      true,
      30,
      '/tmp/out.mp4',
      { duckMusic: { windows: [{ startSec: 0, endSec: 5 }] } }
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain(
      "[mcat]volume=volume='if(between(t,0.000,5.000),0.35,1)':eval=frame[mcatduck]"
    )
    expect(filter).toContain('[mcatduck]apad[mpad]')
    expect(filter).toContain('[1:a][2:a]concat=n=2:v=0:a=1[mcat]')
    expect(filter).toContain('[3:a]apad[spad]')
  })
})

describe('per-track volume', () => {
  it('applies the gain after the trim, chained in one filter', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3', trimStartSec: 2, trimEndSec: 9, volume: 0.5 }],
      [],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a]atrim=start=2:end=9,asetpts=PTS-STARTPTS,volume=0.5[t1]')
  })

  it('an untrimmed track with a gain gets a lone volume filter; gain 1 stays verbatim', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3', volume: 1.5 }],
      [{ path: '/vo.mp3', volume: 1 }],
      false,
      20,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a]volume=1.5[t1]')
    // volume: 1 is a no-op — the speech track feeds apad directly.
    expect(filter).toContain('[2:a]apad[spad]')
  })
})

describe('clip speed', () => {
  it('divides the effective duration, media window untouched', () => {
    const c = clip({ trimStartSec: 1, trimEndSec: 9, speed: 2 })
    expect(clipMediaWindow(c)).toBe(8)
    expect(clipEffectiveDuration(c)).toBe(4)
    expect(clipEffectiveDuration(clip({ speed: 0.5 }))).toBe(10)
  })

  it('rejects the lossless path', () => {
    const spec = { width: 1920, height: 1080, fps: 24 }
    expect(canConcatLosslessly([clip(), clip({ speed: 1.5 })], spec)).toBe(false)
    expect(canConcatLosslessly([clip(), clip({ speed: 1 })], spec)).toBe(true)
  })

  it('retimes video through setpts (before fps) and audio through atempo', () => {
    const args = buildNormalizeArgs(
      clip({ trimStartSec: 1, trimEndSec: 9, speed: 2 }),
      { width: 1280, height: 720, fps: 24 },
      '/tmp/seg.mp4'
    )
    const joined = args.join(' ')
    // -ss/-t stay in MEDIA time; the retime happens in the filter chain.
    expect(joined).toContain('-ss 1.000')
    expect(joined).toContain('-t 8.000')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('setpts=PTS/2,fps=24')
    expect(filter).toContain(';[0:a]atempo=2[a]')
    expect(joined).toContain('-map [v] -map [a]')
  })

  it('injected silence never goes through atempo', () => {
    const args = buildNormalizeArgs(
      clip({ speed: 2, probe: probe({ hasAudio: false, audioCodec: null }) }),
      { width: 1280, height: 720, fps: 24 },
      '/tmp/seg.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).not.toContain('atempo')
    expect(args.join(' ')).toContain('-map [v] -map 1:a')
  })

  it('chains atempo stages outside 0.5–2', () => {
    expect(atempoChain(1.5)).toBe('atempo=1.5')
    expect(atempoChain(4)).toBe('atempo=2,atempo=2')
    expect(atempoChain(3)).toBe('atempo=2,atempo=1.5')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5')
  })
})

describe('clip look', () => {
  it('chains the look between pad and fps, and rejects the lossless path', () => {
    const args = buildNormalizeArgs(
      clip({ look: 'mono' }),
      { width: 1280, height: 720, fps: 24 },
      '/tmp/seg.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('color=black,hue=s=0,fps=24')
    const spec = { width: 1920, height: 1080, fps: 24 }
    expect(canConcatLosslessly([clip({ look: 'mono' })], spec)).toBe(false)
  })

  it('the chain stays byte-identical without any effect', () => {
    const plain = buildNormalizeArgs(clip(), { width: 1280, height: 720, fps: 24 }, '/tmp/s.mp4')
    const filter = plain[plain.indexOf('-filter_complex') + 1]!
    expect(filter).toBe(
      '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,' +
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=24,format=yuv420p[v]'
    )
  })
})

describe('still motion (Ken Burns)', () => {
  it('zoompan replaces the frozen loop: one input frame, d = the whole hold', () => {
    const args = buildNormalizeArgs(
      clip({
        isStill: true,
        probe: null,
        stillDurationSeconds: 5,
        stillMotion: 'zoom-in',
        path: '/media/still.png'
      }),
      { width: 1280, height: 720, fps: 24 },
      '/tmp/seg.mp4'
    )
    const joined = args.join(' ')
    expect(joined).not.toContain('-loop 1')
    expect(joined).toContain('-t 5 -i anullsrc')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain("zoompan=z='min(1+0.001250*on,1.15)'")
    expect(filter).toContain('d=120:s=1280x720:fps=24')
    // zoompan owns the output rate — no fps filter after it.
    expect(filter).not.toContain(',fps=24,')
  })

  it('pans traverse the hidden band across the hold', () => {
    const spec = { width: 1920, height: 1080, fps: 24 }
    expect(stillMotionFilter('pan-left', 5, spec)).toContain("x='(iw-iw/zoom)*(1-on/120)'")
    expect(stillMotionFilter('pan-right', 5, spec)).toContain("x='(iw-iw/zoom)*on/120'")
    expect(stillMotionFilter('zoom-out', 5, spec)).toContain("z='max(1.15-0.001250*on,1)'")
  })

  it('a motionless still keeps the historical loop argv', () => {
    const args = buildNormalizeArgs(
      clip({ isStill: true, probe: null, stillDurationSeconds: 6, path: '/media/still.png' }),
      { width: 1280, height: 720, fps: 24 },
      '/tmp/seg.mp4'
    )
    expect(args.join(' ')).toContain('-loop 1 -t 6 -i /media/still.png')
  })
})

describe('text layer animations', () => {
  const spec = { width: 1920, height: 1080 }
  const base = {
    kind: 'layer' as const,
    startSec: 0,
    endSec: 3,
    text: 'Titre',
    x: 0.5,
    y: 0.5
  }

  it('fade and pop keep \\pos and add their tags', () => {
    const fade = buildAssContent(spec, [{ ...base, animation: 'fade' }])
    expect(fade).toContain('\\pos(960,540)')
    expect(fade).toContain('\\fad(200,200)')
    const pop = buildAssContent(spec, [{ ...base, animation: 'pop' }])
    expect(pop).toContain('\\fad(120,0)\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)')
  })

  it('slide-up replaces \\pos with \\move from below', () => {
    const ass = buildAssContent(spec, [{ ...base, animation: 'slide-up' }])
    expect(ass).toContain('\\move(960,594,960,540,0,250)')
    expect(ass).toContain('\\fad(150,0)')
    expect(ass).not.toContain('\\pos(')
  })

  it('a static layer stays byte-identical', () => {
    const ass = buildAssContent(spec, [{ ...base, animation: null }])
    expect(ass).toContain('\\pos(960,540)')
    expect(ass).not.toContain('\\fad')
    expect(ass).not.toContain('\\move')
  })
})

describe('export quality & codec', () => {
  it("'standard' h264 is the historical encoder args byte for byte", () => {
    expect(encodeArgsFor()).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'])
    expect(encodeArgsFor('standard', 'h264')).toEqual(encodeArgsFor())
  })

  it('quality changes the CRF/preset; hevc switches encoder and tags hvc1', () => {
    expect(encodeArgsFor('draft')).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'])
    expect(encodeArgsFor('high')).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '16'])
    expect(encodeArgsFor('standard', 'hevc')).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'fast',
      '-crf',
      '24',
      '-tag:v',
      'hvc1'
    ])
  })

  it('threads through the builders', () => {
    const hevc = encodeArgsFor('standard', 'hevc')
    expect(
      buildNormalizeArgs(clip(), { width: 1280, height: 720, fps: 24 }, '/o.mp4', hevc)
    ).toEqual(expect.arrayContaining(['libx265']))
    expect(buildSubtitleBurnArgs('/i.mp4', '/l.ass', '/o.mp4', hevc)).toEqual(
      expect.arrayContaining(['libx265'])
    )
  })
})

describe('audio lane absolute placement', () => {
  it('delays offset tracks and mixes the lane instead of concatenating', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [
        { path: '/a.mp3', startSec: 0 },
        { path: '/b.mp3', startSec: 12.5 }
      ],
      [],
      false,
      30,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[2:a]adelay=12500:all=1[t2]')
    expect(filter).toContain('[1:a][t2]amix=inputs=2:duration=longest:normalize=0[mcat]')
    expect(filter).not.toContain('concat=')
  })

  it('adelay chains after the trim and the volume', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3', trimStartSec: 1, trimEndSec: 6, volume: 0.5, startSec: 3 }],
      [],
      false,
      30,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain(
      '[1:a]atrim=start=1:end=6,asetpts=PTS-STARTPTS,volume=0.5,adelay=3000:all=1[t1]'
    )
  })

  it('an offset-less lane keeps the historical concat argv', () => {
    const args = buildMuxArgs(
      '/tmp/video.mp4',
      [{ path: '/a.mp3' }, { path: '/b.mp3' }],
      [],
      false,
      30,
      '/tmp/out.mp4'
    )
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:a][2:a]concat=n=2:v=0:a=1[mcat]')
  })
})

describe('sticker overlays', () => {
  const spec = { width: 1920, height: 1080, fps: 24 }

  it('scales each sticker, overlays at its center, enabled in its window', () => {
    const args = buildOverlayArgs(
      '/tmp/in.mp4',
      [
        { path: '/s1.png', startSec: 1, endSec: 4, x: 0.5, y: 0.5, widthFraction: 0.25 },
        { path: '/s2.png', startSec: 2, endSec: 6, x: 0.9, y: 0.1, widthFraction: 0.1 }
      ],
      spec,
      '/tmp/out.mp4'
    )
    const joined = args.join(' ')
    expect(joined).toContain('-i /s1.png')
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('[1:v]scale=480:-2[s1]')
    expect(filter).toContain('[2:v]scale=192:-2[s2]')
    expect(filter).toContain(
      "[0:v][s1]overlay=x='(main_w*0.5000)-(overlay_w/2)':y='(main_h*0.5000)-(overlay_h/2)':enable='between(t,1.000,4.000)'[b1]"
    )
    expect(filter).toContain('[b1][s2]overlay=')
    expect(filter).toContain('[vout]')
    expect(joined).toContain('-map [vout] -map 0:a?')
    expect(joined).toContain('-c:a copy')
  })

  it('refuses an empty pass', () => {
    expect(() => buildOverlayArgs('/i.mp4', [], spec, '/o.mp4')).toThrow(/at least one/)
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
