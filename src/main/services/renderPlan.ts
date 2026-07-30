/**
 * Pure planning logic for the rendered MP4 export: ffprobe output parsing,
 * lossless-vs-normalize decision, ffmpeg argv builders and progress mapping.
 * No Electron, fs or child_process imports — render.ts owns the side effects,
 * this module owns every decision (and is unit-tested for it).
 */

export interface ClipProbe {
  /** Container format name(s) as reported by ffprobe (e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  formatName: string | null
  codec: string | null
  width: number | null
  height: number | null
  fps: number | null
  durationSeconds: number | null
  hasAudio: boolean
  audioCodec: string | null
  audioSampleRate: number | null
}

/** One timeline slot resolved to a source file on disk. */
export interface PlannedClip {
  /** Absolute path of the source media (video, or input still for failed shots). */
  path: string
  /** True when the source is an input image standing in for a failed video. */
  isStill: boolean
  /** Duration a still holds the slot (the node's declared clip duration). */
  stillDurationSeconds: number
  /** ffprobe result — null for stills (they are re-encoded unconditionally). */
  probe: ClipProbe | null
}

export interface SequenceSpec {
  width: number
  height: number
  fps: number
}

export const DEFAULT_SEQUENCE: SequenceSpec = { width: 1920, height: 1080, fps: 24 }
export const DEFAULT_STILL_SECONDS = 5

/** "30000/1001" → 29.97; "25/1" → 25; garbage/zero denominators → null. */
function parseRate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d+)\/(\d+)$/.exec(raw)
  if (!m) {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const num = Number(m[1])
  const den = Number(m[2])
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null
  return num / den
}

function asFiniteNumber(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(n) ? n : null
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  sample_rate?: string
}

/** Parses `ffprobe -print_format json -show_streams -show_format` output. */
export function parseFfprobeJson(raw: unknown): ClipProbe {
  const data = (raw ?? {}) as {
    streams?: FfprobeStream[]
    format?: { format_name?: string; duration?: string }
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  // avg_frame_rate is the real content rate; r_frame_rate can be the container tick.
  const fps = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate)

  return {
    formatName: data.format?.format_name ?? null,
    codec: video?.codec_name ?? null,
    width: asFiniteNumber(video?.width),
    height: asFiniteNumber(video?.height),
    fps,
    durationSeconds: asFiniteNumber(data.format?.duration) ?? asFiniteNumber(video?.duration),
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: asFiniteNumber(audio?.sample_rate)
  }
}

const evenDown = (n: number) => Math.max(2, 2 * Math.floor(n / 2))

/**
 * Target spec of the rendered sequence: the first real video clip's probed
 * codec parameters (what the user has been previewing), overridable per field,
 * defaulting to 1080p24 when the timeline is stills-only. Dimensions are
 * rounded down to even values (yuv420p requirement).
 */
export function decideSequenceSpec(
  clips: PlannedClip[],
  override?: { fps?: number; resolution?: { width: number; height: number } }
): SequenceSpec {
  const first = clips.find((c) => !c.isStill && c.probe?.width && c.probe.height)?.probe
  const width = override?.resolution?.width ?? first?.width ?? DEFAULT_SEQUENCE.width
  const height = override?.resolution?.height ?? first?.height ?? DEFAULT_SEQUENCE.height
  const fps = override?.fps ?? first?.fps ?? DEFAULT_SEQUENCE.fps
  return { width: evenDown(width), height: evenDown(height), fps }
}

const MP4_SAFE_CODECS = new Set(['h264', 'hevc'])

/**
 * True when every clip can go through the lossless concat demuxer (-c copy):
 * all real videos in an mp4/mov container, same codec (h264/hevc), exact
 * sequence resolution, same fps, and a uniform audio situation (all with the
 * same audio codec + sample rate, or all silent). Any still forces the
 * normalize pass — it has to be encoded to video anyway.
 */
export function canConcatLosslessly(clips: PlannedClip[], spec: SequenceSpec): boolean {
  if (clips.length === 0) return false
  const first = clips[0]!.probe
  if (!first) return false
  for (const clip of clips) {
    const p = clip.probe
    if (clip.isStill || !p) return false
    if (!p.codec || !MP4_SAFE_CODECS.has(p.codec)) return false
    if (!p.formatName || !/\b(mp4|mov)\b/.test(p.formatName)) return false
    if (p.width !== spec.width || p.height !== spec.height) return false
    if (p.fps === null || Math.abs(p.fps - spec.fps) > 0.01) return false
    if (p.hasAudio !== first.hasAudio) return false
    if (
      p.hasAudio &&
      (p.audioCodec !== first.audioCodec || p.audioSampleRate !== first.audioSampleRate)
    )
      return false
  }
  return true
}

/** Total duration of the rendered sequence (probed video durations + still holds). */
export function sequenceDurationSeconds(clips: PlannedClip[]): number {
  return clips.reduce(
    (acc, c) => acc + (c.isStill ? c.stillDurationSeconds : (c.probe?.durationSeconds ?? 0)),
    0
  )
}

const fpsArg = (fps: number) => (Number.isInteger(fps) ? String(fps) : fps.toFixed(3))

/** scale to fit + pad to the exact sequence frame, letterboxing instead of stretching. */
function videoFilter(spec: SequenceSpec): string {
  const { width: w, height: h } = spec
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `fps=${fpsArg(spec.fps)},format=yuv420p`
  )
}

const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']
const AUDIO_ENCODE_ARGS = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
const SILENCE_INPUT = 'anullsrc=channel_layout=stereo:sample_rate=48000'

/**
 * Normalize one clip to the sequence spec (H.264 + AAC mp4 segment). Clips
 * without audio get a silent stereo track so the concat demuxer sees a uniform
 * stream layout across segments.
 */
export function buildNormalizeArgs(
  clip: PlannedClip,
  spec: SequenceSpec,
  outPath: string
): string[] {
  const args = ['-y', '-hide_banner', '-nostdin']
  if (clip.isStill) {
    const t = String(clip.stillDurationSeconds)
    args.push('-loop', '1', '-t', t, '-i', clip.path, '-f', 'lavfi', '-t', t, '-i', SILENCE_INPUT)
  } else {
    args.push('-i', clip.path)
    if (!clip.probe?.hasAudio) args.push('-f', 'lavfi', '-i', SILENCE_INPUT)
  }

  const needsSilence = clip.isStill || !clip.probe?.hasAudio
  args.push('-filter_complex', `[0:v]${videoFilter(spec)}[v]`)
  args.push('-map', '[v]', '-map', needsSilence ? '1:a' : '0:a')
  args.push(...ENCODE_ARGS, ...AUDIO_ENCODE_ARGS)
  // anullsrc is infinite for non-still clips — stop at the video's end.
  if (!clip.isStill && needsSilence) args.push('-shortest')
  args.push('-movflags', '+faststart', outPath)
  return args
}

/** concat demuxer list file content. Single quotes escaped the ffmpeg way ('\''). */
export function buildConcatListContent(paths: string[]): string {
  return paths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n') + '\n'
}

/** Stream-copy concatenation of homogeneous segments. */
export function buildConcatArgs(listPath: string, outPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath
  ]
}

/**
 * Last visible frame of a clip as a JPEG — the main-side replacement for the
 * renderer's canvas extraction (which needed an open editor window, the one
 * thing a headless MCP run doesn't have). `-sseof -0.1` seeks from the end;
 * `-update 1` writes a single image.
 */
export function buildLastFrameArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-sseof',
    '-0.1',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-q:v',
    '2',
    outputPath
  ]
}

/**
 * Mux the audio lane over the concatenated video: music tracks are chained in
 * timeline order, padded with silence to cover the whole sequence, then mixed
 * with the video's own audio (or used as the only track when the video is
 * silent). Video stream is copied, never re-encoded here.
 */
export function buildMuxArgs(
  videoPath: string,
  musicPaths: string[],
  videoHasAudio: boolean,
  durationSeconds: number,
  outPath: string
): string[] {
  const args = ['-y', '-hide_banner', '-nostdin', '-i', videoPath]
  for (const p of musicPaths) args.push('-i', p)

  const chains: string[] = []
  let music: string
  if (musicPaths.length > 1) {
    const inputs = musicPaths.map((_, i) => `[${i + 1}:a]`).join('')
    chains.push(`${inputs}concat=n=${musicPaths.length}:v=0:a=1[mcat]`)
    music = '[mcat]'
  } else {
    music = '[1:a]'
  }
  chains.push(`${music}apad[mpad]`)
  let audioMap = '[mpad]'
  if (videoHasAudio) {
    // duration=first ends the mix with the video's own audio track.
    chains.push('[0:a][mpad]amix=inputs=2:duration=first:normalize=0[mix]')
    audioMap = '[mix]'
  }

  args.push('-filter_complex', chains.join(';'))
  args.push('-map', '0:v', '-map', audioMap, '-c:v', 'copy', ...AUDIO_ENCODE_ARGS)
  // -t caps the padded (infinite) music when the video track carries no audio.
  args.push('-t', durationSeconds.toFixed(3), '-movflags', '+faststart', outPath)
  return args
}

/**
 * Parses one line of `ffmpeg -progress pipe:1` output into seconds of media
 * processed, or null for the other key=value lines. Note: out_time_us AND
 * out_time_ms are both microseconds (historical ffmpeg quirk).
 */
export function parseProgressLine(line: string): number | null {
  const us = /^out_time_(?:us|ms)=(\d+)/.exec(line)
  if (us) return Number(us[1]) / 1_000_000
  const t = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])
  return null
}

export type RenderStep = 'probe' | 'normalize' | 'concat' | 'mux'

export interface StageSpan {
  step: RenderStep
  from: number
  to: number
}

/**
 * Percent budget of each pipeline stage, proportional to where the time
 * actually goes: encoding dominates when normalizing; stream copy is fast.
 */
export function computeStageSpans(needsNormalize: boolean, hasMusic: boolean): StageSpan[] {
  const weights: Array<[RenderStep, number]> = needsNormalize
    ? [
        ['probe', 4],
        ['normalize', 66],
        ['concat', 15],
        ['mux', hasMusic ? 15 : 0]
      ]
    : [
        ['probe', 10],
        ['concat', 60],
        ['mux', hasMusic ? 30 : 0]
      ]
  const total = weights.reduce((acc, [, w]) => acc + w, 0)
  const spans: StageSpan[] = []
  let at = 0
  for (const [step, w] of weights) {
    if (w === 0) continue
    const size = (w / total) * 100
    spans.push({ step, from: at, to: at + size })
    at += size
  }
  return spans
}

/** Overall render percent for a stage at the given local fraction (0–1). */
export function overallPercent(spans: StageSpan[], step: RenderStep, fraction: number): number {
  const span = spans.find((s) => s.step === step)
  if (!span) return 0
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.round(span.from + (span.to - span.from) * clamped)
}
