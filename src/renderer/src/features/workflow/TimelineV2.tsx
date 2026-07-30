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
  Play,
  Scissors,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode, TextLayer } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import { useTextLayers, useTimelineFallbackImages, useVideoGenerations } from './data'
import type { WorkflowGraph } from './workflowContext'
import {
  bestGeneration,
  clipDuration,
  clipTransitionAfter,
  clipTransitionSeconds,
  clipTrim,
  collectTimelineClips
} from '@shared/timeline'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import { useResizableHeight } from './timelineHooks'
import { formatSeconds } from '../../lib/formatSeconds'
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

  /** The clip's trim window against its real (probed) or declared duration. */
  const trimOf = useCallback(
    (clip: EngineClip) => clipTrim(clip.node, mediaDurations[clip.node.id] ?? clip.declared),
    [mediaDurations]
  )

  const durationOf = useCallback(
    (clip: EngineClip) => {
      const raw = mediaDurations[clip.node.id] ?? clip.declared
      const { start, end } = clipTrim(clip.node, raw)
      return Math.max(0, (end ?? raw) - start)
    },
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
      const offset = t - (audioStarts[idx] ?? 0) + trimOf(clip).start
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
    [audioClips, audioStarts, durationOf, trimOf]
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
    const standby = standbyVideo()
    const next = clips[nextIdx]
    const expected = next?.url
    const nextStart = next ? trimOf(next).start : 0
    if (standby && expected && standby.src.endsWith(expected)) {
      // The standby already holds the next clip: swap slots and play instantly.
      standby.currentTime = nextStart
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
        void active.play()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, clips, nextPlayableFrom, total])

  // Global clock while playing. Also the trim out-point enforcement: `ended`
  // only fires at the MEDIA's end, so a trimmed clip must advance itself.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const video = activeVideo()
      const base = starts[activeIdx] ?? 0
      const clip = clips[activeIdx]
      if (video && clip) {
        const trim = trimOf(clip)
        setGlobalTime(base + Math.max(0, video.currentTime - trim.start))
        if (trim.end !== undefined && video.currentTime >= trim.end - 0.03) {
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
    // Give the effect a beat to (re)load the right src before playing.
    const resumeAt = starts[idx] ?? 0
    requestAnimationFrame(() => {
      const video = activeVideo()
      if (video) {
        // A fresh load sits at 0 — snap into the clip's trim window.
        const clip = clips[idx]
        if (clip) {
          const trim = trimOf(clip)
          if (
            video.currentTime < trim.start - 0.01 ||
            (trim.end !== undefined && video.currentTime >= trim.end - 0.01)
          ) {
            video.currentTime = trim.start
          }
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
          // The timeline offset is inside the TRIMMED clip — shift into media time.
          video.currentTime = offset + trimOf(clip).start
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
  // Clip inspector popover: anchored to the scissors button that opened it.
  const [editClip, setEditClip] = useState<{ idx: number; x: number; y: number } | null>(null)
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
  const audioNodes = useMemo(
    () => graph.nodes.filter((n) => getModel(n.modelId)?.kind === 'audio'),
    [graph.nodes]
  )
  const generations = useVideoGenerations(videoId).data
  const fallbackImages = useTimelineFallbackImages(videoId).data
  const textLayers = useTextLayers(videoId).data ?? []

  // The player's pixel height sizes the layer previews (sizePct = % of height).
  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    const update = () => setPlayerHeight(el.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsed, clipNodes.length])

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
                    bottom: (audioClips.length > 0 ? 38 : 0) + (textLayers.length > 0 ? 26 : 0)
                  }}
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
                        draggable
                        onDragStart={(e) => {
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
                          const ids = clips.map((c) => c.node.id)
                          const [moved] = ids.splice(from, 1)
                          ids.splice(i, 0, moved!)
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
                        {clipTransitionAfter(clip.node) !== null && i < clips.length - 1 && (
                          <div
                            className="absolute top-6 right-0 bottom-0 w-1 bg-highlight-soft/60"
                            title={t(
                              `timeline.transitions.${clipTransitionAfter(clip.node)}` as never
                            )}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Title track: one block per text layer, drag to move in time,
                    click to open its inspector. */}
                {textLayers.length > 0 && engine.total > 0 && (
                  <div
                    className="absolute inset-x-0 h-6"
                    style={{ bottom: audioClips.length > 0 ? 38 : 0 }}
                  >
                    {textLayers.map((layer) => {
                      const start = laneDrag?.id === layer.id ? laneDrag.startSec : layer.startSec
                      const dur = layer.endSec - layer.startSec
                      const left = Math.min(100, (start / engine.total) * 100)
                      const width = Math.max(1.5, Math.min(100 - left, (dur / engine.total) * 100))
                      return (
                        <div
                          key={layer.id}
                          className="absolute flex h-full items-center gap-1 overflow-hidden rounded-md border border-accent/50 bg-accent/15 px-1.5 text-[10px] text-accent-soft"
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
                            const move = (ev: PointerEvent) => {
                              const delta = ((ev.clientX - originX) / rect.width) * engine.total
                              if (Math.abs(ev.clientX - originX) > 3) moved = true
                              lastStart = Math.max(0, origStart + delta)
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
                        </div>
                      )
                    })}
                  </div>
                )}

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
      {editClip && clips[editClip.idx] && (
        <ClipSettingsPopover
          node={clips[editClip.idx]!.node}
          isLast={editClip.idx === clips.length - 1}
          anchor={editClip}
          onClose={() => setEditClip(null)}
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
  node,
  isLast,
  anchor,
  onClose
}: {
  node: GraphNode
  isLast: boolean
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [inPoint, setInPoint] = useState(node.trimStartSec != null ? String(node.trimStartSec) : '')
  const [outPoint, setOutPoint] = useState(node.trimEndSec != null ? String(node.trimEndSec) : '')
  const [ovText, setOvText] = useState(node.overlay?.text ?? '')
  const [ovAlign, setOvAlign] = useState(node.overlay?.align ?? 2)
  const [ovSize, setOvSize] = useState<'sm' | 'md' | 'lg'>(node.overlay?.size ?? 'md')
  const [transDur, setTransDur] = useState(String(clipTransitionSeconds(node)))

  const transition = clipTransitionAfter(node)

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
        trimEndSec: parse(outPoint)
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
      durationSec: id && Number.isFinite(dur) ? Math.min(2, Math.max(0.1, dur)) : null
    })
  }

  const field =
    'w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Scissors className="h-3 w-3 text-accent" /> {t('timeline.clipSettings')}
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
        colorHex: color
      }
    }).then(onClose)
  }

  const field =
    'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: anchor.x, top: anchor.y }}
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

/** Sensible ruler tick spacing: ~8 ticks over the whole edit. */
function rulerTicks(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => total / s <= 8) ?? 600
  const ticks: number[] = []
  for (let t = 0; t < total; t += step) ticks.push(t)
  return ticks
}
