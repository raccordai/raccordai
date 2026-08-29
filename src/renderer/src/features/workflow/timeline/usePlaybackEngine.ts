import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  audioLaneStarts,
  clipSpeed,
  clipTimelineOffset,
  clipVolume,
  segmentTransitionAfter,
  segmentTransitionSeconds,
  segmentTrim
} from '@shared/timeline'
import { nextShuttleRate } from '../../../lib/shuttle'
import type { EngineClip } from './types'

/**
 * Timeline playback engine — continuous NLE-style playback.
 *
 * Two stacked <video> elements: the active one plays the current clip; the
 * standby one preloads the next clip's media, and becomes active the instant
 * the current clip ends — gapless playback across the whole edit. A global
 * time ruler maps every clip onto one scrubbable playhead.
 */
export function usePlaybackEngine(
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
