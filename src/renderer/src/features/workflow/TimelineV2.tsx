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
import type { GraphNode, ImageLayer } from '@shared/ipc/contracts'
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
  stillClipSeconds
} from '@shared/timeline'
import { lookCssFilter } from '@shared/looks'
import { useInputStills, useMuted, useResizableHeight } from './timelineHooks'
import { Waveform } from './Waveform'
import { formatSeconds } from '../../lib/formatSeconds'
import { isActivationTarget } from '../../lib/shortcuts'
import { snapSpan, snapTolerance } from '../../lib/timelineSnap'
import {
  anchorTransform,
  overlayPlacement,
  reorderTimelineIds,
  rulerTicks,
  stillHoldAt,
  trimInAt,
  trimOutAt
} from '../../lib/timelineLayout'
import { invoke } from '../../lib/ipc'
import { useShortcut } from '../../components/ui/useShortcut'
import { VideoThumb } from '../../components/VideoThumb'
import { DemoCameraStage, demoCameraInfoFor, type DemoCameraInfo } from './DemoCameraPreview'
import { usePlaybackEngine } from './timeline/usePlaybackEngine'
import { Timecode, TIMECODE_FPS } from './timeline/Timecode'
import { EdgeHandle } from './timeline/EdgeHandle'
import { ClipSettingsPopover } from './timeline/ClipSettingsPopover'
import { LayerSettingsPopover } from './timeline/LayerSettingsPopover'
import { StickerSettingsPopover } from './timeline/StickerSettingsPopover'
import { AudioSettingsPopover } from './timeline/AudioSettingsPopover'
import { FeedbackNotePopover } from './timeline/FeedbackNotePopover'
import { ImagePickerPopover } from './timeline/ImagePickerPopover'
import {
  MAX_STILL_SECONDS,
  MIN_RESIZE_SECONDS,
  MIN_STILL_SECONDS,
  type EngineClip
} from './timeline/types'

/** Timeline clock formatting: tenth-of-a-second precision, never raw floats. */
const fmt = formatSeconds

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Timeline v2 — continuous NLE-style playback over the graph's clips.
 *
 * This file is the COMPOSITION: track layout, gestures and popover anchoring.
 * The playback engine (two stacked <video> elements, gapless advance) lives
 * in ./timeline/usePlaybackEngine, the inspectors in ./timeline/*Popover,
 * and the coordinate/drag math in lib/timelineLayout (pure, unit-tested).
 */
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

  // What the add-to-timeline picker offers: image-kind nodes with a successful
  // output, plus image AND video assets (a video asset becomes a real clip) —
  // excluding what already sits on the timeline.
  const imageCandidates = useMemo(() => {
    const placed = new Set(clipNodes.map((n) => n.id))
    const out: Array<{ node: GraphNode; url: string; video?: boolean }> = []
    for (const node of graph.nodes) {
      if (placed.has(node.id)) continue
      if (node.modelId === 'studio/asset') {
        const media = assetMedia?.[node.id]
        if (media?.url && media.kind !== 'audio') {
          out.push({ node, url: media.url, video: media.kind === 'video' })
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
        const bounds = { min: MIN_STILL_SECONDS, max: MAX_STILL_SECONDS }
        startResize(e, {
          onDelta: (d) =>
            setClipResize({ id: clip.entryId, duration: stillHoldAt(d, side, orig, bounds) }),
          onCommit: (d) => {
            setClipResize(null)
            const dur = Math.round(stillHoldAt(d, side, orig, bounds) * 10) / 10
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
      // Drag deltas arrive in TIMELINE seconds; the trim window is MEDIA time
      // (trimInAt/trimOutAt scale by the speed and clamp — lib/timelineLayout).
      const trimArgs = { origStart, origEnd, raw, speed, minSeconds: MIN_RESIZE_SECONDS }
      startResize(e, {
        onDelta: (d) =>
          setClipResize({
            id: clip.entryId,
            // The live width preview is timeline seconds — media window ÷ speed.
            duration:
              (side === 'left'
                ? origEnd - trimInAt(d, trimArgs)
                : trimOutAt(d, trimArgs) - origStart) / speed
          }),
        onCommit: (d) => {
          setClipResize(null)
          if (side === 'left') {
            const s = Math.round(trimInAt(d, trimArgs) * 100) / 100
            if (Math.abs(s - origStart) < 0.02) return
            void invoke('nodes:setTrim', {
              nodeId: node.id,
              trimStartSec: s > 0 ? s : null,
              trimEndSec: clip.segment.trimEndSec ?? null,
              segmentIndex: clip.segmentIndex
            })
          } else {
            const out = Math.round(trimOutAt(d, trimArgs) * 100) / 100
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
    (layer: { id: string; startSec: number; endSec: number }, side: 'left' | 'right') =>
      (e: ReactPointerEvent) => {
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
    // Space must still ACTIVATE a focused button/link: decline the shortcut
    // (preventDefault skipped) so the native activation runs instead of a
    // surprise play/pause.
    if (isActivationTarget(event.target)) return false
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

  // Demo camera preview (§9): replay the automatic camera (zooms, cursor,
  // framing) on demo-take clips with the same pure math the render bakes.
  const demoCameraByNode = useMemo(() => {
    const out: Record<string, DemoCameraInfo> = {}
    for (const node of graph.nodes) {
      const info = demoCameraInfoFor(node.params, assetMedia?.[node.id])
      if (info) out[node.id] = info
    }
    return out
  }, [graph.nodes, assetMedia])
  const getActiveMediaTime = useCallback((): number => {
    const el = engine.activeSlot === 'A' ? engine.videoARef.current : engine.videoBRef.current
    return el?.currentTime ?? 0
  }, [engine.activeSlot, engine.videoARef, engine.videoBRef])
  const getActiveMediaSize = useCallback((): { width: number; height: number } | null => {
    const el = engine.activeSlot === 'A' ? engine.videoARef.current : engine.videoBRef.current
    return el && el.videoWidth > 0 ? { width: el.videoWidth, height: el.videoHeight } : null
  }, [engine.activeSlot, engine.videoARef, engine.videoBRef])

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
  const activeDemoInfo =
    activeClip && !activeClip.still ? (demoCameraByNode[activeClip.node.id] ?? null) : null
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
            <DemoCameraStage
              info={activeDemoInfo}
              getMediaTime={getActiveMediaTime}
              getMediaSize={getActiveMediaSize}
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
            </DemoCameraStage>
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
                          const ids = reorderTimelineIds(
                            uniq,
                            clips[from]!.node.id,
                            clips[i]!.node.id
                          )
                          if (!ids) return
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
                // Asset nodes (video assets included) are opt-in timeline
                // members — the trash is their only un-place affordance.
                clip.node.modelId === 'studio/asset' || (clip.still && !clip.placeholder)
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
