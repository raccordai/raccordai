import {
  AlertCircle,
  Music,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Film,
  Loader2,
  Pause,
  Play
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import { useTimelineFallbackImages, useVideoGenerations } from './data'
import type { WorkflowGraph } from './workflowContext'
import { bestGeneration, clipDuration, collectTimelineClips } from '@shared/timeline'
import { useResizableHeight } from './timelineHooks'
import { formatSeconds } from '../../lib/formatSeconds'
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
  url: string | null
  /** Declared duration (params), replaced by real media duration once probed. */
  declared: number
}

const DEFAULT_CLIP_SECONDS = 5

// ── Playback engine ───────────────────────────────────────────────────────────

function usePlaybackEngine(clips: EngineClip[], audioClips: EngineClip[]) {
  const videoARef = useRef<HTMLVideoElement | null>(null)
  const videoBRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const [activeIdx, setActiveIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [globalTime, setGlobalTime] = useState(0)
  /** Real media durations, keyed by node id (probed from metadata). */
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({})

  const durationOf = useCallback(
    (clip: EngineClip) => mediaDurations[clip.node.id] ?? clip.declared,
    [mediaDurations]
  )

  const starts = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const clip of clips) {
      out.push(acc)
      acc += durationOf(clip)
    }
    return out
  }, [clips, durationOf])

  const total = useMemo(
    () => clips.reduce((acc, clip) => acc + durationOf(clip), 0),
    [clips, durationOf]
  )

  // Audio lane: independent sequential layout, slaved to the global clock.
  const audioStarts = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const clip of audioClips) {
      out.push(acc)
      acc += durationOf(clip)
    }
    return out
  }, [audioClips, durationOf])

  const lastAudioSeekRef = useRef(0)
  const syncAudio = useCallback(
    (t: number, shouldPlay: boolean) => {
      const audio = audioRef.current
      if (!audio || audioClips.length === 0) return
      let idx = -1
      for (let i = 0; i < audioClips.length; i++) {
        const start = audioStarts[i] ?? 0
        if (t >= start && t < start + durationOf(audioClips[i] as EngineClip)) {
          idx = i
          break
        }
      }
      const clip = idx >= 0 ? audioClips[idx] : undefined
      if (!clip?.url) {
        if (!audio.paused) audio.pause()
        return
      }
      const offset = t - (audioStarts[idx] ?? 0)
      if (!audio.src.endsWith(clip.url)) {
        audio.src = clip.url
        audio.currentTime = offset
      } else {
        // Drift correction is rate-limited: currentTime assignments are async
        // and each one aborts a pending play() — correcting every frame keeps
        // the element paused forever (and non-seekable streams never converge).
        const now = performance.now()
        if (
          !audio.seeking &&
          Math.abs(audio.currentTime - offset) > 0.5 &&
          now - lastAudioSeekRef.current > 600
        ) {
          lastAudioSeekRef.current = now
          audio.currentTime = offset
        }
      }
      if (shouldPlay && audio.paused) void audio.play().catch(() => undefined)
      if (!shouldPlay && !audio.paused) audio.pause()
    },
    [audioClips, audioStarts, durationOf]
  )

  // Keep the audio lane glued to the playhead in every state.
  useEffect(() => {
    syncAudio(globalTime, playing)
  }, [globalTime, playing, syncAudio])

  // Probe real durations (declared params often differ from delivered media).
  useEffect(() => {
    const probes: HTMLVideoElement[] = []
    for (const clip of [...clips, ...audioClips]) {
      if (!clip.url || mediaDurations[clip.node.id] !== undefined) continue
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
  }, [[...clips, ...audioClips].map((c) => `${c.node.id}:${c.url}`).join('|')])

  const activeVideo = () => (activeSlot === 'A' ? videoARef.current : videoBRef.current)
  const standbyVideo = () => (activeSlot === 'A' ? videoBRef.current : videoARef.current)

  const nextPlayableFrom = useCallback(
    (from: number) => {
      for (let i = from; i < clips.length; i++) if (clips[i]?.url) return i
      return -1
    },
    [clips]
  )

  // Keep the active video on the current clip, and the standby preloading the next.
  useEffect(() => {
    const clip = clips[activeIdx]
    const active = activeVideo()
    if (active && clip?.url && !active.src.endsWith(clip.url)) {
      active.src = clip.url
      active.load()
    }
    const nextIdx = nextPlayableFrom(activeIdx + 1)
    const standby = standbyVideo()
    const nextUrl = nextIdx >= 0 ? clips[nextIdx]?.url : null
    if (standby && nextUrl && !standby.src.endsWith(nextUrl)) {
      standby.src = nextUrl
      standby.preload = 'auto'
      standby.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, activeSlot, clips, nextPlayableFrom])

  // Global clock while playing.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const video = activeVideo()
      const base = starts[activeIdx] ?? 0
      if (video) setGlobalTime(base + video.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeIdx, activeSlot, starts])

  /** Gapless hop to the next playable clip; stops at the end of the edit. */
  const advance = useCallback(() => {
    const nextIdx = nextPlayableFrom(activeIdx + 1)
    if (nextIdx === -1) {
      setPlaying(false)
      setGlobalTime(total)
      return
    }
    const standby = standbyVideo()
    const expected = clips[nextIdx]?.url
    if (standby && expected && standby.src.endsWith(expected)) {
      // The standby already holds the next clip: swap slots and play instantly.
      standby.currentTime = 0
      setActiveSlot((s) => (s === 'A' ? 'B' : 'A'))
      setActiveIdx(nextIdx)
      void standby.play()
    } else {
      // Fallback (e.g. skipped over an ungenerated clip): load in place.
      setActiveIdx(nextIdx)
      const active = activeVideo()
      if (active && expected) {
        active.src = expected
        void active.play()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, clips, nextPlayableFrom, total])

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
    // Give the effect a beat to (re)load the right src before playing.
    const resumeAt = starts[idx] ?? 0
    requestAnimationFrame(() => {
      const video = activeVideo()
      if (video) void video.play().catch(() => setPlaying(false))
      syncAudio(Math.max(resumeAt, globalTime), true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, clips, globalTime, nextPlayableFrom, starts, total])

  const pause = useCallback(() => {
    activeVideo()?.pause()
    audioRef.current?.pause()
    setPlaying(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, Math.max(total - 0.01, 0)))
      let idx = clips.length - 1
      for (let i = 0; i < clips.length; i++) {
        const start = starts[i] ?? 0
        if (clamped >= start && clamped < start + durationOf(clips[i] as EngineClip)) {
          idx = i
          break
        }
      }
      const offset = clamped - (starts[idx] ?? 0)
      setGlobalTime(clamped)
      const clip = clips[idx]
      if (!clip) return
      if (idx !== activeIdx) setActiveIdx(idx)
      requestAnimationFrame(() => {
        const video = activeVideo()
        if (video && clip.url) {
          if (!video.src.endsWith(clip.url)) {
            video.src = clip.url
            video.load()
          }
          video.currentTime = offset
          if (playing) void video.play().catch(() => setPlaying(false))
        }
        syncAudio(clamped, playing)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeVideo/syncAudio are deliberately unstable helpers read at call time
    [activeIdx, activeSlot, clips, durationOf, playing, starts, total]
  )

  return {
    videoARef,
    videoBRef,
    audioRef,
    audioStarts,
    activeSlot,
    activeIdx,
    setActiveIdx,
    playing,
    play,
    pause,
    seek,
    advance,
    globalTime,
    starts,
    total,
    durationOf
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TimelineV2({
  graph,
  videoId,
  onFocusNode,
  collapsed,
  setCollapsed
}: {
  graph: WorkflowGraph
  videoId: string
  onFocusNode?: (nodeId: string) => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const clipNodes = useMemo(() => collectTimelineClips(graph.nodes), [graph.nodes])
  const audioNodes = useMemo(
    () => graph.nodes.filter((n) => getModel(n.modelId)?.kind === 'audio'),
    [graph.nodes]
  )
  const generations = useVideoGenerations(videoId).data
  const fallbackImages = useTimelineFallbackImages(videoId).data

  const clips: EngineClip[] = useMemo(() => {
    return clipNodes.map((node) => {
      const gens = (generations ?? []).filter((g) => g.nodeId === node.id)
      const best = bestGeneration(node, gens)
      return {
        node,
        url: best?.status === 'success' ? (best.url ?? null) : null,
        declared: clipDuration(node) ?? DEFAULT_CLIP_SECONDS
      }
    })
  }, [clipNodes, generations])

  const audioClips: EngineClip[] = useMemo(() => {
    return audioNodes.map((node) => {
      const gens = (generations ?? []).filter((g) => g.nodeId === node.id)
      const best = bestGeneration(node, gens)
      return {
        node,
        url: best?.status === 'success' ? (best.url ?? null) : null,
        declared: clipDuration(node) ?? DEFAULT_CLIP_SECONDS
      }
    })
  }, [audioNodes, generations])

  const engine = usePlaybackEngine(clips, audioClips)
  const anyRunning = (generations ?? []).some((g) => g.status === 'running')
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
      <div className="island relative flex h-32 items-center justify-center overflow-hidden text-xs text-neutral-600">
        <Film className="mr-2 h-4 w-4" /> {t('timeline.empty')}
        <button
          onClick={() => setCollapsed(true)}
          className="absolute top-2 right-2 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={t('timeline.hide')}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const activeClip = clips[engine.activeIdx]

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
          {anyRunning && (
            <span className="flex items-center gap-1 text-warning">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('timeline.generating')}
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
          </div>

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
            className="video-stack relative aspect-video flex-shrink-0 cursor-pointer border-r border-neutral-800 bg-black"
            onClick={() => (engine.playing ? engine.pause() : engine.play())}
            title={t('timeline.playPause')}
          >
            <video
              ref={engine.videoARef}
              onEnded={engine.advance}
              playsInline
              className={`absolute inset-0 h-full w-full ${engine.activeSlot === 'A' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            />
            <video
              ref={engine.videoBRef}
              onEnded={engine.advance}
              playsInline
              muted={engine.activeSlot === 'A'}
              className={`absolute inset-0 h-full w-full ${engine.activeSlot === 'B' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            />
            <audio ref={engine.audioRef} className="hidden" />
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
            {!engine.playing && activeClip?.url && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60">
                  <Play className="h-4 w-4 pl-0.5 text-white" />
                </span>
              </div>
            )}
          </div>

          {/* Track: ruler + proportional clip blocks + playhead. */}
          <div className="flex min-w-0 flex-1 flex-col px-3 py-2">
            <div
              ref={trackRef}
              className="relative min-h-0 flex-1 cursor-crosshair select-none"
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
                style={{ bottom: audioClips.length > 0 ? 38 : 0 }}
              >
                {clips.map((clip, i) => {
                  const width =
                    engine.total > 0 ? (engine.durationOf(clip) / engine.total) * 100 : 0
                  const isActive = i === engine.activeIdx
                  const still = fallbackImages?.[clip.node.id]
                  return (
                    <div
                      key={clip.node.id}
                      className={`group relative mr-px min-w-0 overflow-hidden rounded-md border ${
                        isActive ? 'border-accent' : 'border-neutral-800'
                      } ${clip.url ? 'bg-neutral-900' : 'bg-neutral-900/40'}`}
                      style={{ width: `${width}%` }}
                      data-timeline-clip={i}
                      onPointerDown={(e) => {
                        // Let the track scrub handler run too, but focus/select this node.
                        e.stopPropagation()
                        scrubbing.current = true
                        document.body.style.userSelect = 'none'
                        engine.seek(timeAtPointer(e.clientX))
                        onFocusNode?.(clip.node.id)
                      }}
                    >
                      {clip.url ? (
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
                        {clip.node.label ?? getModel(clip.node.modelId)?.label ?? clip.node.key}
                        <span className="ml-1 text-neutral-400">
                          {fmt(engine.durationOf(clip))}
                        </span>
                      </div>
                      {!clip.url && (
                        <div className="absolute inset-0 flex items-center justify-center text-[9px] text-neutral-600">
                          {anyRunning ? t('timeline.clipGenerating') : t('timeline.clipEmpty')}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Audio track */}
              {audioClips.length > 0 && (
                <div className="absolute inset-x-0 bottom-0 flex h-8">
                  {audioClips.map((clip, i) => {
                    const width =
                      engine.total > 0
                        ? Math.min(
                            (engine.durationOf(clip) / engine.total) * 100,
                            100 - ((engine.audioStarts[i] ?? 0) / engine.total) * 100
                          )
                        : 0
                    return (
                      <div
                        key={clip.node.id}
                        className={`relative mr-px flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md border px-2 text-[10px] ${
                          clip.url
                            ? 'border-highlight-soft/40 bg-highlight-soft/15 text-highlight-soft'
                            : 'border-neutral-800 bg-neutral-900/40 text-neutral-600'
                        }`}
                        style={{ width: `${Math.max(width, 0)}%` }}
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onFocusNode?.(clip.node.id)
                        }}
                        title={clip.node.label ?? getModel(clip.node.modelId)?.label}
                      >
                        <Music className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">
                          {clip.node.label ?? getModel(clip.node.modelId)?.label ?? clip.node.key}
                        </span>
                        <span className="ml-auto flex-shrink-0 opacity-70">
                          {fmt(engine.durationOf(clip))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

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
