/**
 * Pure planning logic for the rendered MP4 export: ffprobe output parsing,
 * lossless-vs-normalize decision, ffmpeg argv builders and progress mapping.
 * No Electron, fs or child_process imports — render.ts owns the side effects,
 * this module owns every decision (and is unit-tested for it).
 */

import { lookFfmpegFilter } from '@shared/looks'

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
  /** Trim window inside the media (already clamped by the shared clipTrim). */
  trimStartSec?: number
  trimEndSec?: number
  /** Transition INTO the next clip (CLIP_TRANSITIONS id) — ignored on the last clip. */
  transitionAfter?: string | null
  /** That transition's length (clamped upstream; default CROSSFADE_DURATION). */
  transitionDurationSec?: number
  /** Playback speed (clamped upstream; undefined or 1 = untouched). */
  speed?: number
  /** Colour look (a CLIP_LOOKS id) baked into the normalize pass. */
  look?: string | null
  /** Ken Burns preset of a still slot (a STILL_MOTIONS id). */
  stillMotion?: string | null
}

/** Default transition length — mirrors TRANSITION_DEFAULT_SECONDS in @shared/transitions. */
export const CROSSFADE_DURATION = 0.5

/** The overlap a clip's transition takes out of the film (0 for a cut). */
function transitionOverlap(clip: PlannedClip): number {
  return clip.transitionAfter ? (clip.transitionDurationSec ?? CROSSFADE_DURATION) : 0
}

/** True when the clip plays a sub-range of its media. */
export function clipIsTrimmed(clip: PlannedClip): boolean {
  if (clip.isStill) return false
  const raw = clip.probe?.durationSeconds ?? null
  if ((clip.trimStartSec ?? 0) > 0) return true
  return clip.trimEndSec !== undefined && (raw === null || clip.trimEndSec < raw - 0.01)
}

/** The trimmed window inside the MEDIA (what -ss/-t read), speed-agnostic. */
export function clipMediaWindow(clip: PlannedClip): number {
  if (clip.isStill) return clip.stillDurationSeconds
  const start = clip.trimStartSec ?? 0
  const end = clip.trimEndSec ?? clip.probe?.durationSeconds ?? 0
  return Math.max(0, end - start)
}

/** The clip's rendered duration: still hold, or trimmed media length ÷ speed. */
export function clipEffectiveDuration(clip: PlannedClip): number {
  if (clip.isStill) return clip.stillDurationSeconds
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  return clipMediaWindow(clip) / speed
}

/** True when at least one cut of the sequence is a transition (last clip ignored). */
export function hasCrossfades(clips: PlannedClip[]): boolean {
  return clips.slice(0, -1).some((c) => !!c.transitionAfter)
}

/**
 * Consecutive clips joined by transitions, as index groups: [0,1,2] is a chain
 * of two transitions, a singleton is a plain segment between cuts. Groups are
 * what the transition pass merges; the groups' outputs then concat as cuts.
 */
export function crossfadeGroups(clips: PlannedClip[]): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  clips.forEach((clip, i) => {
    current.push(i)
    const chains = i < clips.length - 1 && !!clip.transitionAfter
    if (!chains) {
      groups.push(current)
      current = []
    }
  })
  return groups
}

export interface SequenceSpec {
  width: number
  height: number
  fps: number
}

export const DEFAULT_SEQUENCE: SequenceSpec = { width: 1920, height: 1080, fps: 24 }
export { DEFAULT_STILL_SECONDS } from '@shared/timeline'

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
  // Trims and crossfades both require re-encoding, whatever the codecs are.
  if (clips.some(clipIsTrimmed) || hasCrossfades(clips)) return false
  // Any baked per-clip effect (speed retime, colour look) does too — without
  // this guard the stream-copy path would silently drop it.
  if (clips.some((c) => (!c.isStill && (c.speed ?? 1) !== 1) || !!c.look)) return false
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

/** Total duration of the sequence's clips (trimmed lengths + still holds). */
export function sequenceDurationSeconds(clips: PlannedClip[]): number {
  return clips.reduce((acc, c) => acc + clipEffectiveDuration(c), 0)
}

/** Final file duration: clip durations minus each transition's own overlap. */
export function renderedDurationSeconds(clips: PlannedClip[]): number {
  const overlaps = clips.slice(0, -1).reduce((sum, c) => sum + transitionOverlap(c), 0)
  return Math.max(0, sequenceDurationSeconds(clips) - overlaps)
}

const fpsArg = (fps: number) => (Number.isInteger(fps) ? String(fps) : fps.toFixed(3))

/**
 * Ken Burns on a still slot: ONE input frame, zoompan generates the whole hold
 * (`on` = output frame index, d = total frames). Runs AFTER scale+pad, so the
 * drift covers the letterboxed frame — and it owns the output rate, so the
 * chain skips the fps filter.
 */
export function stillMotionFilter(
  motion: string,
  durationSeconds: number,
  spec: SequenceSpec
): string {
  const frames = Math.max(1, Math.round(durationSeconds * spec.fps))
  const out = `d=${frames}:s=${spec.width}x${spec.height}:fps=${fpsArg(spec.fps)}`
  const zMax = 1.15
  const rate = ((zMax - 1) / frames).toFixed(6)
  const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
  const midY = `y='(ih-ih/zoom)/2'`
  switch (motion) {
    case 'zoom-out':
      return `zoompan=z='max(${zMax}-${rate}*on,1)':${center}:${out}`
    case 'pan-left':
      return `zoompan=z=1.1:x='(iw-iw/zoom)*(1-on/${frames})':${midY}:${out}`
    case 'pan-right':
      return `zoompan=z=1.1:x='(iw-iw/zoom)*on/${frames}':${midY}:${out}`
    default:
      return `zoompan=z='min(1+${rate}*on,${zMax})':${center}:${out}`
  }
}

/**
 * The audio side of a speed change: atempo only accepts 0.5–2 per stage, so
 * out-of-range factors chain stages (4 → 2×2, 0.25 → 0.5×0.5).
 */
export function atempoChain(speed: number): string {
  const stages: number[] = []
  let s = speed
  while (s > 2) {
    stages.push(2)
    s /= 2
  }
  while (s < 0.5) {
    stages.push(0.5)
    s *= 2
  }
  stages.push(s)
  return stages.map((v) => `atempo=${Number(v.toFixed(4))}`).join(',')
}

/**
 * scale to fit + pad to the exact sequence frame (letterboxing, never
 * stretching), then the clip's baked effects: colour look, speed retime
 * (setpts BEFORE fps so the retimed stream is resampled), or a still's
 * Ken Burns. Byte-identical to the historical chain when the clip has none.
 */
function videoFilter(spec: SequenceSpec, clip?: PlannedClip): string {
  const { width: w, height: h } = spec
  const parts = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  ]
  const look = lookFfmpegFilter(clip?.look)
  if (look) parts.push(look)
  if (clip?.isStill && clip.stillMotion) {
    parts.push(stillMotionFilter(clip.stillMotion, clip.stillDurationSeconds, spec))
    parts.push('format=yuv420p')
    return parts.join(',')
  }
  const speed = clip && !clip.isStill ? (clip.speed ?? 1) : 1
  if (speed !== 1) parts.push(`setpts=PTS/${speed}`)
  parts.push(`fps=${fpsArg(spec.fps)}`, 'format=yuv420p')
  return parts.join(',')
}

const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']

/**
 * Encoder args for an export quality/codec choice. 'standard' h264 IS the
 * historical ENCODE_ARGS byte for byte; hevc gets the `hvc1` tag QuickTime
 * requires to recognise the track.
 */
export function encodeArgsFor(quality?: string, codec?: string): string[] {
  const q = quality === 'draft' || quality === 'high' ? quality : 'standard'
  if (codec === 'hevc') {
    const crf = q === 'draft' ? '28' : q === 'high' ? '20' : '24'
    const preset = q === 'high' ? 'medium' : 'fast'
    return ['-c:v', 'libx265', '-preset', preset, '-crf', crf, '-tag:v', 'hvc1']
  }
  if (q === 'draft') return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
  if (q === 'high') return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16']
  return [...ENCODE_ARGS]
}
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
  outPath: string,
  encodeArgs: string[] = ENCODE_ARGS
): string[] {
  const args = ['-y', '-hide_banner', '-nostdin']
  const speed = !clip.isStill && clip.speed && clip.speed > 0 ? clip.speed : 1
  if (clip.isStill) {
    const t = String(clip.stillDurationSeconds)
    if (clip.stillMotion) {
      // Ken Burns: ONE input frame — zoompan generates the whole hold itself.
      args.push('-i', clip.path, '-f', 'lavfi', '-t', t, '-i', SILENCE_INPUT)
    } else {
      args.push('-loop', '1', '-t', t, '-i', clip.path, '-f', 'lavfi', '-t', t, '-i', SILENCE_INPUT)
    }
  } else {
    // Trim as input options: -ss before -i is frame-accurate when re-encoding
    // (ffmpeg decodes from the previous keyframe and discards), -t bounds the
    // read so the out-point never depends on stream metadata. Both are MEDIA
    // time — a speed change retimes later, in the filter chain.
    const start = clip.trimStartSec ?? 0
    if (start > 0) args.push('-ss', start.toFixed(3))
    const window = clipMediaWindow(clip)
    if (clipIsTrimmed(clip) && window > 0) args.push('-t', window.toFixed(3))
    args.push('-i', clip.path)
    if (!clip.probe?.hasAudio) args.push('-f', 'lavfi', '-i', SILENCE_INPUT)
  }

  const needsSilence = clip.isStill || !clip.probe?.hasAudio
  const filters = [`[0:v]${videoFilter(spec, clip)}[v]`]
  // Real audio follows the retime through atempo; injected silence never needs
  // to (it is infinite, -shortest bounds it to the retimed video).
  const retimeAudio = !needsSilence && speed !== 1
  if (retimeAudio) filters.push(`[0:a]${atempoChain(speed)}[a]`)
  args.push('-filter_complex', filters.join(';'))
  args.push('-map', '[v]', '-map', retimeAudio ? '[a]' : needsSilence ? '1:a' : '0:a')
  args.push(...encodeArgs, ...AUDIO_ENCODE_ARGS)
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
 * Merge one transition group into a single segment: chained video xfades and
 * audio acrossfades over the group's (already normalized, uniform) segments.
 * `fades[i]` describes the transition between segment i and i+1 (its xfade
 * name and its own length). Offsets are computed from MEASURED durations
 * (render.ts re-probes the segments) — the fade must start exactly its length
 * before each segment ends, and encoder rounding would drift a declared value.
 */
export function buildCrossfadeArgs(
  segments: Array<{ path: string; durationSeconds: number }>,
  fades: Array<{ xfade: string; durationSec: number }>,
  outPath: string,
  encodeArgs: string[] = ENCODE_ARGS
): string[] {
  if (segments.length < 2) throw new Error('A transition group needs at least two segments')
  if (fades.length !== segments.length - 1) {
    throw new Error('A transition group needs exactly one fade per cut')
  }
  const args = ['-y', '-hide_banner', '-nostdin']
  for (const s of segments) args.push('-i', s.path)

  const chains: string[] = []
  let video = '[0:v]'
  let audio = '[0:a]'
  let elapsed = segments[0]!.durationSeconds
  for (let i = 1; i < segments.length; i++) {
    const fade = fades[i - 1]!
    const offset = Math.max(0, elapsed - fade.durationSec)
    const vOut = i === segments.length - 1 ? '[vout]' : `[vx${i}]`
    const aOut = i === segments.length - 1 ? '[aout]' : `[ax${i}]`
    chains.push(
      `${video}[${i}:v]xfade=transition=${fade.xfade}:duration=${fade.durationSec}:offset=${offset.toFixed(3)}${vOut}`
    )
    // Whatever the visual is, the audio crossfades — a hard audio cut under a
    // visual wipe reads as a glitch.
    chains.push(`${audio}[${i}:a]acrossfade=d=${fade.durationSec}${aOut}`)
    video = vOut
    audio = aOut
    elapsed = elapsed + segments[i]!.durationSeconds - fade.durationSec
  }

  args.push('-filter_complex', chains.join(';'))
  args.push('-map', '[vout]', '-map', '[aout]')
  args.push(...encodeArgs, ...AUDIO_ENCODE_ARGS)
  args.push('-movflags', '+faststart', outPath)
  return args
}

// ── Burned text layers (one ASS file: subtitles + titles + watermark) ────────

/**
 * Everything burned over the picture goes through ONE libass pass: the
 * scenario's dialogue (style Subtitle, bottom center), per-clip text layers
 * (style Title, alignment per event) and the watermark (style Watermark,
 * translucent corner text). ASS gives positioning, sizing and transparency
 * that SRT cannot express, and libass ships in the bundled ffmpeg — no
 * fontconfig/drawtext portability gamble.
 */
export interface AssEvent {
  startSec: number
  endSec: number
  text: string
  kind: 'subtitle' | 'title' | 'watermark' | 'layer' | 'caption'
  /** ASS numpad alignment 1–9 (titles/watermark/layers; subtitles are always 2). */
  align?: number
  /** Title size preset (defaults to 'md'). */
  size?: 'sm' | 'md' | 'lg'
  /** Free layers (§6.12b): normalized frame position + own typography. */
  x?: number
  y?: number
  fontFamily?: string | null
  sizePct?: number
  bold?: boolean
  italic?: boolean
  colorHex?: string
  /** Free layers: entrance animation preset (a TEXT_ANIMATIONS id). */
  animation?: string | null
  /** Dynamic captions: preset id + karaoke word timings (centiseconds). */
  captionPreset?: string
  words?: Array<{ text: string; durationCs: number }>
}

/** #RRGGBB → ASS &H00BBGGRR (ASS colours are little-endian BGR). */
export function assColor(hex: string): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)
  if (!m) return '&H00FFFFFF'
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase()
}

/** Kept as the subtitle entry shape used by render.ts (alias of old name). */
export interface SubtitleEntry {
  startSec: number
  endSec: number
  text: string
}

/**
 * Dialogue lines of a scenario shot: the double-quoted spans of its action and
 * sound (the doctrine writes spoken lines in quotes — she says: "…"). Nothing
 * is invented: a shot without quotes gets no subtitle.
 */
export function extractDialogue(text: string): string[] {
  const lines: string[] = []
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) {
    const line = (m[1] ?? m[2] ?? '').trim()
    if (line) lines.push(line)
  }
  return lines
}

// ── Dynamic captions (speech-lane transcripts → timed ASS events) ────────────

/** One transcript segment as stored on generations.transcript (§8). */
export interface CaptionSegmentInput {
  start: number | null
  end: number | null
  text: string
}

/** One speech-lane track resolved for captioning/ducking. */
export interface CaptionTrackInput {
  /** Where the track starts on the FINAL timeline (lane concatenation order). */
  startSec: number
  /** Trim window inside the media (already clamped by the shared clipTrim). */
  trimStartSec?: number
  trimEndSec?: number
  /** Measured media length (probed) — the no-transcript ducking fallback. */
  durationSeconds?: number
  segments: CaptionSegmentInput[]
}

/**
 * Word timings for an ASS karaoke line: the segment's duration split across
 * its words proportionally to their length (the alignment is segment-grained,
 * so word boundaries are estimated — good enough for a highlight sweep).
 */
export function karaokeWords(
  text: string,
  durationSeconds: number
): Array<{ text: string; durationCs: number }> {
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return []
  const totalCs = Math.max(words.length, Math.round(durationSeconds * 100))
  const weight = words.reduce((acc, w) => acc + w.length, 0)
  let used = 0
  return words.map((w, i) => {
    const cs =
      i === words.length - 1
        ? Math.max(1, totalCs - used)
        : Math.max(1, Math.round((totalCs * w.length) / weight))
    used += cs
    return { text: w, durationCs: cs }
  })
}

/**
 * Caption events from the speech lane's transcripts: each timed segment is
 * mapped from media time to the final timeline (trim window subtracted, lane
 * start added), clamped to the film. Segments the alignment could not locate
 * (null start) are skipped — nothing is invented. An untimed end falls back to
 * two seconds, the reading-time floor.
 */
export function buildCaptionEvents(
  tracks: CaptionTrackInput[],
  preset: string,
  finalDurationSeconds: number
): AssEvent[] {
  const events: AssEvent[] = []
  for (const track of tracks) {
    const trimStart = Math.max(0, track.trimStartSec ?? 0)
    const trimEnd = track.trimEndSec
    for (const seg of track.segments) {
      if (seg.start === null) continue
      const text = seg.text.trim()
      if (text === '') continue
      const rawEnd = seg.end ?? seg.start + 2
      const from = Math.max(seg.start, trimStart)
      const to = trimEnd !== undefined ? Math.min(rawEnd, trimEnd) : rawEnd
      if (to <= from) continue
      const startSec = track.startSec + (from - trimStart)
      const endSec = Math.min(track.startSec + (to - trimStart), finalDurationSeconds)
      if (startSec >= finalDurationSeconds || endSec <= startSec) continue
      events.push({
        kind: 'caption',
        startSec,
        endSec,
        text,
        captionPreset: preset,
        ...(preset === 'karaoke' ? { words: karaokeWords(text, endSec - startSec) } : {})
      })
    }
  }
  return events
}

/**
 * When the voice speaks, on the final timeline: the transcript segments mapped
 * like buildCaptionEvents, padded and merged. A track without a usable
 * transcript ducks under its whole (measured, trimmed) length instead — better
 * too much ducking than a voice buried in music.
 */
export function speechActivityWindows(
  tracks: CaptionTrackInput[],
  padSeconds = 0.15
): Array<{ startSec: number; endSec: number }> {
  const raw: Array<{ startSec: number; endSec: number }> = []
  for (const track of tracks) {
    const trimStart = Math.max(0, track.trimStartSec ?? 0)
    const trimEnd = track.trimEndSec
    const timed = track.segments.filter((s) => s.start !== null)
    if (timed.length === 0) {
      const mediaEnd =
        track.durationSeconds === undefined
          ? trimEnd
          : trimEnd !== undefined
            ? Math.min(trimEnd, track.durationSeconds)
            : track.durationSeconds
      if (mediaEnd !== undefined && mediaEnd > trimStart) {
        raw.push({ startSec: track.startSec, endSec: track.startSec + (mediaEnd - trimStart) })
      }
      continue
    }
    for (const seg of timed) {
      const segStart = seg.start as number
      const rawEnd = seg.end ?? segStart + 2
      const from = Math.max(segStart, trimStart)
      const to = trimEnd !== undefined ? Math.min(rawEnd, trimEnd) : rawEnd
      if (to <= from) continue
      raw.push({
        startSec: track.startSec + (from - trimStart),
        endSec: track.startSec + (to - trimStart)
      })
    }
  }
  const padded = raw
    .map((w) => ({ startSec: Math.max(0, w.startSec - padSeconds), endSec: w.endSec + padSeconds }))
    .sort((a, b) => a.startSec - b.startSec)
  const merged: typeof padded = []
  for (const w of padded) {
    const last = merged[merged.length - 1]
    if (last && w.startSec <= last.endSec) last.endSec = Math.max(last.endSec, w.endSec)
    else merged.push({ ...w })
  }
  return merged
}

/**
 * The music lane's ducking filter: unity gain everywhere, dropped to `gain`
 * inside the speech windows (frame-evaluated volume expression). Null when
 * there is nothing to duck under.
 */
export function duckingVolumeFilter(
  windows: Array<{ startSec: number; endSec: number }>,
  gain = 0.35
): string | null {
  if (windows.length === 0) return null
  const terms = windows
    .map((w) => `between(t,${w.startSec.toFixed(3)},${w.endSec.toFixed(3)})`)
    .join('+')
  return `volume=volume='if(${terms},${gain},1)':eval=frame`
}

/** 71.5 → "0:01:11.50" (ASS uses centiseconds). */
export function formatAssTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const cs = Math.round((clamped % 1) * 100)
  const total = Math.floor(clamped)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

/** Braces open ASS override blocks; newlines are \N. Nothing else is special. */
export function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N')
}

const TITLE_SIZE_FACTOR = { sm: 0.045, md: 0.065, lg: 0.095 } as const

/**
 * The complete ASS document for a render: styles scaled to the sequence spec
 * (PlayResX/Y = output size, so nothing depends on the viewer), one Dialogue
 * event per entry. Titles carry their alignment as an event override, so one
 * style serves all nine positions.
 */
export function buildAssContent(
  spec: { width: number; height: number },
  events: AssEvent[]
): string {
  const subtitleSize = Math.round(spec.height * 0.05)
  const watermarkSize = Math.round(spec.height * 0.033)
  const captionSize = Math.round(spec.height * 0.055)
  const captionMargin = Math.round(spec.height * 0.09)
  const margin = Math.round(spec.height * 0.04)
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${spec.width}`,
    `PlayResY: ${spec.height}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Subtitle,Arial,${subtitleSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,${margin},${margin},${margin},1`,
    `Style: Title,Arial,${Math.round(spec.height * TITLE_SIZE_FACTOR.md)},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,5,${margin},${margin},${margin},1`,
    // &H90 alpha in PrimaryColour ≈ 56% transparent — visible, not shouting.
    `Style: Watermark,Arial,${watermarkSize},&H90FFFFFF,&H90FFFFFF,&H90101010,&H00000000,0,0,0,0,100,100,0,0,1,1,0,3,${margin},${margin},${margin},1`,
    // Free layers: the style is a neutral base — every event overrides
    // position, font, size, weight and colour for itself.
    `Style: FreeLayer,Arial,${subtitleSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,0,0,0,1`,
    // Dynamic captions: bold bottom-center, strong outline. SecondaryColour is
    // the karaoke "not yet spoken" grey — \k sweeps it to PrimaryColour.
    `Style: Caption,Arial,${captionSize},&H00FFFFFF,&H00C8C8C8,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,${margin},${margin},${captionMargin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const lines = events.map((e) => {
    const style =
      e.kind === 'subtitle'
        ? 'Subtitle'
        : e.kind === 'title'
          ? 'Title'
          : e.kind === 'watermark'
            ? 'Watermark'
            : e.kind === 'caption'
              ? 'Caption'
              : 'FreeLayer'
    const overrides: string[] = []
    if (e.kind !== 'subtitle' && e.kind !== 'caption' && e.align !== undefined) {
      overrides.push(`\\an${e.align}`)
    }
    // Caption presets: 'classic' is the bare style; 'pop' scales in with a
    // quick fade; 'karaoke' carries its word timings in the text itself.
    if (e.kind === 'caption' && e.captionPreset === 'pop') {
      overrides.push('\\fad(120,80)\\fscx85\\fscy85\\t(0,120,\\fscx100\\fscy100)')
    }
    if (e.kind === 'title' && e.size && e.size !== 'md') {
      overrides.push(`\\fs${Math.round(spec.height * TITLE_SIZE_FACTOR[e.size])}`)
    }
    if (e.kind === 'layer') {
      const x = Math.round((e.x ?? 0.5) * spec.width)
      const y = Math.round((e.y ?? 0.5) * spec.height)
      // Entrance animations ride the same override block (\move replaces \pos).
      if (e.animation === 'slide-up') {
        const fromY = Math.min(spec.height, y + Math.round(spec.height * 0.05))
        overrides.push(`\\move(${x},${fromY},${x},${y},0,250)`, '\\fad(150,0)')
      } else {
        overrides.push(`\\pos(${x},${y})`)
        if (e.animation === 'fade') overrides.push('\\fad(200,200)')
        if (e.animation === 'pop') {
          overrides.push('\\fad(120,0)\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)')
        }
      }
      if (e.fontFamily) overrides.push(`\\fn${e.fontFamily.replace(/[{}\\]/g, '')}`)
      overrides.push(`\\fs${Math.max(1, Math.round(spec.height * ((e.sizePct ?? 6) / 100)))}`)
      if (e.bold) overrides.push('\\b1')
      if (e.italic) overrides.push('\\i1')
      if (e.colorHex) overrides.push(`\\1c${assColor(e.colorHex)}`)
    }
    const prefix = overrides.length > 0 ? `{${overrides.join('')}}` : ''
    const body =
      e.kind === 'caption' && e.captionPreset === 'karaoke' && e.words && e.words.length > 0
        ? e.words.map((w) => `{\\k${w.durationCs}}${escapeAssText(w.text)}`).join(' ')
        : escapeAssText(e.text)
    return `Dialogue: 0,${formatAssTimestamp(e.startSec)},${formatAssTimestamp(e.endSec)},${style},,0,0,0,,${prefix}${body}`
  })
  return [...header, ...lines, ''].join('\n')
}

/**
 * The subtitles filter parses its argument like a mini-language: backslashes,
 * quotes and colons (Windows drive letters!) must be escaped or the filter
 * splits the path.
 */
export function escapeSubtitlesFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
}

/** Burn an ASS document into the video track (audio copied untouched). */
export function buildSubtitleBurnArgs(
  inputPath: string,
  assPath: string,
  outPath: string,
  encodeArgs: string[] = ENCODE_ARGS
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-i',
    inputPath,
    '-vf',
    `subtitles=filename='${escapeSubtitlesFilterPath(assPath)}'`,
    ...encodeArgs,
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    outPath
  ]
}

// ── Sticker track (image overlays composited over the film) ─────────────────

/** One sticker resolved to a file, timed on the FINAL timeline. */
export interface PlannedOverlay {
  path: string
  startSec: number
  endSec: number
  /** Normalized CENTER position (0–1). */
  x: number
  y: number
  /** Width as a fraction of the output width, 0–1 (height keeps aspect). */
  widthFraction: number
}

/**
 * Composite the sticker track over the film in ONE pass: each image scaled to
 * its width fraction, overlaid at its normalized center, enabled only inside
 * its time window. Audio copied untouched.
 */
export function buildOverlayArgs(
  inputPath: string,
  overlays: PlannedOverlay[],
  spec: SequenceSpec,
  outPath: string,
  encodeArgs: string[] = ENCODE_ARGS
): string[] {
  if (overlays.length === 0) throw new Error('The overlay pass needs at least one sticker')
  const args = ['-y', '-hide_banner', '-nostdin', '-i', inputPath]
  for (const o of overlays) args.push('-i', o.path)

  const chains: string[] = []
  let base = '[0:v]'
  overlays.forEach((o, i) => {
    const width = Math.max(2, 2 * Math.round((spec.width * o.widthFraction) / 2))
    chains.push(`[${i + 1}:v]scale=${width}:-2[s${i + 1}]`)
    const out = i === overlays.length - 1 ? '[vout]' : `[b${i + 1}]`
    const x = `(main_w*${o.x.toFixed(4)})-(overlay_w/2)`
    const y = `(main_h*${o.y.toFixed(4)})-(overlay_h/2)`
    chains.push(
      `${base}[s${i + 1}]overlay=x='${x}':y='${y}':enable='between(t,${o.startSec.toFixed(3)},${o.endSec.toFixed(3)})'${out}`
    )
    base = out
  })

  args.push('-filter_complex', chains.join(';'))
  args.push('-map', '[vout]', '-map', '0:a?')
  args.push(...encodeArgs, '-c:a', 'copy')
  args.push('-movflags', '+faststart', outPath)
  return args
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

/** Where get_generation_media grabs a video's preview frame. */
export type PreviewPosition = 'first' | 'middle' | 'last'

/**
 * Seek options for a preview frame. 'middle' needs the probed duration; when
 * the probe failed (null) it degrades to the first frame rather than erroring
 * — a preview must stay best-effort.
 */
export function resolvePreviewSeek(
  position: PreviewPosition,
  durationSec: number | null
): { atSec?: number; fromEnd?: boolean } {
  if (position === 'last') return { fromEnd: true }
  if (position === 'middle' && durationSec !== null) return { atSec: durationSec / 2 }
  return { atSec: 0 }
}

/**
 * ffmpeg argv for a downscaled single-frame JPEG preview of an image or a
 * video — small enough to inline as base64 image content in an agent tool
 * result. The scale filter fits within maxDim×maxDim without ever upscaling.
 */
export function buildPreviewArgs(
  inputPath: string,
  outputPath: string,
  opts: { atSec?: number; fromEnd?: boolean; maxDim?: number } = {}
): string[] {
  const maxDim = opts.maxDim ?? 1024
  return [
    '-y',
    '-hide_banner',
    '-nostdin',
    ...(opts.fromEnd
      ? ['-sseof', '-0.1']
      : opts.atSec !== undefined && opts.atSec > 0
        ? ['-ss', opts.atSec.toFixed(3)]
        : []),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
    '-update',
    '1',
    '-q:v',
    '4',
    outputPath
  ]
}

/** One audio-lane track: its file plus the node's journaled trim window. */
export interface MusicTrack {
  path: string
  /** Trim window inside the track (already clamped by the shared clipTrim). */
  trimStartSec?: number
  trimEndSec?: number
  /** Volume gain (0–2; undefined or 1 = untouched, keeps the argv historical). */
  volume?: number
  /**
   * Absolute start on the final timeline (audioLaneStarts). When ANY track of
   * a lane carries one, the lane switches from concatenation to absolute
   * placement: adelay per track, amix duration=longest (overlaps just mix).
   */
  startSec?: number
}

/**
 * Mux the audio lanes over the concatenated video. Two lanes, same mechanics
 * each: tracks trimmed to their window (atrim — the preview player honours the
 * same bounds), chained in timeline order, padded with silence to cover the
 * whole sequence. `music` (Suno bed) and `speech` (ElevenLabs voice-over) are
 * SEPARATE lanes mixed together with the video's own audio — speech plays OVER
 * the music, never after it. Video stream is copied, never re-encoded here.
 * With an empty speech lane the argv is byte-identical to the historical
 * music-only builder.
 */
export function buildMuxArgs(
  videoPath: string,
  music: MusicTrack[],
  speech: MusicTrack[],
  videoHasAudio: boolean,
  durationSeconds: number,
  outPath: string,
  opts?: {
    /** Duck the music bed inside the speech windows (see duckingVolumeFilter). */
    duckMusic?: { windows: Array<{ startSec: number; endSec: number }>; gain?: number }
  }
): string[] {
  const args = ['-y', '-hide_banner', '-nostdin', '-i', videoPath]
  for (const t of [...music, ...speech]) args.push('-i', t.path)

  const chains: string[] = []
  // An untouched track feeds the chain directly — the argv stays byte-identical
  // to the pre-trim builder; a trimmed one goes through its own atrim first
  // (asetpts rebases timestamps so concat/apad see a stream starting at 0), and
  // a per-track volume gain chains after the trim.
  const buildLane = (
    tracks: MusicTrack[],
    firstInput: number,
    catLabel: string,
    padLabel: string,
    laneFilter?: string | null
  ): string | null => {
    if (tracks.length === 0) return null
    // Absolute placement (any explicit startSec) replaces the historical
    // concatenation: each track is delayed to its start, overlaps just mix.
    const absolute = tracks.some((m) => m.startSec !== undefined)
    const labels = tracks.map((m, i) => {
      const idx = firstInput + i
      const src = `[${idx}:a]`
      const filters: string[] = []
      const start = m.trimStartSec ?? 0
      if (start > 0 || m.trimEndSec !== undefined) {
        const parts = [`start=${start}`]
        if (m.trimEndSec !== undefined) parts.push(`end=${m.trimEndSec}`)
        filters.push(`atrim=${parts.join(':')}`, 'asetpts=PTS-STARTPTS')
      }
      if (m.volume !== undefined && m.volume !== 1) filters.push(`volume=${m.volume}`)
      if (absolute && (m.startSec ?? 0) > 0) {
        filters.push(`adelay=${Math.round((m.startSec ?? 0) * 1000)}:all=1`)
      }
      if (filters.length === 0) return src
      chains.push(`${src}${filters.join(',')}[t${idx}]`)
      return `[t${idx}]`
    })
    let label: string
    if (labels.length > 1) {
      chains.push(
        absolute
          ? `${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${catLabel}]`
          : `${labels.join('')}concat=n=${labels.length}:v=0:a=1[${catLabel}]`
      )
      label = `[${catLabel}]`
    } else {
      label = labels[0] as string
    }
    // Lane-wide filter (music ducking): after concat, in final-timeline time.
    if (laneFilter) {
      chains.push(`${label}${laneFilter}[${catLabel}duck]`)
      label = `[${catLabel}duck]`
    }
    chains.push(`${label}apad[${padLabel}]`)
    return `[${padLabel}]`
  }

  const duckFilter = opts?.duckMusic
    ? duckingVolumeFilter(opts.duckMusic.windows, opts.duckMusic.gain)
    : null
  const musicLane = buildLane(music, 1, 'mcat', 'mpad', duckFilter)
  const speechLane = buildLane(speech, 1 + music.length, 'scat', 'spad')
  const mixInputs = [videoHasAudio ? '[0:a]' : null, musicLane, speechLane].filter(
    (l): l is string => l !== null
  )
  let audioMap = mixInputs[0] ?? '[0:a]'
  if (mixInputs.length > 1) {
    // duration=first ends the mix with the video's own audio track.
    chains.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[mix]`
    )
    audioMap = '[mix]'
  }

  args.push('-filter_complex', chains.join(';'))
  args.push('-map', '0:v', '-map', audioMap, '-c:v', 'copy', ...AUDIO_ENCODE_ARGS)
  // -t caps the padded (infinite) lanes when the video track carries no audio.
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

export type RenderStep =
  'probe' | 'normalize' | 'transition' | 'concat' | 'subtitles' | 'overlay' | 'mux'

export interface StageSpan {
  step: RenderStep
  from: number
  to: number
}

/**
 * Percent budget of each pipeline stage, proportional to where the time
 * actually goes: encoding dominates when normalizing; stream copy is fast.
 */
export function computeStageSpans(
  needsNormalize: boolean,
  hasMusic: boolean,
  extras: { hasTransitions?: boolean; hasSubtitles?: boolean; hasOverlays?: boolean } = {}
): StageSpan[] {
  const weights: Array<[RenderStep, number]> = needsNormalize
    ? [
        ['probe', 4],
        ['normalize', 66],
        ['transition', extras.hasTransitions ? 12 : 0],
        ['concat', 15],
        ['subtitles', extras.hasSubtitles ? 12 : 0],
        ['overlay', extras.hasOverlays ? 12 : 0],
        ['mux', hasMusic ? 15 : 0]
      ]
    : [
        ['probe', 10],
        ['concat', 60],
        ['subtitles', extras.hasSubtitles ? 15 : 0],
        ['overlay', extras.hasOverlays ? 15 : 0],
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
