import {
  AlertCircle,
  Mic,
  Music,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Film,
  Image as ImageIcon,
  ImageOff,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Scissors,
  Sticker as StickerIcon,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode, ImageLayer, TextLayer, TimelineSegment } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import {
  useAssetNodeMedia,
  useImageLayers,
  useTextLayers,
  useTimelineFallbackImages,
  useVideoGenerations
} from './data'
import type { WorkflowGraph } from './workflowContext'
import {
  DEFAULT_CLIP_SECONDS,
  audioLaneStarts,
  bestGeneration,
  clipDuration,
  clipLook,
  clipSegments,
  clipSpeed,
  clipTimelineOffset,
  clipVolume,
  collectAudioNodes,
  collectTimelineClips,
  collectTimelineEntries,
  isStillClip,
  segmentTransitionAfter,
  segmentTransitionSeconds,
  segmentTrim,
  stillClipSeconds,
  stillMotionOf
} from '@shared/timeline'
import { formatTimecode } from '@shared/annotations'
import { CLIP_LOOK_IDS, lookCssFilter } from '@shared/looks'
import { STILL_MOTION_IDS } from '@shared/stillMotion'
import { TEXT_ANIMATION_IDS } from '@shared/textAnimations'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import { useInputStills, useMuted, useResizableHeight } from './timelineHooks'
import { Waveform } from './Waveform'
import { formatSeconds } from '../../lib/formatSeconds'
import { nextShuttleRate } from '../../lib/shuttle'
import { snapSpan, snapTolerance } from '../../lib/timelineSnap'
import { invoke } from '../../lib/ipc'
import { useDismissable } from '../../components/ui/useDismissable'
import { useShortcut } from '../../components/ui/useShortcut'
import { VideoThumb } from '../../components/VideoThumb'

/** Timeline clock formatting: tenth-of-a-second precision, never raw floats. */
const fmt = formatSeconds

/** Display rate of the transport timecode only — media fps varies per model. */
const TIMECODE_FPS = 25

/**
 * FCP-style timecode: fixed-width `HH:MM:SS:FF` with the leading zeros dimmed.
 * The constant width (monospace + always 11 chars) is what keeps the transport
 * from shifting as digits roll over.
 */
function Timecode({ seconds, dimAll = false }: { seconds: number; dimAll?: boolean }) {
  const totalFrames = Math.max(0, Math.floor(seconds * TIMECODE_FPS))
  const ff = totalFrames % TIMECODE_FPS
  const totalSeconds = Math.floor(totalFrames / TIMECODE_FPS)
  const hh = Math.floor(totalSeconds / 3600)
  const mm = Math.floor((totalSeconds % 3600) / 60)
  const ss = totalSeconds % 60
  const text = [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':')
  // Dim everything up to the first significant digit, like FCP.
  const firstDigit = text.search(/[1-9]/)
  const split = dimAll || firstDigit === -1 ? text.length : firstDigit
  return (
    <span className="font-mono tabular-nums whitespace-pre">
      <span className="text-neutral-600">{text.slice(0, split)}</span>
      <span className={dimAll ? undefined : 'text-neutral-100'}>{text.slice(split)}</span>
    </span>
  )
}

/**
 * Timeline v2 — continuous NLE-style playback.
 *
 * Engine: two stacked <video> elements. The active one plays the current clip;
 * the standby one preloads the next clip's media, and becomes active the
 * instant the current clip ends — gapless playback across the whole edit.
 * A global time ruler maps every clip onto one scrubbable playhead.
 */

interface EngineClip {
  node: GraphNode
  /** The entry's SEGMENT (§6.12e): its own trim + transition. */
  segment: TimelineSegment
  segmentIndex: number
  /** Stable identity ("nodeId#segmentIndex") for lists and live-resize state. */
  entryId: string
  url: string | null
  /** Declared duration (params), replaced by real media duration once probed. */
  declared: number
  /** Still image slot (image/asset node): no media clock, held for `declared`. */
  still?: boolean
  /** Animatic slot: an ungenerated VIDEO clip playing its INPUT image as a
   *  still. Playback-only — editing gestures keep treating the node as video. */
  placeholder?: boolean
}

/** Shortest length a resize handle can leave (clip trim window, text layer). */
const MIN_RESIZE_SECONDS = 0.2
/** Bounds of a still's hold time when resized by its handles. */
const MIN_STILL_SECONDS = 0.5
const MAX_STILL_SECONDS = 120

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Edge-resize grip on a timeline block. `data-resize-handle` lets the block's
 * HTML5 drag (reorder) recognise and refuse a drag that started on a grip.
 */
function EdgeHandle({
  side,
  onPointerDown,
  title
}: {
  side: 'left' | 'right'
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  title: string
}) {
  return (
    <div
      data-resize-handle
      onPointerDown={onPointerDown}
      title={title}
      className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-accent/60 opacity-0 group-hover:opacity-100 hover:bg-accent ${
        side === 'left' ? 'left-0 rounded-l-md' : 'right-0 rounded-r-md'
      }`}
    />
  )
}

// ── Playback engine ───────────────────────────────────────────────────────────

function usePlaybackEngine(
  clips: EngineClip[],
  audioClips: EngineClip[],
  speechClips: EngineClip[] = [],
  muted = false
) {
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechRef = useRef<HTMLAudioElement | null>(null)
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const [activeIdx, setActiveIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  /**
   * FCP-style shuttle (the L key): preview-only rate MULTIPLIER applied on top
   * of each clip's baked `speed` — every element plays at
   * `clipSpeed × shuttleRate`, so the render-parity speed logic stays intact.
   */
  const [shuttleRate, setShuttleRate] = useState(1)
  /** Mirror for the tick/advance/seek callbacks (state would be a stale closure). */
  const shuttleRateRef = useRef(1)
  const [globalTime, setGlobalTime] = useState(0)
  /** Real media durations, keyed by node id (probed from metadata). */
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({})

  /** The entry's trim window against its real (probed) or declared duration. */
  const trimOf = useCallback(
    (clip: EngineClip) => segmentTrim(clip.segment, mediaDurations[clip.node.id] ?? clip.declared),
    [mediaDurations]
  )

  /** Raw (untrimmed) length: probed media duration, else the declared one. */
  const rawDurationOf = useCallback(
    (clip: EngineClip) => mediaDurations[clip.node.id] ?? clip.declared,
    [mediaDurations]
  )

  const durationOf = useCallback(
    (clip: EngineClip) => {
      // A still has no media: its declared length IS its trim window already.
      if (clip.still) return clip.declared
      const raw = mediaDurations[clip.node.id] ?? clip.declared
      const { start, end } = segmentTrim(clip.segment, raw)
      // Timeline seconds: the media window divided by the playback speed —
      // the same division the render's clipEffectiveDuration applies.
      return Math.max(0, (end ?? raw) - start) / clipSpeed(clip.node)
    },
    [mediaDurations]
  )

  /** Transition overlap taken out of entry i's slot (0 on the last entry / a cut). */
  const overlapAfter = useCallback(
    (i: number) => {
      if (i < 0 || i >= clips.length - 1) return 0
      const segment = clips[i]?.segment
      if (!segment || segmentTransitionAfter(segment) === null) return 0
      return segmentTransitionSeconds(segment)
    },
    [clips]
  )

  /**
   * The clip's exclusive slot on the FINAL timeline: its trimmed duration minus
   * the overlap its transition takes out of the film — the same subtraction the
   * render applies (renderedDurationSeconds), so the preview clock, the ruler
   * and the exported file all agree on where things land.
   */
  const slotDurationOf = useCallback(
    (clip: EngineClip, i: number) => Math.max(0, durationOf(clip) - overlapAfter(i)),
    [durationOf, overlapAfter]
  )

  const starts = useMemo(() => {
    const out: number[] = []
    let acc = 0
    clips.forEach((clip, i) => {
      out.push(acc)
      acc += slotDurationOf(clip, i)
    })
    return out
  }, [clips, slotDurationOf])

  const total = useMemo(
    () => clips.reduce((acc, clip, i) => acc + slotDurationOf(clip, i), 0),
    [clips, slotDurationOf]
  )

  // Audio lanes (music bed + speech): the SAME shared layout the MP4 render
  // uses (audioLaneStarts) — explicit offsets place a track absolutely,
  // offset-less tracks chain after the previous one.
  const audioStarts = useMemo(
    () =>
      audioLaneStarts(
        audioClips.map((c) => ({
          offsetSec: clipTimelineOffset(c.node),
          durationSeconds: durationOf(c)
        }))
      ),
    [audioClips, durationOf]
  )

  const speechStarts = useMemo(
    () =>
      audioLaneStarts(
        speechClips.map((c) => ({
          offsetSec: clipTimelineOffset(c.node),
          durationSeconds: durationOf(c)
        }))
      ),
    [speechClips, durationOf]
  )

  const lastAudioSeekRef = useRef(0)
  const lastSpeechSeekRef = useRef(0)
  const syncLane = useCallback(
    (
      element: HTMLAudioElement | null,
      laneClips: EngineClip[],
      laneStarts: number[],
      lastSeekRef: { current: number },
      t: number,
      shouldPlay: boolean
    ) => {
      if (!element || laneClips.length === 0) return
      // Global preview mute: applied on the element (volume stays the render
      // parity value, so unmuting never has to recompute it).
      if (element.muted !== muted) element.muted = muted
      let idx = -1
      for (let i = 0; i < laneClips.length; i++) {
        const start = laneStarts[i] ?? 0
        // Keep the LAST matching track: offset-positioned tracks may overlap,
        // and the later one wins in the single-element preview (the render
        // mixes both).
        if (t >= start && t < start + durationOf(laneClips[i] as EngineClip)) idx = i
      }
      const clip = idx >= 0 ? laneClips[idx] : undefined
      if (!clip?.url) {
        if (!element.paused) element.pause()
        return
      }
      // Per-track volume parity with the render's `volume=` (an HTMLMediaElement
      // cannot amplify, so gains above 1 only apply to the exported MP4).
      const volume = Math.min(1, clipVolume(clip.node))
      if (element.volume !== volume) element.volume = volume
      // Shuttle: the lanes are slaved to the playhead clock — without the same
      // multiplier the drift corrector would fight a fast playhead every 600 ms.
      if (element.playbackRate !== shuttleRateRef.current) {
        element.playbackRate = shuttleRateRef.current
      }
      const offset = t - (laneStarts[idx] ?? 0) + trimOf(clip).start
      if (!element.src.endsWith(clip.url)) {
        element.src = clip.url
        element.currentTime = offset
      } else {
        // Drift correction is rate-limited: currentTime assignments are async
        // and each one aborts a pending play() — correcting every frame keeps
        // the element paused forever (and non-seekable streams never converge).
        const now = performance.now()
        if (
          !element.seeking &&
          Math.abs(element.currentTime - offset) > 0.5 &&
          now - lastSeekRef.current > 600
        ) {
          lastSeekRef.current = now
          element.currentTime = offset
        }
      }
      if (shouldPlay && element.paused) void element.play().catch(() => undefined)
      if (!shouldPlay && !element.paused) element.pause()
    },
    [durationOf, trimOf, muted]
  )
  const syncAudio = useCallback(
    (t: number, shouldPlay: boolean) => {
      syncLane(audioRef.current, audioClips, audioStarts, lastAudioSeekRef, t, shouldPlay)
      syncLane(speechRef.current, speechClips, speechStarts, lastSpeechSeekRef, t, shouldPlay)
    },
    [audioClips, audioStarts, speechClips, speechStarts, syncLane]
  )

  // Keep the audio lane glued to the playhead in every state.
  useEffect(() => {
    syncAudio(globalTime, playing)
  }, [globalTime, playing, syncAudio])

  // Probe real durations (declared params often differ from delivered media).
  useEffect(() => {
    const probes: HTMLVideoElement[] = []
    for (const clip of [...clips, ...audioClips, ...speechClips]) {
      if (clip.still || !clip.url || mediaDurations[clip.node.id] !== undefined) continue
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.src = clip.url
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration) && probe.duration > 0) {
          setMediaDurations((prev) => ({ ...prev, [clip.node.id]: probe.duration }))
        }
      }
      probes.push(probe)
    }
    return () =>
      probes.forEach((p) => {
        p.src = ''
        p.onloadedmetadata = null
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [[...clips, ...audioClips, ...speechClips].map((c) => `${c.node.id}:${c.url}`).join('|')])

  const activeVideo = () => (activeSlot === 'A' ? videoARef.current : videoBRef.current)
  const standbyVideo = () => (activeSlot === 'A' ? videoBRef.current : videoARef.current)

  const nextPlayableFrom = useCallback(
    (from: number) => {
      for (let i = from; i < clips.length; i++) if (clips[i]?.url) return i
      return -1
    },
    [clips]
  )

  /** Next clip the VIDEO elements can host (stills play on the clock, not a <video>). */
  const nextVideoFrom = useCallback(
    (from: number) => {
      for (let i = from; i < clips.length; i++) {
        const clip = clips[i]
        if (clip?.url && !clip.still) return i
      }
      return -1
    },
    [clips]
  )

  // Keep the active video on the current clip, and the standby preloading the
  // next VIDEO clip (a still in between still wants the following video warm).
  useEffect(() => {
    const clip = clips[activeIdx]
    const active = activeVideo()
    if (active && clip?.url && !clip.still && !active.src.endsWith(clip.url)) {
      active.src = clip.url
      active.load()
    }
    // Preview parity with the render's setpts/atempo retime — times the
    // preview-only shuttle multiplier (L key).
    if (active && clip && !clip.still) {
      active.playbackRate = clipSpeed(clip.node) * shuttleRateRef.current
    }
    const nextIdx = nextVideoFrom(activeIdx + 1)
    const standby = standbyVideo()
    const nextUrl = nextIdx >= 0 ? clips[nextIdx]?.url : null
    if (standby && nextUrl && !standby.src.endsWith(nextUrl)) {
      standby.src = nextUrl
      standby.preload = 'auto'
      standby.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, activeSlot, clips, nextVideoFrom])

  /**
   * Where the still clock resumes from: set on entry into a still, cleared on
   * any seek/play so the tick loop re-anchors at the current playhead.
   */
  const stillAnchorRef = useRef<{ idx: number; wall: number; offset: number } | null>(null)
  /** Mirror of globalTime for the tick loop (state would be a stale closure). */
  const globalTimeRef = useRef(0)
  useEffect(() => {
    globalTimeRef.current = globalTime
  }, [globalTime])

  // Apply a shuttle change live: re-anchor the still clock (wall time elapsed
  // BEFORE the change must not be retroactively rescaled) and bump the playing
  // video's rate — the audio lanes pick the new rate up on the next syncLane
  // pass, and freshly loaded clips read the ref at load time.
  useEffect(() => {
    shuttleRateRef.current = shuttleRate
    stillAnchorRef.current = null
    const clip = clips[activeIdx]
    const video = activeVideo()
    if (video && clip && !clip.still) video.playbackRate = clipSpeed(clip.node) * shuttleRate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuttleRate])

  // EVERY pause path (Space, transport button, end of the edit, a failed
  // play()) lands on `playing: false` — resuming always restarts at 1×.
  useEffect(() => {
    if (!playing) setShuttleRate(1)
  }, [playing])

  /** L key while playing: one step up the shuttle ladder (1×→2×→4×→8×). */
  const cycleShuttle = useCallback(() => setShuttleRate((rate) => nextShuttleRate(rate)), [])

  /**
   * Transition preview: opacity crossfade between the two stacked videos at
   * the swap (duration = the cut's overlap). The outgoing clip freezes on its
   * cut frame and fades out — an approximation of the render's xfade, without
   * the double-`ended` hazard of letting it play on.
   */
  const [fadeMs, setFadeMs] = useState<number | null>(null)
  const fadeTimer = useRef<number | null>(null)

  /** Gapless hop to the next playable clip; stops at the end of the edit. */
  const advance = useCallback(() => {
    // A trimmed clip advances BEFORE its media ends (clock-tick path): the
    // outgoing video must stop, or its later `ended` event double-advances.
    activeVideo()?.pause()
    const nextIdx = nextPlayableFrom(activeIdx + 1)
    if (nextIdx === -1) {
      setPlaying(false)
      setGlobalTime(total)
      return
    }
    const next = clips[nextIdx]
    if (next?.still) {
      // A still has no media to start: the tick loop drives its clock.
      stillAnchorRef.current = null
      setActiveIdx(nextIdx)
      return
    }
    // Split halves (§6.12e): same media, contiguous trim — the media clock is
    // already at the next entry's in-point, so just keep playing. Gapless by
    // construction, no swap needed.
    const current = clips[activeIdx]
    if (next && current && !current.still && next.node.id === current.node.id) {
      const curEnd = trimOf(current).end
      const nextStart = trimOf(next).start
      if (curEnd !== undefined && Math.abs(nextStart - curEnd) < 0.05) {
        setActiveIdx(nextIdx)
        const video = activeVideo()
        if (video) void video.play().catch(() => undefined)
        return
      }
    }
    const standby = standbyVideo()
    const expected = next?.url
    const nextStart = next ? trimOf(next).start : 0
    if (standby && expected && standby.src.endsWith(expected)) {
      // The standby already holds the next clip: swap slots and play instantly.
      const transition = current && !current.still ? segmentTransitionAfter(current.segment) : null
      if (transition !== null && current) {
        // The crossfade preview runs on the wall clock: at a shuttled rate the
        // overlap passes shuttleRate× faster, so the fade must shorten too.
        const ms = Math.round(
          (segmentTransitionSeconds(current.segment) * 1000) / shuttleRateRef.current
        )
        setFadeMs(ms)
        if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current)
        fadeTimer.current = window.setTimeout(() => setFadeMs(null), ms + 80)
      }
      standby.currentTime = nextStart
      if (next) standby.playbackRate = clipSpeed(next.node) * shuttleRateRef.current
      setActiveSlot((s) => (s === 'A' ? 'B' : 'A'))
      setActiveIdx(nextIdx)
      void standby.play()
    } else {
      // Fallback (e.g. skipped over an ungenerated clip): load in place.
      setActiveIdx(nextIdx)
      const active = activeVideo()
      if (active && expected) {
        active.src = expected
        active.currentTime = nextStart
        if (next) active.playbackRate = clipSpeed(next.node) * shuttleRateRef.current
        void active.play()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, clips, nextPlayableFrom, total])

  // Global clock while playing. Also the trim out-point enforcement: `ended`
  // only fires at the MEDIA's end, so a trimmed clip must advance itself.
  // Stills have no media at all: their clock is the wall clock, anchored on
  // entry (stillAnchorRef) and advanced here.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const base = starts[activeIdx] ?? 0
      const clip = clips[activeIdx]
      if (clip?.still) {
        const now = performance.now()
        let anchor = stillAnchorRef.current
        if (!anchor || anchor.idx !== activeIdx) {
          anchor = { idx: activeIdx, wall: now, offset: Math.max(0, globalTimeRef.current - base) }
          stillAnchorRef.current = anchor
        }
        // Stills run on the wall clock — the shuttle multiplies it (the rate
        // effect re-anchors on every change, so past seconds keep their rate).
        const elapsed = anchor.offset + ((now - anchor.wall) / 1000) * shuttleRateRef.current
        const hold = slotDurationOf(clip, activeIdx)
        setGlobalTime(base + Math.min(elapsed, hold))
        if (elapsed >= hold) {
          advance()
          return
        }
        raf = requestAnimationFrame(tick)
        return
      }
      const video = activeVideo()
      if (video && clip) {
        const trim = trimOf(clip)
        const slot = slotDurationOf(clip, activeIdx)
        const speed = clipSpeed(clip.node)
        setGlobalTime(base + Math.min(slot, Math.max(0, (video.currentTime - trim.start) / speed)))
        // A transition-joined clip cuts early: its overlap belongs to the next
        // clip on the final timeline (the render fades the two together there).
        // The cut point is MEDIA time — the overlap scales by the speed.
        if (
          trim.end !== undefined &&
          video.currentTime >= trim.end - overlapAfter(activeIdx) * speed - 0.03
        ) {
          advance()
          return
        }
      } else if (video) {
        setGlobalTime(base + video.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIdx, activeSlot, starts])

  const play = useCallback(() => {
    if (clips.length === 0) return
    let idx = activeIdx
    // Restart from the top when the playhead sits at the end.
    if (globalTime >= total - 0.05) {
      idx = nextPlayableFrom(0)
      if (idx === -1) return
      setActiveIdx(idx)
      setGlobalTime(starts[idx] ?? 0)
    } else if (!clips[idx]?.url) {
      idx = nextPlayableFrom(idx + 1)
      if (idx === -1) return
      setActiveIdx(idx)
    }
    setPlaying(true)
    // Re-anchor the still clock at the current playhead position.
    stillAnchorRef.current = null
    // Give the effect a beat to (re)load the right src before playing.
    const resumeAt = starts[idx] ?? 0
    requestAnimationFrame(() => {
      const clip = clips[idx]
      const video = activeVideo()
      if (video && clip && !clip.still) {
        // A fresh load sits at 0 — snap into the clip's trim window.
        const trim = trimOf(clip)
        if (
          video.currentTime < trim.start - 0.01 ||
          (trim.end !== undefined && video.currentTime >= trim.end - 0.01)
        ) {
          video.currentTime = trim.start
        }
        void video.play().catch(() => setPlaying(false))
      }
      syncAudio(Math.max(resumeAt, globalTime), true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, clips, globalTime, nextPlayableFrom, starts, total])

  const pause = useCallback(() => {
    activeVideo()?.pause()
    audioRef.current?.pause()
    speechRef.current?.pause()
    setPlaying(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, Math.max(total - 0.01, 0)))
      let idx = clips.length - 1
      for (let i = 0; i < clips.length; i++) {
        const start = starts[i] ?? 0
        if (clamped >= start && clamped < start + slotDurationOf(clips[i] as EngineClip, i)) {
          idx = i
          break
        }
      }
      const offset = clamped - (starts[idx] ?? 0)
      setGlobalTime(clamped)
      // Any jump invalidates the still clock's anchor — the tick re-anchors —
      // and cancels an in-flight transition crossfade (seeks are instant).
      stillAnchorRef.current = null
      setFadeMs(null)
      const clip = clips[idx]
      if (!clip) return
      if (idx !== activeIdx) setActiveIdx(idx)
      requestAnimationFrame(() => {
        const video = activeVideo()
        if (video && clip.url && !clip.still) {
          if (!video.src.endsWith(clip.url)) {
            video.src = clip.url
            video.load()
          }
          // The timeline offset is inside the TRIMMED clip — shift into media
          // time (timeline seconds × speed).
          video.currentTime = offset * clipSpeed(clip.node) + trimOf(clip).start
          video.playbackRate = clipSpeed(clip.node) * shuttleRateRef.current
          if (playing) void video.play().catch(() => setPlaying(false))
        }
        syncAudio(clamped, playing)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeVideo/syncAudio are deliberately unstable helpers read at call time
    [activeIdx, activeSlot, clips, slotDurationOf, playing, starts, total]
  )

  return {
    videoARef,
    videoBRef,
    audioRef,
    speechRef,
    audioStarts,
    speechStarts,
    activeSlot,
    activeIdx,
    setActiveIdx,
    playing,
    play,
    pause,
    seek,
    advance,
    shuttleRate,
    cycleShuttle,
    globalTime,
    starts,
    total,
    durationOf,
    rawDurationOf,
    fadeMs
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TimelineV2({
  graph,
  videoId,
  onFocusNode,
  jumpToNodeRef,
  collapsed,
  setCollapsed
}: {
  graph: WorkflowGraph
  videoId: string
  onFocusNode?: (nodeId: string) => void
  /**
   * Canvas → timeline command channel (mirror of `onFocusNode`): the editor
   * holds the ref, the timeline registers its seek-to-node handler in it —
   * same latest-handler-in-a-ref pattern as the editor's handleRunNodeRef.
   */
  jumpToNodeRef?: MutableRefObject<((nodeId: string) => void) | null>
  collapsed: boolean
  setCollapsed: (v: boolean) => void
}) {
  const { t } = useTranslation()
  // Clip inspector popover: anchored to the scissors button that opened it.
  const [editClip, setEditClip] = useState<{ idx: number; x: number; y: number } | null>(null)
  // Audio track inspector (volume): anchored to the double-clicked lane block.
  const [editAudio, setEditAudio] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  // Live drag of an audio block along the timeline (absolute offset).
  const [audioDrag, setAudioDrag] = useState<{ id: string; startSec: number } | null>(null)
  // Sticker track (§6.12d): picker anchor, live lane drag, inspector.
  const [stickerPicker, setStickerPicker] = useState<{ x: number; y: number } | null>(null)
  const [stickerDrag, setStickerDrag] = useState<{ id: string; startSec: number } | null>(null)
  const [editSticker, setEditSticker] = useState<{ id: string; x: number; y: number } | null>(null)
  /** Live position of a sticker dragged on the player (ref: no render lag). */
  const stickerPlayerDragRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const [stickerPlayerDrag, setStickerPlayerDrag] = useState<{
    id: string
    x: number
    y: number
  } | null>(null)
  // Drag-to-reorder: index the drag started from.
  const dragFrom = useRef<number | null>(null)
  // Horizontal zoom of the track (1 = fit; the track scrolls beyond that).
  const [zoom, setZoom] = useState(1)
  // Title track (§6.12b): layer being edited, live drags (player + lane).
  const [editLayer, setEditLayer] = useState<{ id: string; x: number; y: number } | null>(null)
  const [layerDrag, setLayerDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  /** Live position of the player drag — a ref so pointermove never lags a render. */
  const playerDragRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const [laneDrag, setLaneDrag] = useState<{ id: string; startSec: number } | null>(null)
  const playerRef = useRef<HTMLDivElement | null>(null)
  const [playerHeight, setPlayerHeight] = useState(0)
  const clipNodes = useMemo(() => collectTimelineClips(graph.nodes), [graph.nodes])
  // Audio lanes through the SAME shared resolver as the MP4 render — a plain
  // filter() would play the tracks in DB creation order while the export
  // follows timelineOrder, and the two must never disagree.
  const audioNodes = useMemo(() => collectAudioNodes(graph.nodes, 'music'), [graph.nodes])
  // §8 — the speech lane (ElevenLabs voice-over/dialogue): its own lane, mixed
  // OVER the music at render time, so previewed the same way.
  const speechNodes = useMemo(() => collectAudioNodes(graph.nodes, 'speech'), [graph.nodes])
  const generations = useVideoGenerations(videoId).data
  const fallbackImages = useTimelineFallbackImages(videoId).data
  const textLayers = useTextLayers(videoId).data ?? []
  const imageLayers = useImageLayers(videoId).data ?? []
  // Asset-node media (url + mime): what an asset still displays, and how the
  // add-image picker knows an asset is an image at all.
  const assetMedia = useAssetNodeMedia(videoId, graph.nodes).data
  // Add-image picker popover (anchored to the header button).
  const [imagePicker, setImagePicker] = useState<{ x: number; y: number } | null>(null)
  // Feedback bucket (§6.13): quick note on the frame under the playhead. The
  // context is FROZEN at open time so a late seek can't shift the timecode.
  const [notePopover, setNotePopover] = useState<{
    x: number
    y: number
    timecodeSec: number
    nodeId: string | null
    nodeLabel: string | null
  } | null>(null)
  const noteButtonRef = useRef<HTMLButtonElement | null>(null)
  // Live edge-resize of a clip block (video/still/audio): duration override
  // applied to the track's widths only — playback keeps the committed trim.
  const [clipResize, setClipResize] = useState<{ id: string; duration: number } | null>(null)
  // Live edge-resize of a text layer block (start/end override).
  const [layerResize, setLayerResize] = useState<{
    id: string
    startSec: number
    endSec: number
  } | null>(null)

  // The player's pixel height sizes the layer previews (sizePct = % of height).
  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    setPlayerHeight(el.clientHeight)
    // Deferred to the next frame: a synchronous setState here re-lays-out
    // within the same observation cycle and trips Chromium's
    // "ResizeObserver loop" warning on every window resize.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setPlayerHeight(el.clientHeight))
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [collapsed, clipNodes.length])

  // Animatic mode (persisted, ON by default): a video clip with no output yet
  // plays its INPUT image as a still for its declared duration — the whole
  // film reviews (and annotates) from its start frames before any credit.
  const [inputStills, setInputStills] = useInputStills()

  const clips: EngineClip[] = useMemo(() => {
    return collectTimelineEntries(graph.nodes).map((entry) => {
      const node = entry.node
      const still = isStillClip(node)
      const gens = (generations ?? []).filter((g) => g.nodeId === node.id)
      const best = bestGeneration(node, gens)
      const genUrl = best?.status === 'success' ? (best.url ?? null) : null
      const mediaUrl =
        node.modelId === 'studio/asset' ? (assetMedia?.[node.id]?.url ?? null) : genUrl
      const placeholderUrl =
        !still && !mediaUrl && inputStills ? (fallbackImages?.[node.id] ?? null) : null
      return {
        node,
        segment: entry.segment,
        segmentIndex: entry.segmentIndex,
        entryId: entry.entryId,
        url: mediaUrl ?? placeholderUrl,
        declared: still ? stillClipSeconds(node) : (clipDuration(node) ?? DEFAULT_CLIP_SECONDS),
        // A placeholder plays like a still (no media clock) but keeps its
        // declared VIDEO duration and stays a video node for every edit.
        still: still || placeholderUrl !== null,
        placeholder: placeholderUrl !== null
      }
    })
  }, [graph.nodes, generations, assetMedia, fallbackImages, inputStills])

  const toAudioClip = useCallback(
    (node: GraphNode): EngineClip => {
      const gens = (generations ?? []).filter((g) => g.nodeId === node.id)
      const best = bestGeneration(node, gens)
      return {
        node,
        segment: clipSegments(node)[0]!,
        segmentIndex: 0,
        entryId: `${node.id}#0`,
        url: best?.status === 'success' ? (best.url ?? null) : null,
        declared: clipDuration(node) ?? DEFAULT_CLIP_SECONDS
      }
    },
    [generations]
  )
  const audioClips: EngineClip[] = useMemo(
    () => audioNodes.map(toAudioClip),
    [audioNodes, toAudioClip]
  )
  const speechClips: EngineClip[] = useMemo(
    () => speechNodes.map(toAudioClip),
    [speechNodes, toAudioClip]
  )

  // Preview-only mute (persisted): silences clips + both audio lanes at once.
  const [muted, setMuted] = useMuted()
  const engine = usePlaybackEngine(clips, audioClips, speechClips, muted)
  // Everything in flight (queued rows included — they hold a slot too), so the
  // header chip reports how much work is actually pending, not just 'running'.
  const inFlightCount = (generations ?? []).filter(
    (g) => g.status === 'running' || g.status === 'pending'
  ).length
  const trackRef = useRef<HTMLDivElement | null>(null)
  const scrubbing = useRef(false)
  // Same persisted height as timeline v1 — drag the top edge to grow the player.
  const { height, startDrag, dragging } = useResizableHeight()

  const timeAtPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || engine.total === 0) return 0
      const rect = track.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * engine.total
    },
    [engine.total]
  )

  /**
   * Edge-resize drag: converts pixel deltas to seconds (at the scale frozen
   * when the drag starts) and streams them to the caller, which owns the live
   * override state and the commit. Pointer events only — the parent clip's
   * HTML5 drag (reorder) is suppressed via the handle's data attribute.
   */
  const startResize = useCallback(
    (
      e: ReactPointerEvent,
      handlers: { onDelta: (deltaSec: number) => void; onCommit: (deltaSec: number) => void }
    ) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || engine.total <= 0) return
      const secPerPx = engine.total / rect.width
      const originX = e.clientX
      document.body.style.userSelect = 'none'
      let last = 0
      const move = (ev: PointerEvent) => {
        last = (ev.clientX - originX) * secPerPx
        handlers.onDelta(last)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.userSelect = ''
        handlers.onCommit(last)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [engine.total]
  )

  /** Track-display duration of an entry, honouring an in-flight edge resize. */
  const displayDur = useCallback(
    (clip: EngineClip) =>
      clipResize?.id === clip.entryId ? clipResize.duration : engine.durationOf(clip),
    [clipResize, engine]
  )
  /** Block width on the track: the entry's SLOT (transition overlap subtracted),
   *  so block edges line up with the playhead/ruler final-timeline scale. */
  const displaySlot = useCallback(
    (clip: EngineClip, i: number) => {
      if (i >= clips.length - 1 || segmentTransitionAfter(clip.segment) === null) {
        return displayDur(clip)
      }
      return Math.max(0, displayDur(clip) - segmentTransitionSeconds(clip.segment))
    },
    [clips.length, displayDur]
  )
  const displayTotal = useMemo(
    () => clips.reduce((acc, c, i) => acc + displaySlot(c, i), 0),
    [clips, displaySlot]
  )

  // Images the add-image picker offers: image-kind nodes with a successful
  // output, plus image assets — excluding what already sits on the timeline.
  const imageCandidates = useMemo(() => {
    const placed = new Set(clipNodes.map((n) => n.id))
    const out: Array<{ node: GraphNode; url: string }> = []
    for (const node of graph.nodes) {
      if (placed.has(node.id)) continue
      if (node.modelId === 'studio/asset') {
        const media = assetMedia?.[node.id]
        if (media?.url && media.mimeType?.startsWith('image/')) {
          out.push({ node, url: media.url })
        }
      } else if (getModel(node.modelId)?.kind === 'image') {
        const best = bestGeneration(
          node,
          (generations ?? []).filter((g) => g.nodeId === node.id)
        )
        if (best?.status === 'success' && best.url) out.push({ node, url: best.url })
      }
    }
    return out
  }, [graph.nodes, clipNodes, generations, assetMedia])

  const addImageToTimeline = (nodeId: string) => {
    setImagePicker(null)
    const uniq = clips.map((c) => c.node.id).filter((id, i, arr) => arr.indexOf(id) === i)
    void invoke('nodes:setTimelineOrder', { videoId, nodeIds: [...uniq, nodeId] })
  }

  /** Preview URL of a sticker's image (node output, or the asset's media). */
  const stickerUrl = useCallback(
    (layer: ImageLayer): string | null => {
      if (layer.nodeId) {
        const node = graph.nodes.find((n) => n.id === layer.nodeId)
        if (!node) return null
        if (node.modelId === 'studio/asset') return assetMedia?.[node.id]?.url ?? null
        const best = bestGeneration(
          node,
          (generations ?? []).filter((g) => g.nodeId === layer.nodeId)
        )
        return best?.status === 'success' ? (best.url ?? null) : null
      }
      if (layer.assetId) {
        const holder = graph.nodes.find(
          (n) =>
            n.modelId === 'studio/asset' &&
            (n.params as { assetId?: string } | undefined)?.assetId === layer.assetId
        )
        return holder ? (assetMedia?.[holder.id]?.url ?? null) : null
      }
      return null
    },
    [graph.nodes, generations, assetMedia]
  )

  /** Sticker creation from the picker: an asset NODE stores its assetId (asset
   *  nodes have no generations — the render reads the asset's stored file). */
  const addSticker = (nodeId: string) => {
    const anchor = stickerPicker
    setStickerPicker(null)
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const start = Math.max(0, Math.round(engine.globalTime * 10) / 10)
    const assetId =
      node.modelId === 'studio/asset'
        ? ((node.params as { assetId?: string } | undefined)?.assetId ?? null)
        : null
    if (node.modelId === 'studio/asset' && !assetId) return
    void invoke('imageLayers:create', {
      videoId,
      startSec: start,
      endSec: start + 3,
      ...(assetId ? { assetId } : { nodeId })
    }).then((layer) => {
      if (anchor) setEditSticker({ id: layer.id, x: anchor.x, y: anchor.y })
    })
  }

  /** Edge resize of a sticker block: its in/out on the final timeline. */
  const beginStickerResize = useCallback(
    (layer: ImageLayer, side: 'left' | 'right') => (e: ReactPointerEvent) => {
      const origStart = layer.startSec
      const origEnd = layer.endSec
      const startAt = (d: number) => clamp(origStart + d, 0, origEnd - MIN_RESIZE_SECONDS)
      const endAt = (d: number) => Math.max(origStart + MIN_RESIZE_SECONDS, origEnd + d)
      startResize(e, {
        onDelta: () => undefined,
        onCommit: (d) => {
          if (side === 'left') {
            const s = Math.round(startAt(d) * 10) / 10
            if (Math.abs(s - origStart) < 0.05) return
            void invoke('imageLayers:update', { id: layer.id, patch: { startSec: s } })
          } else {
            const out = Math.round(endAt(d) * 10) / 10
            if (Math.abs(out - origEnd) < 0.05) return
            void invoke('imageLayers:update', { id: layer.id, patch: { endSec: out } })
          }
        }
      })
    },
    [startResize]
  )

  /**
   * Edge resize of a clip block. A video/audio clip trims its media (same
   * journaled nodes:setTrim as the scissors popover — ⌘Z undoes it); a still
   * has no media, so either grip just changes its hold time.
   */
  const beginClipResize = useCallback(
    (clip: EngineClip, side: 'left' | 'right') => (e: ReactPointerEvent) => {
      const node = clip.node
      // A placeholder is a VIDEO node: its grips trim the media window like
      // any clip (the still path would overwrite the trim as a hold time).
      if (clip.still && !clip.placeholder) {
        const orig = stillClipSeconds(node)
        const durAt = (d: number) =>
          clamp(side === 'right' ? orig + d : orig - d, MIN_STILL_SECONDS, MAX_STILL_SECONDS)
        startResize(e, {
          onDelta: (d) => setClipResize({ id: clip.entryId, duration: durAt(d) }),
          onCommit: (d) => {
            setClipResize(null)
            const dur = Math.round(durAt(d) * 10) / 10
            if (Math.abs(dur - orig) < 0.05) return
            void invoke('nodes:setTrim', { nodeId: node.id, trimStartSec: null, trimEndSec: dur })
          }
        })
        return
      }
      const raw = engine.rawDurationOf(clip)
      const { start: origStart, end } = segmentTrim(clip.segment, raw)
      const origEnd = end ?? raw
      const speed = clipSpeed(node)
      // Drag deltas arrive in TIMELINE seconds; the trim window is MEDIA time.
      const startAt = (d: number) => clamp(origStart + d * speed, 0, origEnd - MIN_RESIZE_SECONDS)
      const endAt = (d: number) => clamp(origEnd + d * speed, origStart + MIN_RESIZE_SECONDS, raw)
      startResize(e, {
        onDelta: (d) =>
          setClipResize({
            id: clip.entryId,
            // The live width preview is timeline seconds — media window ÷ speed.
            duration: (side === 'left' ? origEnd - startAt(d) : endAt(d) - origStart) / speed
          }),
        onCommit: (d) => {
          setClipResize(null)
          if (side === 'left') {
            const s = Math.round(startAt(d) * 100) / 100
            if (Math.abs(s - origStart) < 0.02) return
            void invoke('nodes:setTrim', {
              nodeId: node.id,
              trimStartSec: s > 0 ? s : null,
              trimEndSec: clip.segment.trimEndSec ?? null,
              segmentIndex: clip.segmentIndex
            })
          } else {
            const out = Math.round(endAt(d) * 100) / 100
            if (Math.abs(out - origEnd) < 0.02) return
            void invoke('nodes:setTrim', {
              nodeId: node.id,
              trimStartSec: clip.segment.trimStartSec ?? null,
              // Back at the media's end = no out-point at all.
              trimEndSec: out >= raw - 0.01 ? null : out,
              segmentIndex: clip.segmentIndex
            })
          }
        }
      })
    },
    [engine, startResize]
  )

  /** Edge resize of a text layer block: its in/out on the final timeline. */
  const beginLayerResize = useCallback(
    (layer: TextLayer, side: 'left' | 'right') => (e: ReactPointerEvent) => {
      const origStart = layer.startSec
      const origEnd = layer.endSec
      const startAt = (d: number) => clamp(origStart + d, 0, origEnd - MIN_RESIZE_SECONDS)
      const endAt = (d: number) => Math.max(origStart + MIN_RESIZE_SECONDS, origEnd + d)
      startResize(e, {
        onDelta: (d) =>
          setLayerResize(
            side === 'left'
              ? { id: layer.id, startSec: startAt(d), endSec: origEnd }
              : { id: layer.id, startSec: origStart, endSec: endAt(d) }
          ),
        onCommit: (d) => {
          setLayerResize(null)
          if (side === 'left') {
            const s = Math.round(startAt(d) * 10) / 10
            if (Math.abs(s - origStart) < 0.05) return
            void invoke('textLayers:update', { id: layer.id, patch: { startSec: s } })
          } else {
            const out = Math.round(endAt(d) * 10) / 10
            if (Math.abs(out - origEnd) < 0.05) return
            void invoke('textLayers:update', { id: layer.id, patch: { endSec: out } })
          }
        }
      })
    },
    [startResize]
  )

  // Scrub with pointer capture on the track.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (scrubbing.current) engine.seek(timeAtPointer(e.clientX))
    }
    const up = () => {
      scrubbing.current = false
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [engine, timeAtPointer])

  // Space = play/pause everywhere in the editor (FCP-style), except while typing.
  const { playing, play, pause } = engine
  useShortcut('playPause', (event) => {
    if (event.repeat) return
    // A focused <video> (generation card, lightbox) owns Space for its own
    // play/pause — the shared typing guard doesn't cover that case.
    if ((event.target as HTMLElement | null)?.tagName === 'VIDEO') return
    if (playing) pause()
    else play()
  })

  // L = FCP-style shuttle: play forward; repeated presses step the preview
  // rate 1× → 2× → 4× → 8×. Any pause path resets the rate to 1×.
  useShortcut('shuttleForward', (event) => {
    if (event.repeat) return
    // Same carve-out as Space: a focused <video> owns its own transport keys.
    if ((event.target as HTMLElement | null)?.tagName === 'VIDEO') return
    if (playing) engine.cycleShuttle()
    else play()
  })

  /** Split point (MEDIA seconds) of entry idx at the playhead, or null when
   *  the playhead sits outside it / too close to an edge / it's a still. */
  const splitPointOf = useCallback(
    (idx: number): number | null => {
      const clip = clips[idx]
      if (!clip || clip.still || !clip.url) return null
      const start = engine.starts[idx] ?? 0
      const slot = displaySlot(clip, idx)
      if (engine.globalTime <= start + 0.05 || engine.globalTime >= start + slot - 0.05) return null
      const raw = engine.rawDurationOf(clip)
      const at =
        segmentTrim(clip.segment, raw).start + (engine.globalTime - start) * clipSpeed(clip.node)
      return Math.round(at * 100) / 100
    },
    [clips, displaySlot, engine]
  )

  // S = razor: split the clip under the playhead (CapCut/FCP habit).
  useShortcut('splitClip', (event) => {
    if (event.repeat) return
    const at = splitPointOf(engine.activeIdx)
    const clip = clips[engine.activeIdx]
    if (at === null || !clip) return
    void invoke('nodes:splitClip', { nodeId: clip.node.id, atMediaSec: at })
  })

  // , / . = one timecode frame back/forward; I / O = set the in/out of the
  // clip under the playhead AT the playhead (the NLE three-point habit).
  useShortcut('stepBack', () => engine.seek(engine.globalTime - 1 / TIMECODE_FPS))
  useShortcut('stepForward', () => engine.seek(engine.globalTime + 1 / TIMECODE_FPS))
  useShortcut('trimIn', () => {
    const clip = clips[engine.activeIdx]
    const at = splitPointOf(engine.activeIdx)
    if (!clip || at === null) return
    void invoke('nodes:setTrim', {
      nodeId: clip.node.id,
      trimStartSec: at,
      trimEndSec: clip.segment.trimEndSec ?? null,
      segmentIndex: clip.segmentIndex
    })
  })
  useShortcut('trimOut', () => {
    const clip = clips[engine.activeIdx]
    const at = splitPointOf(engine.activeIdx)
    if (!clip || at === null) return
    void invoke('nodes:setTrim', {
      nodeId: clip.node.id,
      trimStartSec: clip.segment.trimStartSec ?? null,
      trimEndSec: at,
      segmentIndex: clip.segmentIndex
    })
  })

  // N = note the frame under the playhead into the feedback bucket (§6.13):
  // pauses, freezes the timecode + node identity, opens the note popover.
  // Plain function — useShortcut keeps its handler in a ref, no memo needed.
  const openNotePopover = (anchor: { x: number; y: number }): void => {
    engine.pause()
    const clip = clips[engine.activeIdx]
    setNotePopover({
      ...anchor,
      timecodeSec: Math.round(engine.globalTime * 10) / 10,
      nodeId: clip?.node.id ?? null,
      nodeLabel: clip
        ? (clip.node.label ?? getModel(clip.node.modelId)?.label ?? clip.node.key)
        : null
    })
  }
  useShortcut('addNote', (event) => {
    if (event.repeat) return
    const button = noteButtonRef.current
    if (!button) return
    const r = button.getBoundingClientRect()
    openNotePopover({ x: r.left + r.width / 2, y: r.top - 6 })
  })

  // Seek-to-node handler for the canvas (a video node's "see in timeline"
  // button): jump the playhead to the node's FIRST entry through the engine's
  // own starts — the exact final-timeline resolution the preview clock plays
  // (trims, speed and transition overlaps already applied). Registered above
  // the collapsed early-return so a jump always lands, even while hidden.
  const { seek, starts } = engine
  useEffect(() => {
    if (!jumpToNodeRef) return
    jumpToNodeRef.current = (nodeId: string) => {
      const idx = clips.findIndex((c) => c.node.id === nodeId)
      if (idx >= 0) seek(starts[idx] ?? 0)
    }
    return () => {
      jumpToNodeRef.current = null
    }
  }, [jumpToNodeRef, clips, seek, starts])

  /** Magnetic drag targets: every entry boundary (the playhead joins at drag time). */
  const snapTargets = useMemo(() => {
    const out = [0]
    clips.forEach((c, i) => {
      const s = engine.starts[i] ?? 0
      out.push(s, s + displaySlot(c, i))
    })
    return out
  }, [clips, engine.starts, displaySlot])

  if (collapsed) {
    return (
      <div className="island flex items-center gap-3 overflow-hidden px-3 py-1.5 text-[11px]">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-semibold text-neutral-200 hover:bg-neutral-800"
          title={t('timeline.show')}
        >
          <Film className="h-3.5 w-3.5 text-accent" /> {t('timeline.title')}
          <ChevronUp className="h-3.5 w-3.5 text-neutral-400" />
        </button>
        {clips.length > 0 && (
          <span className="text-neutral-500">
            {t('timeline.clipCount', { count: clips.length })} · {fmt(engine.total)}
          </span>
        )}
      </div>
    )
  }

  if (clips.length === 0) {
    return (
      <>
        <div className="island relative flex h-32 items-center justify-center overflow-hidden text-xs text-neutral-600">
          <Film className="mr-2 h-4 w-4" /> {t('timeline.empty')}
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setImagePicker((v) => (v ? null : { x: r.left + r.width / 2, y: r.top - 6 }))
            }}
            className="absolute top-2 right-8 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.addImage')}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="absolute top-2 right-2 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.hide')}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
        {imagePicker && (
          <ImagePickerPopover
            candidates={imageCandidates}
            anchor={imagePicker}
            onPick={addImageToTimeline}
            onClose={() => setImagePicker(null)}
          />
        )}
      </>
    )
  }

  const activeClip = clips[engine.activeIdx]
  // Live approximation of the clip's baked colour look (render parity: the
  // registry declares both the ffmpeg fragment and this CSS equivalent).
  const lookFilter = activeClip ? lookCssFilter(clipLook(activeClip.node)) : 'none'
  // Opacity crossfade during a previewed transition (see usePlaybackEngine).
  const videoFadeStyle = engine.fadeMs
    ? { transition: `opacity ${engine.fadeMs}ms ease-in-out` }
    : undefined

  return (
    <div className="relative shrink-0" style={{ height }}>
      {/* Resize handle: straddles the island's top edge (in the gap between the
          two islands), so it never sits over the header's transport buttons —
          an in-island strip used to swallow clicks on the play button. */}
      <div
        onPointerDown={startDrag}
        className="group absolute inset-x-0 -top-1.5 z-30 h-3 cursor-row-resize"
        title={t('timeline.resize')}
      >
        <div
          className={`mx-auto mt-1 h-1 w-16 rounded-full transition ${
            dragging ? 'bg-accent' : 'bg-neutral-700 group-hover:bg-accent'
          }`}
        />
      </div>
      <div className="island flex h-full flex-col overflow-hidden">
        {/* ── Header: transport controls + global clock ───────────────────── */}
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[11px]">
          <span className="flex items-center gap-1.5 font-semibold text-neutral-200">
            <Film className="h-3.5 w-3.5 text-accent" /> {t('timeline.title')}
          </span>
          <span className="text-neutral-500">
            {t('timeline.clipCount', { count: clips.length })}
          </span>
          {inFlightCount > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <Loader2 className="h-3 w-3 animate-spin" />{' '}
              {t('timeline.generatingCount', { count: inFlightCount })}
            </span>
          )}

          <div className="mx-auto flex items-center gap-1">
            <button
              onClick={() => {
                const prev = Math.max(0, engine.activeIdx - 1)
                engine.seek(engine.starts[prev] ?? 0)
              }}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              title={t('timeline.prevClip')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => (engine.playing ? engine.pause() : engine.play())}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-neutral-900 hover:bg-accent-hover"
              aria-label={engine.playing ? t('timeline.pause') : t('timeline.play')}
            >
              {engine.playing ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5 pl-0.5" />
              )}
            </button>
            <button
              onClick={() => {
                const next = Math.min(clips.length - 1, engine.activeIdx + 1)
                engine.seek(engine.starts[next] ?? 0)
              }}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              title={t('timeline.nextClip')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <span className="ml-3 flex items-baseline gap-2 text-sm" data-timeline-clock>
              <Timecode seconds={engine.globalTime} />
              <span className="text-[10px] text-neutral-600">
                / <Timecode seconds={engine.total} dimAll />
              </span>
            </span>
            {engine.shuttleRate > 1 && (
              <span
                className="ml-1 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent"
                title={t('timeline.shuttleRate', { rate: engine.shuttleRate })}
                data-timeline-shuttle
              >
                {engine.shuttleRate}×
              </span>
            )}
            <button
              onClick={() => setMuted(!muted)}
              className={`ml-1 rounded p-1 hover:bg-neutral-800 ${muted ? 'text-warning' : 'text-neutral-400 hover:text-neutral-100'}`}
              title={muted ? t('timeline.unmute') : t('timeline.mute')}
              data-timeline-mute
            >
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
          </div>

          <button
            onClick={() => setInputStills(!inputStills)}
            className={`rounded p-1 hover:bg-neutral-800 ${inputStills ? 'text-accent-soft hover:text-accent-soft' : 'text-neutral-500 hover:text-neutral-200'}`}
            title={inputStills ? t('timeline.inputStillsOn') : t('timeline.inputStillsOff')}
            data-timeline-input-stills
          >
            {inputStills ? (
              <ImageIcon className="h-3.5 w-3.5" />
            ) : (
              <ImageOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            ref={noteButtonRef}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              openNotePopover({ x: r.left + r.width / 2, y: r.top - 6 })
            }}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.addNote')}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const start = Math.max(0, Math.round(engine.globalTime * 10) / 10)
              void invoke('textLayers:create', {
                videoId,
                content: t('timeline.newLayerText'),
                startSec: start,
                endSec: start + 3
              }).then((layer) =>
                setEditLayer({ id: layer.id, x: r.left + r.width / 2, y: r.top - 6 })
              )
            }}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.addText')}
          >
            <Type className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setImagePicker((v) => (v ? null : { x: r.left + r.width / 2, y: r.top - 6 }))
            }}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.addImage')}
          >
            <ImagePlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setStickerPicker((v) => (v ? null : { x: r.left + r.width / 2, y: r.top - 6 }))
            }}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.addSticker')}
          >
            <StickerIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
            disabled={zoom <= 1}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            title={t('timeline.zoomOut')}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
            disabled={zoom >= 8}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            title={t('timeline.zoomIn')}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('timeline.hide')}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>

        {/* ── Main row: gapless player + track ──────────────────────────────── */}
        <div className="flex min-h-0 flex-1">
          {/* Player: two stacked videos, the active one visible. Width follows the
            timeline height (16:9), so resizing the island enlarges the player. */}
          <div
            ref={playerRef}
            className="video-stack relative aspect-video flex-shrink-0 cursor-pointer border-r border-neutral-800 bg-black"
            onClick={() => (engine.playing ? engine.pause() : engine.play())}
            title={t('timeline.playPause')}
          >
            <video
              ref={engine.videoARef}
              onEnded={engine.advance}
              playsInline
              muted={muted}
              style={{ filter: lookFilter, ...videoFadeStyle }}
              className={`absolute inset-0 h-full w-full ${engine.activeSlot === 'A' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            />
            <video
              ref={engine.videoBRef}
              onEnded={engine.advance}
              playsInline
              muted={muted || engine.activeSlot === 'A'}
              style={{ filter: lookFilter, ...videoFadeStyle }}
              className={`absolute inset-0 h-full w-full ${engine.activeSlot === 'B' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            />
            <audio ref={engine.audioRef} className="hidden" />
            <audio ref={engine.speechRef} className="hidden" />
            {/* Still slot: the image itself covers the (paused) video stack. */}
            {activeClip?.still && activeClip.url && (
              <img
                src={activeClip.url}
                alt=""
                style={{ filter: lookFilter }}
                className="absolute inset-0 z-[5] h-full w-full bg-black object-contain"
              />
            )}
            {/* Animatic badge: this frame is the clip's INPUT image, not a result. */}
            {activeClip?.placeholder && activeClip.url && (
              <div className="absolute bottom-2 left-2 z-[6] flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-neutral-300 backdrop-blur">
                <ImageIcon className="h-3 w-3 text-accent-soft" />
                {t('timeline.inputStillBadge')}
              </div>
            )}
            {!activeClip?.url && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[11px] text-neutral-500">
                {fallbackImages?.[activeClip?.node.id ?? ''] ? (
                  <img
                    src={fallbackImages[activeClip?.node.id ?? '']}
                    alt=""
                    className="absolute inset-0 h-full w-full object-contain opacity-60"
                  />
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4" />
                    <span>{t('timeline.noOutput')}</span>
                  </>
                )}
              </div>
            )}
            {/* Title track preview: layers active at the playhead, draggable to
                reposition (x/y are normalized, so this IS the render position).
                They live on their OWN stacking plane above the video stack —
                elements sitting directly on a composited <video> under the
                island's backdrop-filter are flaky for hit-testing (see the
                CLAUDE.md pitfall) — and the drag uses pointer CAPTURE, so the
                move/up events are delivered to the span whatever the videos
                think of the pointer. */}
            <div
              className="pointer-events-none absolute inset-0 z-20"
              style={{ isolation: 'isolate' }}
            >
              {textLayers
                .filter((l) => engine.globalTime >= l.startSec && engine.globalTime < l.endSec)
                .map((layer) => {
                  const pos = layerDrag?.id === layer.id ? layerDrag : { x: layer.x, y: layer.y }
                  return (
                    <span
                      key={layer.id}
                      className="pointer-events-auto absolute cursor-move whitespace-pre-wrap select-none"
                      style={{
                        left: `${pos.x * 100}%`,
                        top: `${pos.y * 100}%`,
                        transform: anchorTransform(layer.anchor),
                        touchAction: 'none',
                        fontFamily: layer.fontFamily ?? undefined,
                        fontWeight: layer.bold ? 700 : 400,
                        fontStyle: layer.italic ? 'italic' : 'normal',
                        color: layer.colorHex,
                        fontSize: `${Math.max(8, (layer.sizePct / 100) * playerHeight)}px`,
                        textShadow: '0 1px 3px rgba(0,0,0,0.9)'
                      }}
                      title={t('timeline.layerDragHint')}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        playerDragRef.current = { id: layer.id, x: layer.x, y: layer.y }
                        setLayerDrag(playerDragRef.current)
                      }}
                      onPointerMove={(e) => {
                        const drag = playerDragRef.current
                        const rect = playerRef.current?.getBoundingClientRect()
                        if (!drag || drag.id !== layer.id || !rect) return
                        drag.x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                        drag.y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
                        setLayerDrag({ ...drag })
                      }}
                      onPointerUp={(e) => {
                        const drag = playerDragRef.current
                        if (!drag || drag.id !== layer.id) return
                        e.currentTarget.releasePointerCapture(e.pointerId)
                        playerDragRef.current = null
                        setLayerDrag(null)
                        void invoke('textLayers:update', {
                          id: layer.id,
                          patch: {
                            x: Math.round(drag.x * 1000) / 1000,
                            y: Math.round(drag.y * 1000) / 1000
                          }
                        })
                      }}
                      onPointerCancel={() => {
                        playerDragRef.current = null
                        setLayerDrag(null)
                      }}
                    >
                      {layer.content}
                    </span>
                  )
                })}
            </div>
            {/* Sticker preview: composited at render, positioned here — x/y
                being normalized centers, the preview position IS the render
                position. Drag with pointer capture, like the text layers. */}
            <div className="pointer-events-none absolute inset-0 z-[15]">
              {imageLayers
                .filter((l) => engine.globalTime >= l.startSec && engine.globalTime < l.endSec)
                .map((layer) => {
                  const url = stickerUrl(layer)
                  if (!url) return null
                  const pos =
                    stickerPlayerDrag?.id === layer.id
                      ? stickerPlayerDrag
                      : { x: layer.x, y: layer.y }
                  return (
                    <img
                      key={layer.id}
                      src={url}
                      alt=""
                      draggable={false}
                      className="pointer-events-auto absolute cursor-move select-none"
                      style={{
                        left: `${pos.x * 100}%`,
                        top: `${pos.y * 100}%`,
                        width: `${layer.widthPct}%`,
                        transform: 'translate(-50%, -50%)',
                        touchAction: 'none'
                      }}
                      title={t('timeline.stickerDragHint')}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        e.currentTarget.setPointerCapture(e.pointerId)
                        stickerPlayerDragRef.current = { id: layer.id, x: layer.x, y: layer.y }
                        setStickerPlayerDrag(stickerPlayerDragRef.current)
                      }}
                      onPointerMove={(e) => {
                        const drag = stickerPlayerDragRef.current
                        const rect = playerRef.current?.getBoundingClientRect()
                        if (!drag || drag.id !== layer.id || !rect) return
                        drag.x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                        drag.y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
                        setStickerPlayerDrag({ ...drag })
                      }}
                      onPointerUp={(e) => {
                        const drag = stickerPlayerDragRef.current
                        if (!drag || drag.id !== layer.id) return
                        e.currentTarget.releasePointerCapture(e.pointerId)
                        stickerPlayerDragRef.current = null
                        setStickerPlayerDrag(null)
                        void invoke('imageLayers:update', {
                          id: layer.id,
                          patch: {
                            x: Math.round(drag.x * 1000) / 1000,
                            y: Math.round(drag.y * 1000) / 1000
                          }
                        })
                      }}
                      onPointerCancel={() => {
                        stickerPlayerDragRef.current = null
                        setStickerPlayerDrag(null)
                      }}
                    />
                  )
                })}
            </div>
            {/* Text-layer preview: what the render will burn (approximate). */}
            {activeClip?.node.overlay && (
              <div
                className="pointer-events-none absolute inset-0 z-10 flex p-3"
                style={overlayPlacement(activeClip.node.overlay.align)}
              >
                <span
                  className={`font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${
                    activeClip.node.overlay.size === 'sm'
                      ? 'text-xs'
                      : activeClip.node.overlay.size === 'lg'
                        ? 'text-2xl'
                        : 'text-base'
                  }`}
                  style={{ textAlign: overlayPlacement(activeClip.node.overlay.align).textAlign }}
                >
                  {activeClip.node.overlay.text}
                </span>
              </div>
            )}
            {!engine.playing && activeClip?.url && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60">
                  <Play className="h-4 w-4 pl-0.5 text-white" />
                </span>
              </div>
            )}
          </div>

          {/* Track: ruler + proportional clip blocks + playhead. The wrapper
              scrolls horizontally once zoomed past fit. */}
          <div className="flex min-w-0 flex-1 flex-col px-3 py-2">
            <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
              <div
                ref={trackRef}
                className="relative h-full min-w-full cursor-crosshair select-none"
                style={{ width: `${zoom * 100}%` }}
                onPointerDown={(e) => {
                  scrubbing.current = true
                  document.body.style.userSelect = 'none'
                  engine.seek(timeAtPointer(e.clientX))
                }}
              >
                {/* Ruler */}
                <div className="absolute inset-x-0 top-0 h-5 border-b border-neutral-800 text-[9px] text-neutral-600">
                  {engine.total > 0 &&
                    rulerTicks(engine.total).map((t) => (
                      <span
                        key={t}
                        className="absolute top-0 border-l border-neutral-800 pl-1 leading-5"
                        style={{ left: `${(t / engine.total) * 100}%` }}
                      >
                        {formatSeconds(t)}
                      </span>
                    ))}
                </div>

                {/* Clip blocks (video track) */}
                <div
                  className="absolute inset-x-0 top-6 flex"
                  style={{
                    bottom:
                      (audioClips.length > 0 ? 38 : 0) +
                      (speechClips.length > 0 ? 38 : 0) +
                      (textLayers.length > 0 ? 26 : 0) +
                      (imageLayers.length > 0 ? 26 : 0)
                  }}
                >
                  {clips.map((clip, i) => {
                    const width = displayTotal > 0 ? (displaySlot(clip, i) / displayTotal) * 100 : 0
                    const isActive = i === engine.activeIdx
                    const still = fallbackImages?.[clip.node.id]
                    return (
                      <div
                        key={clip.entryId}
                        className={`group relative mr-px min-w-0 overflow-hidden rounded-md border ${
                          isActive ? 'border-accent' : 'border-neutral-800'
                        } ${clip.url ? 'bg-neutral-900' : 'bg-neutral-900/40'}`}
                        style={{ width: `${width}%` }}
                        data-timeline-clip={i}
                        draggable
                        onDragStart={(e) => {
                          // A drag born on a resize grip is a trim, not a reorder.
                          if ((e.target as HTMLElement).closest?.('[data-resize-handle]')) {
                            e.preventDefault()
                            return
                          }
                          dragFrom.current = i
                          scrubbing.current = false
                          document.body.style.userSelect = ''
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault()
                          const from = dragFrom.current
                          dragFrom.current = null
                          if (from === null || from === i) return
                          // Reordering stays NODE-grained: dragging any segment
                          // of a split clip moves the whole clip.
                          const uniq = clips
                            .map((c) => c.node.id)
                            .filter((id, idx, arr) => arr.indexOf(id) === idx)
                          const fromId = clips[from]!.node.id
                          const toId = clips[i]!.node.id
                          if (fromId === toId) return
                          const ids = uniq.filter((id) => id !== fromId)
                          const insertAt =
                            ids.indexOf(toId) + (uniq.indexOf(fromId) < uniq.indexOf(toId) ? 1 : 0)
                          ids.splice(insertAt, 0, fromId)
                          void invoke('nodes:setTimelineOrder', { videoId, nodeIds: ids })
                        }}
                        onDoubleClick={(e) =>
                          setEditClip({ idx: i, x: e.clientX, y: e.clientY - 8 })
                        }
                        onPointerDown={(e) => {
                          // Let the track scrub handler run too, but focus/select this node.
                          e.stopPropagation()
                          scrubbing.current = true
                          document.body.style.userSelect = 'none'
                          engine.seek(timeAtPointer(e.clientX))
                          onFocusNode?.(clip.node.id)
                        }}
                      >
                        {clip.still && clip.url ? (
                          <img
                            src={clip.url}
                            alt=""
                            className="pointer-events-none h-full w-full object-cover opacity-70 group-hover:opacity-100"
                          />
                        ) : clip.url ? (
                          <VideoThumb
                            src={clip.url}
                            overlay={false}
                            className="pointer-events-none h-full w-full object-cover opacity-70 group-hover:opacity-100"
                          />
                        ) : still ? (
                          <img
                            src={still}
                            alt=""
                            className="pointer-events-none h-full w-full object-cover opacity-40"
                          />
                        ) : null}
                        <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pt-3 pb-0.5 text-[9px] text-neutral-200">
                          {clip.still && (
                            <ImagePlus className="mr-1 inline h-2.5 w-2.5 text-accent-soft" />
                          )}
                          {clip.node.label ?? getModel(clip.node.modelId)?.label ?? clip.node.key}
                          {clipSegments(clip.node).length > 1 && (
                            <span className="ml-1 text-warning">
                              {clip.segmentIndex + 1}/{clipSegments(clip.node).length}
                            </span>
                          )}
                          <span className="ml-1 text-neutral-400">{fmt(displayDur(clip))}</span>
                          {!clip.still && clipSpeed(clip.node) !== 1 && (
                            <span className="ml-1 text-accent-soft">×{clipSpeed(clip.node)}</span>
                          )}
                        </div>
                        {!clip.url && (
                          <div className="absolute inset-0 flex items-center justify-center text-[9px] text-neutral-600">
                            {inFlightCount > 0
                              ? t('timeline.clipGenerating')
                              : t('timeline.clipEmpty')}
                          </div>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const r = e.currentTarget.getBoundingClientRect()
                            setEditClip({ idx: i, x: r.left + r.width / 2, y: r.top - 6 })
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="absolute top-0.5 right-0.5 z-10 rounded bg-black/60 p-0.5 text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-neutral-100"
                          title={t('timeline.clipSettings')}
                        >
                          <Scissors className="h-3 w-3" />
                        </button>
                        {segmentTransitionAfter(clip.segment) !== null && i < clips.length - 1 && (
                          <div
                            className="absolute top-6 right-0 bottom-0 w-1 bg-highlight-soft/60"
                            title={t(
                              `timeline.transitions.${segmentTransitionAfter(clip.segment)}` as never
                            )}
                          />
                        )}
                        {(clip.still || clip.url) && (
                          <>
                            <EdgeHandle
                              side="left"
                              title={t(
                                clip.still && !clip.placeholder
                                  ? 'timeline.resizeStill'
                                  : 'timeline.trimIn'
                              )}
                              onPointerDown={beginClipResize(clip, 'left')}
                            />
                            <EdgeHandle
                              side="right"
                              title={t(
                                clip.still && !clip.placeholder
                                  ? 'timeline.resizeStill'
                                  : 'timeline.trimOut'
                              )}
                              onPointerDown={beginClipResize(clip, 'right')}
                            />
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Sticker track: one block per image overlay, same gestures as
                    the title track (drag in time, click to inspect, edge trim). */}
                {imageLayers.length > 0 && engine.total > 0 && (
                  <div
                    className="absolute inset-x-0 h-6"
                    style={{
                      bottom:
                        (audioClips.length > 0 ? 38 : 0) +
                        (speechClips.length > 0 ? 38 : 0) +
                        (textLayers.length > 0 ? 26 : 0)
                    }}
                  >
                    {imageLayers.map((layer) => {
                      const start =
                        stickerDrag?.id === layer.id ? stickerDrag.startSec : layer.startSec
                      const dur = layer.endSec - layer.startSec
                      const left = Math.min(100, (start / engine.total) * 100)
                      const width = Math.max(1.5, Math.min(100 - left, (dur / engine.total) * 100))
                      const url = stickerUrl(layer)
                      return (
                        <div
                          key={layer.id}
                          className="group absolute flex h-full items-center gap-1 overflow-hidden rounded-md border border-warning/50 bg-warning/15 px-1.5 text-[10px] text-warning"
                          style={{ left: `${left}%`, width: `${width}%`, cursor: 'grab' }}
                          title={t('timeline.sticker')}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            const rect = trackRef.current?.getBoundingClientRect()
                            if (!rect) return
                            const originX = e.clientX
                            const origStart = layer.startSec
                            let moved = false
                            let lastStart = origStart
                            const tol = snapTolerance(engine.total, rect.width)
                            const move = (ev: PointerEvent) => {
                              const delta = ((ev.clientX - originX) / rect.width) * engine.total
                              if (Math.abs(ev.clientX - originX) > 3) moved = true
                              lastStart = snapSpan(
                                Math.max(0, origStart + delta),
                                dur,
                                [...snapTargets, engine.globalTime],
                                tol
                              )
                              setStickerDrag({ id: layer.id, startSec: lastStart })
                            }
                            const up = (ev: PointerEvent) => {
                              window.removeEventListener('pointermove', move)
                              window.removeEventListener('pointerup', up)
                              setStickerDrag(null)
                              if (moved) {
                                const startSec = Math.round(lastStart * 10) / 10
                                void invoke('imageLayers:update', {
                                  id: layer.id,
                                  patch: { startSec, endSec: startSec + dur }
                                })
                              } else {
                                setEditSticker({ id: layer.id, x: ev.clientX, y: ev.clientY - 8 })
                              }
                            }
                            window.addEventListener('pointermove', move)
                            window.addEventListener('pointerup', up)
                          }}
                        >
                          {url ? (
                            <img
                              src={url}
                              alt=""
                              className="h-4 w-4 flex-shrink-0 rounded-sm object-cover"
                            />
                          ) : (
                            <StickerIcon className="h-3 w-3 flex-shrink-0" />
                          )}
                          <span className="truncate">{Math.round(layer.widthPct)}%</span>
                          <EdgeHandle
                            side="left"
                            title={t('timeline.layerStart')}
                            onPointerDown={beginStickerResize(layer, 'left')}
                          />
                          <EdgeHandle
                            side="right"
                            title={t('timeline.layerEnd')}
                            onPointerDown={beginStickerResize(layer, 'right')}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Title track: one block per text layer, drag to move in time,
                    click to open its inspector. */}
                {textLayers.length > 0 && engine.total > 0 && (
                  <div
                    className="absolute inset-x-0 h-6"
                    style={{
                      bottom: (audioClips.length > 0 ? 38 : 0) + (speechClips.length > 0 ? 38 : 0)
                    }}
                  >
                    {textLayers.map((layer) => {
                      const resizing = layerResize?.id === layer.id ? layerResize : null
                      const start = resizing
                        ? resizing.startSec
                        : laneDrag?.id === layer.id
                          ? laneDrag.startSec
                          : layer.startSec
                      const dur = resizing
                        ? resizing.endSec - resizing.startSec
                        : layer.endSec - layer.startSec
                      const left = Math.min(100, (start / engine.total) * 100)
                      const width = Math.max(1.5, Math.min(100 - left, (dur / engine.total) * 100))
                      return (
                        <div
                          key={layer.id}
                          className="group absolute flex h-full items-center gap-1 overflow-hidden rounded-md border border-accent/50 bg-accent/15 px-1.5 text-[10px] text-accent-soft"
                          style={{ left: `${left}%`, width: `${width}%`, cursor: 'grab' }}
                          title={layer.content}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            const rect = trackRef.current?.getBoundingClientRect()
                            if (!rect) return
                            const originX = e.clientX
                            const origStart = layer.startSec
                            let moved = false
                            let lastStart = origStart
                            const tol = snapTolerance(engine.total, rect.width)
                            const move = (ev: PointerEvent) => {
                              const delta = ((ev.clientX - originX) / rect.width) * engine.total
                              if (Math.abs(ev.clientX - originX) > 3) moved = true
                              lastStart = snapSpan(
                                Math.max(0, origStart + delta),
                                dur,
                                [...snapTargets, engine.globalTime],
                                tol
                              )
                              setLaneDrag({ id: layer.id, startSec: lastStart })
                            }
                            const up = (ev: PointerEvent) => {
                              window.removeEventListener('pointermove', move)
                              window.removeEventListener('pointerup', up)
                              setLaneDrag(null)
                              if (moved) {
                                const startSec = Math.round(lastStart * 10) / 10
                                void invoke('textLayers:update', {
                                  id: layer.id,
                                  patch: { startSec, endSec: startSec + dur }
                                })
                              } else {
                                setEditLayer({ id: layer.id, x: ev.clientX, y: ev.clientY - 8 })
                              }
                            }
                            window.addEventListener('pointermove', move)
                            window.addEventListener('pointerup', up)
                          }}
                        >
                          <Type className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{layer.content}</span>
                          <EdgeHandle
                            side="left"
                            title={t('timeline.layerStart')}
                            onPointerDown={beginLayerResize(layer, 'left')}
                          />
                          <EdgeHandle
                            side="right"
                            title={t('timeline.layerEnd')}
                            onPointerDown={beginLayerResize(layer, 'right')}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Audio tracks: speech lane (voice-over) above the music lane —
                    the same two lanes the MP4 render mixes. Blocks sit at their
                    ABSOLUTE lane start (shared audioLaneStarts); dragging a
                    block writes its explicit timeline offset. */}
                {(
                  [
                    {
                      laneClips: speechClips,
                      bottom: audioClips.length > 0 ? 38 : 0,
                      Icon: Mic,
                      activeClass: 'border-accent-soft/40 bg-accent-soft/15 text-accent-soft'
                    },
                    {
                      laneClips: audioClips,
                      bottom: 0,
                      Icon: Music,
                      activeClass:
                        'border-highlight-soft/40 bg-highlight-soft/15 text-highlight-soft'
                    }
                  ] as const
                ).map(({ laneClips, bottom, Icon, activeClass }, laneIdx) => {
                  if (laneClips.length === 0) return null
                  const laneStarts = audioLaneStarts(
                    laneClips.map((c) => ({
                      offsetSec:
                        audioDrag?.id === c.node.id
                          ? audioDrag.startSec
                          : clipTimelineOffset(c.node),
                      durationSeconds: displayDur(c)
                    }))
                  )
                  return (
                    <div key={laneIdx} className="absolute inset-x-0 h-8" style={{ bottom }}>
                      {laneClips.map((clip, i) => {
                        const start = laneStarts[i] ?? 0
                        const left =
                          displayTotal > 0 ? Math.min(100, (start / displayTotal) * 100) : 0
                        const width =
                          displayTotal > 0
                            ? Math.max(
                                1,
                                Math.min(100 - left, (displayDur(clip) / displayTotal) * 100)
                              )
                            : 0
                        return (
                          <div
                            key={clip.node.id}
                            className={`group absolute flex h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border px-2 text-[10px] ${
                              clip.url
                                ? activeClass
                                : 'border-neutral-800 bg-neutral-900/40 text-neutral-600'
                            }`}
                            style={{ left: `${left}%`, width: `${width}%`, cursor: 'grab' }}
                            onPointerDown={(e) => {
                              e.stopPropagation()
                              onFocusNode?.(clip.node.id)
                              const rect = trackRef.current?.getBoundingClientRect()
                              if (!rect || displayTotal <= 0) return
                              const originX = e.clientX
                              const origStart = start
                              let moved = false
                              let lastStart = origStart
                              const tol = snapTolerance(displayTotal, rect.width)
                              const move = (ev: PointerEvent) => {
                                const delta = ((ev.clientX - originX) / rect.width) * displayTotal
                                if (Math.abs(ev.clientX - originX) > 3) moved = true
                                lastStart = snapSpan(
                                  Math.max(0, origStart + delta),
                                  displayDur(clip),
                                  [...snapTargets, engine.globalTime],
                                  tol
                                )
                                setAudioDrag({ id: clip.node.id, startSec: lastStart })
                              }
                              const up = () => {
                                window.removeEventListener('pointermove', move)
                                window.removeEventListener('pointerup', up)
                                setAudioDrag(null)
                                if (moved) {
                                  void invoke('nodes:setTimelineOffset', {
                                    nodeId: clip.node.id,
                                    offsetSec: Math.round(lastStart * 10) / 10
                                  })
                                }
                              }
                              window.addEventListener('pointermove', move)
                              window.addEventListener('pointerup', up)
                            }}
                            onDoubleClick={(e) =>
                              setEditAudio({ nodeId: clip.node.id, x: e.clientX, y: e.clientY - 8 })
                            }
                            title={`${clip.node.label ?? getModel(clip.node.modelId)?.label ?? clip.node.key} — ${t('timeline.volumeHintOpen')}`}
                          >
                            {clip.url &&
                              (() => {
                                const raw = engine.rawDurationOf(clip)
                                const trim = segmentTrim(clip.segment, raw)
                                return (
                                  <Waveform
                                    url={clip.url}
                                    startFrac={raw > 0 ? trim.start / raw : 0}
                                    endFrac={raw > 0 ? (trim.end ?? raw) / raw : 1}
                                    className="pointer-events-none absolute inset-0 h-full w-full"
                                  />
                                )
                              })()}
                            <Icon className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">
                              {clip.node.label ??
                                getModel(clip.node.modelId)?.label ??
                                clip.node.key}
                            </span>
                            {clipVolume(clip.node) !== 1 && (
                              <span className="flex-shrink-0 rounded bg-black/30 px-1 opacity-80">
                                {Math.round(clipVolume(clip.node) * 100)}%
                              </span>
                            )}
                            <span className="ml-auto flex-shrink-0 opacity-70">
                              {fmt(displayDur(clip))}
                            </span>
                            {clip.url && (
                              <>
                                <EdgeHandle
                                  side="left"
                                  title={t('timeline.trimIn')}
                                  onPointerDown={beginClipResize(clip, 'left')}
                                />
                                <EdgeHandle
                                  side="right"
                                  title={t('timeline.trimOut')}
                                  onPointerDown={beginClipResize(clip, 'right')}
                                />
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}

                {/* Playhead */}
                {engine.total > 0 && (
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-highlight"
                    style={{ left: `${(engine.globalTime / engine.total) * 100}%` }}
                    data-timeline-playhead
                  >
                    <div className="absolute -top-0.5 -left-[5px] h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-highlight" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {editClip &&
        clips[editClip.idx] &&
        (() => {
          const clip = clips[editClip.idx]!
          return (
            <ClipSettingsPopover
              clip={clip}
              isLast={editClip.idx === clips.length - 1}
              anchor={editClip}
              splitAtMediaSec={splitPointOf(editClip.idx)}
              onClose={() => setEditClip(null)}
              onRemoveStill={
                clip.still && !clip.placeholder
                  ? () => {
                      setEditClip(null)
                      void invoke('nodes:setTimelineOrder', {
                        videoId,
                        nodeIds: clips
                          .filter((c) => c.node.id !== clip.node.id)
                          .map((c) => c.node.id)
                          .filter((id, j, arr) => arr.indexOf(id) === j)
                      })
                    }
                  : undefined
              }
            />
          )
        })()}
      {imagePicker && (
        <ImagePickerPopover
          candidates={imageCandidates}
          anchor={imagePicker}
          onPick={addImageToTimeline}
          onClose={() => setImagePicker(null)}
        />
      )}
      {editLayer &&
        (() => {
          const layer = textLayers.find((l) => l.id === editLayer.id)
          return layer ? (
            <LayerSettingsPopover
              layer={layer}
              anchor={editLayer}
              onClose={() => setEditLayer(null)}
            />
          ) : null
        })()}
      {editAudio &&
        (() => {
          const node = graph.nodes.find((n) => n.id === editAudio.nodeId)
          return node ? (
            <AudioSettingsPopover
              node={node}
              anchor={editAudio}
              onClose={() => setEditAudio(null)}
            />
          ) : null
        })()}
      {stickerPicker && (
        <ImagePickerPopover
          candidates={imageCandidates}
          anchor={stickerPicker}
          onPick={addSticker}
          onClose={() => setStickerPicker(null)}
        />
      )}
      {editSticker &&
        (() => {
          const layer = imageLayers.find((l) => l.id === editSticker.id)
          return layer ? (
            <StickerSettingsPopover
              layer={layer}
              anchor={editSticker}
              onClose={() => setEditSticker(null)}
            />
          ) : null
        })()}
      {notePopover && (
        <FeedbackNotePopover
          videoId={videoId}
          note={notePopover}
          onClose={() => setNotePopover(null)}
        />
      )}
    </div>
  )
}

/**
 * Quick feedback note (§6.13) on the frame under the playhead: the timecode
 * and the node identity were frozen when the popover opened — the user only
 * types the comment. Lands in the feedback bucket (FeedbackPanel + the MCP
 * feedback tools).
 */
function FeedbackNotePopover({
  videoId,
  note,
  onClose
}: {
  videoId: string
  note: {
    x: number
    y: number
    timecodeSec: number
    nodeId: string | null
    nodeLabel: string | null
  }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [comment, setComment] = useState('')

  const save = (): void => {
    const trimmed = comment.trim()
    if (!trimmed) return
    void invoke('feedback:create', {
      videoId,
      comment: trimmed,
      timecodeSec: note.timecodeSec,
      ...(note.nodeId ? { nodeId: note.nodeId } : {}),
      ...(note.nodeLabel ? { nodeLabel: note.nodeLabel } : {})
    })
    onClose()
  }

  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(note.x, 288), top: note.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <MessageSquarePlus className="h-3 w-3 text-accent" /> {t('timeline.addNoteTitle')}
        <span className="ml-auto font-mono font-normal text-neutral-400">
          {formatTimecode(note.timecodeSec)}
          {note.nodeLabel ? ` · ${note.nodeLabel}` : ''}
        </span>
      </div>
      <textarea
        autoFocus
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') onClose()
        }}
        placeholder={t('timeline.notePlaceholder')}
        rows={2}
        className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-neutral-500">{t('timeline.noteHint')}</span>
        <button
          onClick={save}
          disabled={!comment.trim()}
          className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          {t('timeline.noteSave')}
        </button>
      </div>
    </div>
  )
}

/**
 * Clamp a centred popover's `left` so the island stays fully on screen: the
 * anchors are clip centres, so on the timeline's last clips half the popover
 * would overflow the window edge. Works on centres because every popover
 * carries `-translate-x-1/2`.
 */
function popoverLeft(anchorX: number, widthPx: number): number {
  const half = widthPx / 2 + 8
  return Math.min(Math.max(anchorX, half), Math.max(half, window.innerWidth - half))
}

/**
 * Inspector for one sticker: timing, size (as % of the output width) and
 * deletion. Position is set by dragging the sticker ON THE PLAYER (x/y are
 * normalized centers — the preview is the render).
 */
function StickerSettingsPopover({
  layer,
  anchor,
  onClose
}: {
  layer: ImageLayer
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [start, setStart] = useState(String(layer.startSec))
  const [end, setEnd] = useState(String(layer.endSec))
  const [width, setWidth] = useState(Math.round(layer.widthPct))

  const apply = () => {
    const num = (raw: string, fallback: number) => {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? n : fallback
    }
    void invoke('imageLayers:update', {
      id: layer.id,
      patch: {
        startSec: Math.max(0, num(start, layer.startSec)),
        endSec: num(end, layer.endSec),
        widthPct: Math.min(100, Math.max(1, width))
      }
    }).then(onClose)
  }

  const field =
    'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-64 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 256), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <StickerIcon className="h-3 w-3 text-accent" /> {t('timeline.sticker')}
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerStart')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerEnd')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.stickerSize', { pct: width })}
          <input
            type="range"
            min={5}
            max={100}
            step={1}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => {
            void invoke('imageLayers:delete', { id: layer.id }).then(onClose)
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
          title={t('timeline.stickerDelete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={apply}
          className="ml-auto rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
        >
          {t('timeline.apply')}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.stickerDragHint')}</p>
    </div>
  )
}

/**
 * Volume inspector for one audio track (music/speech lane block, double-click).
 * The gain applies to the preview player (capped at 100% — an HTMLMediaElement
 * cannot amplify) and to the MP4 render's per-track `volume=` filter.
 */
function AudioSettingsPopover({
  node,
  anchor,
  onClose
}: {
  node: GraphNode
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [volume, setVolume] = useState(Math.round(clipVolume(node) * 100))

  const commit = (pct: number) => {
    void invoke('nodes:setVolume', {
      nodeId: node.id,
      volume: pct === 100 ? null : Math.min(2, Math.max(0, pct / 100))
    })
  }

  return (
    <div
      ref={ref}
      className="island fixed z-50 w-60 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 240), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Volume2 className="h-3 w-3 text-accent" /> {t('timeline.volume')}
        <span className="ml-auto font-mono text-neutral-400">{volume}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        onPointerUp={() => commit(volume)}
        onKeyUp={() => commit(volume)}
        className="w-full"
      />
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.volumeHint')}</p>
    </div>
  )
}

/** CSS transform that puts a layer's ANCHOR point on its (x, y) position. */
function anchorTransform(anchor: number): string {
  const col = (anchor - 1) % 3
  const tx = col === 0 ? '0%' : col === 1 ? '-50%' : '-100%'
  const ty = anchor >= 7 ? '0%' : anchor >= 4 ? '-50%' : '-100%'
  return `translate(${tx}, ${ty})`
}

/** ASS numpad alignment laid out as the 3×3 position grid the picker shows. */
const ALIGN_GRID = [
  [7, 8, 9],
  [4, 5, 6],
  [1, 2, 3]
] as const

/** Flexbox placement of the player's overlay preview for an ASS alignment. */
export function overlayPlacement(align: number): {
  alignItems: 'flex-start' | 'center' | 'flex-end'
  justifyContent: 'flex-start' | 'center' | 'flex-end'
  textAlign: 'left' | 'center' | 'right'
} {
  const col = ((align - 1) % 3) as 0 | 1 | 2
  const row = align >= 7 ? 'flex-start' : align >= 4 ? 'center' : 'flex-end'
  const x = (['flex-start', 'center', 'flex-end'] as const)[col]
  return {
    alignItems: row,
    justifyContent: x,
    textAlign: (['left', 'center', 'right'] as const)[col]
  }
}

/**
 * The clip inspector, anchored above the scissors button (fixed positioning —
 * the timeline island clips its own overflow). Trim and the text layer are
 * applied together on Apply; the transition choice and its length write
 * immediately (discrete choices). Everything is a journaled graph edit — ⌘Z
 * undoes any of it.
 */
function ClipSettingsPopover({
  clip,
  isLast,
  anchor,
  splitAtMediaSec,
  onClose,
  onRemoveStill
}: {
  clip: EngineClip
  isLast: boolean
  anchor: { x: number; y: number }
  /** Razor point under the playhead (media seconds), null = playhead outside. */
  splitAtMediaSec: number | null
  onClose: () => void
  /** Set on still slots only: removes the image from the timeline (not the graph). */
  onRemoveStill?: () => void
}) {
  const node = clip.node
  const segment = clip.segment
  const segmentCount = clipSegments(node).length
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [inPoint, setInPoint] = useState(
    segment.trimStartSec != null ? String(segment.trimStartSec) : ''
  )
  const [outPoint, setOutPoint] = useState(
    segment.trimEndSec != null ? String(segment.trimEndSec) : ''
  )
  const [ovText, setOvText] = useState(node.overlay?.text ?? '')
  const [ovAlign, setOvAlign] = useState(node.overlay?.align ?? 2)
  const [ovSize, setOvSize] = useState<'sm' | 'md' | 'lg'>(node.overlay?.size ?? 'md')
  const [transDur, setTransDur] = useState(String(segmentTransitionSeconds(segment)))

  const transition = segmentTransitionAfter(segment)

  const apply = () => {
    const parse = (raw: string): number | null => {
      const n = Number(raw.replace(',', '.'))
      return raw.trim() !== '' && Number.isFinite(n) ? n : null
    }
    const text = ovText.trim()
    void Promise.all([
      invoke('nodes:setTrim', {
        nodeId: node.id,
        trimStartSec: parse(inPoint),
        trimEndSec: parse(outPoint),
        segmentIndex: clip.segmentIndex
      }),
      invoke('nodes:setOverlay', {
        nodeId: node.id,
        overlay: text ? { text, align: ovAlign, size: ovSize } : null
      })
    ]).then(onClose)
  }

  const changeTransition = (id: string | null, durRaw: string) => {
    const dur = Number(durRaw.replace(',', '.'))
    void invoke('nodes:setTransition', {
      nodeId: node.id,
      transition: id,
      durationSec: id && Number.isFinite(dur) ? Math.min(2, Math.max(0.1, dur)) : null,
      segmentIndex: clip.segmentIndex
    })
  }

  const field =
    'w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 288), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Scissors className="h-3 w-3 text-accent" /> {t('timeline.clipSettings')}
        {onRemoveStill && (
          <button
            onClick={onRemoveStill}
            className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
            title={t('timeline.removeFromTimeline')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Trim */}
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.trimIn')}
          <input
            className={field}
            inputMode="decimal"
            placeholder="0"
            value={inPoint}
            onChange={(e) => setInPoint(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.trimOut')}
          <input
            className={field}
            inputMode="decimal"
            placeholder="—"
            value={outPoint}
            onChange={(e) => setOutPoint(e.target.value)}
          />
        </label>
      </div>

      {/* Razor (§6.12e): split at the playhead; a split part can be removed. */}
      {!isStillClip(node) && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-neutral-800 pt-2">
          <button
            disabled={splitAtMediaSec === null}
            onClick={() => {
              if (splitAtMediaSec === null) return
              void invoke('nodes:splitClip', {
                nodeId: node.id,
                atMediaSec: splitAtMediaSec
              }).then(onClose)
            }}
            className="flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            title={t('timeline.splitHint')}
          >
            <Scissors className="h-3 w-3" /> {t('timeline.split')}
          </button>
          {segmentCount > 1 && (
            <button
              onClick={() =>
                void invoke('nodes:removeSegment', {
                  nodeId: node.id,
                  segmentIndex: clip.segmentIndex
                }).then(onClose)
              }
              className="rounded-md bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 hover:text-danger"
            >
              {t('timeline.removeSegment')}
            </button>
          )}
          {segmentCount > 1 && (
            <span className="ml-auto text-neutral-500">
              {t('timeline.segmentBadge', { n: clip.segmentIndex + 1, count: segmentCount })}
            </span>
          )}
        </div>
      )}

      {/* Speed & look (video clips) / Ken Burns motion (stills) — discrete
          choices, written immediately like the transition. */}
      <div className="mt-2.5 flex items-end gap-2 border-t border-neutral-800 pt-2">
        {!isStillClip(node) && (
          <label className="flex flex-col gap-0.5 text-neutral-400">
            {t('timeline.speed')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={String(clipSpeed(node))}
              onChange={(e) => {
                const v = Number(e.target.value)
                void invoke('nodes:setSpeed', { nodeId: node.id, speed: v === 1 ? null : v })
              }}
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => (
                <option key={v} value={String(v)}>
                  ×{v}
                </option>
              ))}
            </select>
          </label>
        )}
        {isStillClip(node) && (
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
            {t('timeline.motion')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={stillMotionOf(node) ?? ''}
              onChange={(e) =>
                void invoke('nodes:setStillMotion', {
                  nodeId: node.id,
                  motion: e.target.value || null
                })
              }
            >
              <option value="">{t('timeline.motionNone')}</option>
              {STILL_MOTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`timeline.motions.${id}` as never)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.look')}
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
            value={clipLook(node) ?? ''}
            onChange={(e) =>
              void invoke('nodes:setLook', { nodeId: node.id, look: e.target.value || null })
            }
          >
            <option value="">{t('timeline.lookNone')}</option>
            {CLIP_LOOK_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`timeline.looks.${id}` as never)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Transition into the next clip */}
      {!isLast && (
        <div className="mt-2.5 flex items-end gap-2 border-t border-neutral-800 pt-2">
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
            {t('timeline.transition')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={transition ?? ''}
              onChange={(e) => changeTransition(e.target.value || null, transDur)}
            >
              <option value="">{t('timeline.transitionNone')}</option>
              {CLIP_TRANSITION_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`timeline.transitions.${id}` as never)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-neutral-400">
            {t('timeline.transitionDuration')}
            <input
              className={field}
              inputMode="decimal"
              disabled={transition === null}
              value={transDur}
              onChange={(e) => setTransDur(e.target.value)}
              onBlur={() => transition && changeTransition(transition, transDur)}
            />
          </label>
        </div>
      )}

      {/* Text layer */}
      <div className="mt-2.5 border-t border-neutral-800 pt-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.overlayText')}
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
            placeholder={t('timeline.overlayPlaceholder')}
            maxLength={200}
            value={ovText}
            onChange={(e) => setOvText(e.target.value)}
          />
        </label>
        <div className="mt-1.5 flex items-center gap-2.5">
          <div
            className="grid grid-cols-3 gap-0.5"
            role="group"
            aria-label={t('timeline.overlayPosition')}
          >
            {ALIGN_GRID.flat().map((a) => (
              <button
                key={a}
                onClick={() => setOvAlign(a)}
                title={t('timeline.overlayPosition')}
                className={`h-4 w-5 rounded-sm border ${
                  ovAlign === a
                    ? 'border-accent bg-accent/40'
                    : 'border-neutral-700 bg-neutral-900 hover:border-neutral-500'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label={t('timeline.overlaySize')}>
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setOvSize(s)}
                className={`rounded px-1.5 py-0.5 uppercase ${
                  ovSize === s
                    ? 'bg-accent font-semibold text-neutral-900'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={apply}
            className="ml-auto rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
          >
            {t('timeline.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Font suggestions for the layer inspector (free text — any system font works). */
const FONT_SUGGESTIONS = [
  'Arial',
  'Helvetica Neue',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Menlo',
  'Futura',
  'Impact',
  'Trebuchet MS',
  'Verdana'
]

/**
 * Typography inspector for one text layer. Position is set by dragging the
 * text ON THE PLAYER (x/y are normalized, the preview is the render); this
 * popover owns everything else: content, timing, font, size, weight, colour.
 */
function LayerSettingsPopover({
  layer,
  anchor,
  onClose
}: {
  layer: TextLayer
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [content, setContent] = useState(layer.content)
  const [start, setStart] = useState(String(layer.startSec))
  const [end, setEnd] = useState(String(layer.endSec))
  const [font, setFont] = useState(layer.fontFamily ?? '')
  const [size, setSize] = useState(String(layer.sizePct))
  const [bold, setBold] = useState(layer.bold)
  const [italic, setItalic] = useState(layer.italic)
  const [color, setColor] = useState(layer.colorHex)
  const [animation, setAnimation] = useState(layer.animation ?? '')

  const apply = () => {
    const num = (raw: string, fallback: number) => {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? n : fallback
    }
    void invoke('textLayers:update', {
      id: layer.id,
      patch: {
        content: content.trim() || layer.content,
        startSec: Math.max(0, num(start, layer.startSec)),
        endSec: num(end, layer.endSec),
        fontFamily: font.trim() === '' ? null : font.trim(),
        sizePct: Math.min(30, Math.max(1, num(size, layer.sizePct))),
        bold,
        italic,
        colorHex: color,
        animation: animation === '' ? null : animation
      }
    }).then(onClose)
  }

  const field =
    'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 288), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Type className="h-3 w-3 text-accent" /> {t('timeline.layerSettings')}
      </div>
      <input
        className={`${field} w-full`}
        value={content}
        maxLength={500}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="mt-1.5 flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerStart')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerEnd')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerFont')}
          <input
            className={`${field} w-full`}
            list="timeline-layer-fonts"
            placeholder="Arial"
            value={font}
            onChange={(e) => setFont(e.target.value)}
          />
          <datalist id="timeline-layer-fonts">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerAnimation')}
          <select
            className={`${field} w-full`}
            value={animation}
            onChange={(e) => setAnimation(e.target.value)}
          >
            <option value="">{t('timeline.layerAnimationNone')}</option>
            {TEXT_ANIMATION_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`timeline.layerAnimations.${id}` as never)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerSize')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <div className="flex gap-1">
          <button
            onClick={() => setBold((b) => !b)}
            className={`rounded px-2 py-1 font-bold ${
              bold ? 'bg-accent text-neutral-900' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            B
          </button>
          <button
            onClick={() => setItalic((i) => !i)}
            className={`rounded px-2 py-1 italic ${
              italic ? 'bg-accent text-neutral-900' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            I
          </button>
        </div>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerColor')}
          <input
            type="color"
            className="h-6 w-9 cursor-pointer rounded border border-neutral-700 bg-neutral-900"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <button
          onClick={() => {
            void invoke('textLayers:delete', { id: layer.id }).then(onClose)
          }}
          className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
          title={t('timeline.layerDelete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={apply}
          className="rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
        >
          {t('timeline.apply')}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.layerDragHint')}</p>
    </div>
  )
}

/**
 * The add-image picker: every image of the graph not already on the timeline
 * (image-model nodes with a successful output, image assets). Picking one
 * appends it as a STILL slot — 5 s by default, resizable by its edge grips.
 */
function ImagePickerPopover({
  candidates,
  anchor,
  onPick,
  onClose
}: {
  candidates: Array<{ node: GraphNode; url: string }>
  anchor: { x: number; y: number }
  onPick: (nodeId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-64 -translate-x-1/2 -translate-y-full px-2 py-2 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 256), top: anchor.y }}
    >
      <div className="mb-1.5 flex items-center gap-1.5 px-1 font-semibold text-neutral-200">
        <ImagePlus className="h-3 w-3 text-accent" /> {t('timeline.addImage')}
      </div>
      {candidates.length === 0 ? (
        <p className="px-1 pb-1 text-neutral-500">{t('timeline.addImageEmpty')}</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {candidates.map(({ node, url }) => (
            <button
              key={node.id}
              onClick={() => onPick(node.id)}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-800"
            >
              <img
                src={url}
                alt=""
                className="h-8 w-12 flex-shrink-0 rounded border border-neutral-800 object-cover"
              />
              <span className="truncate text-neutral-200">
                {node.label ?? getModel(node.modelId)?.label ?? node.key}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Sensible ruler tick spacing: ~8 ticks over the whole edit. */
function rulerTicks(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => total / s <= 8) ?? 600
  const ticks: number[] = []
  for (let t = 0; t < total; t += step) ticks.push(t)
  return ticks
}
