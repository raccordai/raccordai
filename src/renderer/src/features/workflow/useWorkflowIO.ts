import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { zipSync, type Zippable } from 'fflate'
import type { GraphNode, RenderProgressPayload } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'
import {
  buildFcpxml,
  clipSlug,
  extForMime,
  sanitizeName,
  type FcpxmlAudioTrack,
  type FcpxmlClip
} from '@shared/fcpxml'
import { fetchMediaBlob } from '@renderer/lib/mediaProxy'
import { detectVideoFps, probeAudioDuration, probeVideoDimensions } from '@renderer/lib/probeMedia'
import { isCaptionPresetId } from '@shared/captions'
import {
  audioLaneStarts,
  audioRoleOf,
  bestGeneration,
  clipDuration,
  clipTimelineOffset,
  clipTrim,
  collectAudioNodes,
  collectTimelineClips,
  isStillClip
} from '@shared/timeline'
import { graphKeys, useIpcMutation, useVideo } from './data'

// Workflow import/export actions, extracted from the toolbar so the app menu
// bar (Fichier) can drive them. Errors surface as toasts — same convention
// as the editor's run failures.

/** Trigger a browser download — lands in the browser's default download folder (~/Downloads). */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Programmatic file picker (the menu has no room for a hidden <input>). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

export interface RenderProgressState {
  percent: number
  step: RenderProgressPayload['step']
}

/**
 * Per-destination MP4 export presets (§4.5 follow-up): fixed output dims fed
 * to the render pipeline's existing resolution override (clips are
 * scaled+padded by the normalize pass). No preset = probed from the clips.
 */
export const RENDER_PRESETS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
} as const
export type RenderPreset = keyof typeof RENDER_PRESETS

export interface WorkflowIO {
  importWorkflow: () => Promise<void>
  exportJson: () => Promise<void>
  exportFcpxmlZip: () => Promise<void>
  exportMediaZip: () => Promise<void>
  /** Rendered MP4 export (ffmpeg in main; save dialog lives in the handler).
   *  Optional preset forces the output dims (default: probed from the clips);
   *  burnSubtitles burns the scenario's quoted dialogue into the picture. */
  exportMp4: (
    preset?: RenderPreset,
    options?: {
      burnSubtitles?: boolean
      /** Dynamic captions from the speech lane's transcripts (preset id). */
      captionsPreset?: string
      /** Duck the music bed under the voice-over. */
      duckMusic?: boolean
      /** Encoder quality (default 'standard'). */
      quality?: 'draft' | 'standard' | 'high'
      /** Output codec (default h264). */
      codec?: 'h264' | 'hevc'
      watermark?: {
        text: string
        position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      }
    }
  ) => Promise<void>
  cancelRenderMp4: () => void
  importing: boolean
  exporting: boolean
  exportingZip: boolean
  exportingMedia: boolean
  renderingMp4: boolean
  /** Live progress of the MP4 render (event:renderProgress), null when idle. */
  renderProgress: RenderProgressState | null
  /** JSON export needs at least one node. */
  canExport: boolean
  /** FCPXML, media and MP4 exports need at least one timeline clip. */
  canExportFcpxml: boolean
}

export function useWorkflowIO(videoId: string, nodes: GraphNode[]): WorkflowIO {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const video = useVideo(videoId).data
  const { mutateAsync: importJson } = useIpcMutation('workflow:import', [
    graphKeys.graph(videoId),
    ['generations']
  ])
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportingZip, setExportingZip] = useState(false)
  const [exportingMedia, setExportingMedia] = useState(false)
  const [renderingMp4, setRenderingMp4] = useState(false)
  const [renderProgress, setRenderProgress] = useState<RenderProgressState | null>(null)

  const timelineClips = useMemo(() => collectTimelineClips(nodes), [nodes])
  const videoName = video?.name

  const importWorkflow = useCallback(async () => {
    const file = await pickFile('application/json')
    if (!file) return
    setImporting(true)
    try {
      const text = await file.text()
      const replace = await confirmModal({
        message: t('editor.replaceConfirm'),
        confirmLabel: t('editor.importReplaceBtn'),
        cancelLabel: t('editor.importMergeBtn')
      })
      await importJson({ videoId, json: text, replace })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [importJson, confirmModal, toast, t, videoId])

  const exportJsonAction = useCallback(async () => {
    setExporting(true)
    try {
      // Use the server-side builder so asset references are resolved to portable keys
      // and the assets manifest is included for LLM context.
      const payload = await invoke('workflow:export', { videoId })
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      downloadBlob(blob, `workflow-${videoId}.json`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [toast, videoId])

  /**
   * Bundle the timeline as an FCPXML + its media into a ZIP. For each clip we
   * resolve the node's selected successful generation, download the media, and
   * reference it from the FCPXML by its relative path inside the archive.
   */
  const exportFcpxmlZip = useCallback(async () => {
    setExportingZip(true)
    try {
      const baseName = sanitizeName(videoName ?? '', 'timeline')

      // Input images per node — used as still placeholders when a video failed/has no output.
      const fallbackImages = await invoke('graph:timelineFallbackImages', { videoId })

      // Resolve + download each clip's media in parallel.
      const resolved = await Promise.all(
        timelineClips.map(
          async (
            node,
            i
          ): Promise<{ clip: FcpxmlClip; file?: { path: string; bytes: Uint8Array } }> => {
            const prefix = `media/${String(i + 1).padStart(2, '0')}-${clipSlug(node)}`

            // 0) User-placed still (image/asset node): bundle the image itself,
            //    held for its trim-window duration.
            if (isStillClip(node)) {
              let url: string | null
              if (node.modelId === 'studio/asset') {
                const assetId = (node.params as { assetId?: string } | undefined)?.assetId
                const asset = assetId ? await invoke('assets:get', { assetId }) : null
                url = asset?.url ?? null
              } else {
                const gens = await invoke('generations:listForNode', { nodeId: node.id })
                const gen = bestGeneration(node, gens)
                url = gen?.status === 'success' ? (gen.url ?? null) : null
              }
              if (url) {
                try {
                  const blob = await fetchMediaBlob(url)
                  const mime = blob.type || 'image/jpeg'
                  const path = `${prefix}-still.${extForMime(mime)}`
                  const bytes = new Uint8Array(await blob.arrayBuffer())
                  return { clip: { node, mediaPath: path, isStill: true }, file: { path, bytes } }
                } catch {
                  // Unfetchable image → placeholder gap below.
                }
              }
              return { clip: { node } }
            }

            // 1) Best successful video output → use it (selected if successful,
            //    else the most recent success — same rule as the timeline display).
            const gens = await invoke('generations:listForNode', { nodeId: node.id })
            const gen = bestGeneration(node, gens)
            if (gen?.status === 'success' && gen.url) {
              let blob: Blob
              try {
                blob = await fetchMediaBlob(gen.url)
              } catch (e) {
                throw new Error(
                  `Download failed for "${node.label ?? node.key}": ${e instanceof Error ? e.message : String(e)}`,
                  { cause: e }
                )
              }
              const mime = blob.type || gen.resultMimeType
              const path = `${prefix}.${extForMime(mime ?? undefined)}`
              const bytes = new Uint8Array(await blob.arrayBuffer())
              // Probe the real resolution/duration so the FCPXML matches the footage.
              const media = (await probeVideoDimensions(blob)) ?? undefined
              return { clip: { node, mediaPath: path, media }, file: { path, bytes } }
            }

            // 2) No usable video (failed / not run) → fall back to the input image as a still.
            const imageUrl = fallbackImages[node.id]
            if (imageUrl) {
              try {
                const blob = await fetchMediaBlob(imageUrl)
                const mime = blob.type || 'image/jpeg'
                const path = `${prefix}-still.${extForMime(mime)}`
                const bytes = new Uint8Array(await blob.arrayBuffer())
                return { clip: { node, mediaPath: path, isStill: true }, file: { path, bytes } }
              } catch {
                // Couldn't fetch the still → fall through to a placeholder gap.
              }
            }

            // 3) Nothing available → placeholder gap (keeps the slot + timing).
            return { clip: { node } }
          }
        )
      )

      // §8 audio lanes (Suno bed + ElevenLabs speech): bundle each track's file
      // and compute its final-timeline start with the SAME lane layout as the
      // preview and the MP4 render (audioLaneStarts — explicit offsets are
      // absolute, offset-less tracks chain after the previous one).
      const audioResolved = (
        await Promise.all(
          collectAudioNodes(nodes).map(async (node, i) => {
            const gens = await invoke('generations:listForNode', { nodeId: node.id })
            const gen = bestGeneration(node, gens)
            if (gen?.status !== 'success' || !gen.url) return null
            let blob: Blob
            try {
              blob = await fetchMediaBlob(gen.url)
            } catch {
              return null
            }
            const mime = blob.type || gen.resultMimeType || 'audio/mpeg'
            const path = `media/audio-${String(i + 1).padStart(2, '0')}-${clipSlug(node)}.${extForMime(mime)}`
            return {
              node,
              path,
              bytes: new Uint8Array(await blob.arrayBuffer()),
              duration: (await probeAudioDuration(blob)) ?? undefined
            }
          })
        )
      ).filter((t) => t !== null)
      const audioTracks: FcpxmlAudioTrack[] = []
      for (const role of ['music', 'speech'] as const) {
        const lane = audioResolved.filter((track) => audioRoleOf(track.node) === role)
        const starts = audioLaneStarts(
          lane.map((track) => {
            const raw = track.duration ?? clipDuration(track.node) ?? 5
            const trim = clipTrim(track.node, raw)
            return {
              offsetSec: clipTimelineOffset(track.node),
              durationSeconds: Math.max(0, (trim.end ?? raw) - trim.start)
            }
          })
        )
        lane.forEach((track, i) =>
          audioTracks.push({
            node: track.node,
            mediaPath: track.path,
            role,
            duration: track.duration,
            startSec: starts[i] ?? 0
          })
        )
      }

      // Detect the source frame rate once (clips share a pipeline) from the first
      // probed video, reusing its already-downloaded bytes. Falls back to 25fps.
      const firstVideo = resolved.find((r) => r.file && r.clip.media)
      const fps = firstVideo?.file
        ? ((await detectVideoFps(
            new Blob([firstVideo.file.bytes as BlobPart], { type: 'video/mp4' })
          )) ?? undefined)
        : undefined

      const xml = buildFcpxml(
        videoName ?? 'timeline',
        resolved.map((r) => r.clip),
        { fps, audio: audioTracks }
      )

      const entries: Zippable = { [`${baseName}.fcpxml`]: new TextEncoder().encode(xml) }
      for (const r of resolved) {
        if (r.file) entries[r.file.path] = r.file.bytes
      }
      for (const track of audioResolved) {
        entries[track.path] = track.bytes
      }

      const zipped = zipSync(entries)
      downloadBlob(new Blob([zipped as BlobPart], { type: 'application/zip' }), `${baseName}.zip`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExportingZip(false)
    }
  }, [timelineClips, nodes, toast, videoId, videoName])

  /**
   * Plain media export: each timeline clip's video, numbered in timeline order
   * (01-slug.mp4, 02-…), zipped flat — ready for any editor or direct sharing.
   * Clips without a successful output are skipped and listed afterwards.
   */
  const exportMediaZip = useCallback(async () => {
    setExportingMedia(true)
    try {
      const baseName = sanitizeName(videoName ?? '', 'clips')
      const entries: Zippable = {}
      const skipped: string[] = []

      await Promise.all(
        timelineClips.map(async (node, i) => {
          const gens = await invoke('generations:listForNode', { nodeId: node.id })
          const gen = bestGeneration(node, gens)
          if (gen?.status !== 'success' || !gen.url) {
            skipped.push(node.label ?? node.key)
            return
          }
          let blob: Blob
          try {
            blob = await fetchMediaBlob(gen.url)
          } catch (e) {
            throw new Error(
              `Download failed for "${node.label ?? node.key}": ${e instanceof Error ? e.message : String(e)}`,
              { cause: e }
            )
          }
          const mime = blob.type || gen.resultMimeType
          const name = `${String(i + 1).padStart(2, '0')}-${clipSlug(node)}.${extForMime(mime ?? undefined)}`
          entries[name] = new Uint8Array(await blob.arrayBuffer())
        })
      )

      if (Object.keys(entries).length === 0) throw new Error(t('editor.mediaZipEmpty'))
      // level 0: video files are already compressed, deflating them only burns CPU.
      const zipped = zipSync(entries, { level: 0 })
      downloadBlob(
        new Blob([zipped as BlobPart], { type: 'application/zip' }),
        `${baseName}-clips.zip`
      )
      if (skipped.length > 0) {
        toast.warning(t('editor.mediaZipSkipped', { clips: skipped.join(', ') }))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExportingMedia(false)
    }
  }, [t, timelineClips, toast, videoName])

  // Live percent/step pushed by main while ffmpeg works.
  useEffect(() => {
    return window.api.on('event:renderProgress', (payload) => {
      const p = payload as RenderProgressPayload
      if (p.videoId !== videoId) return
      setRenderProgress(p.done ? null : { percent: p.percent, step: p.step })
    })
  }, [videoId])

  /**
   * Rendered MP4 of the timeline. The whole pipeline runs in main (ffmpeg);
   * the invoke resolves when the file is written (null = dialog cancelled).
   */
  const exportMp4 = useCallback(
    async (preset?: RenderPreset, options?: Parameters<WorkflowIO['exportMp4']>[1]) => {
      setRenderingMp4(true)
      try {
        const result = await invoke('render:export', {
          videoId,
          ...(preset ? { resolution: RENDER_PRESETS[preset] } : {}),
          ...(options?.burnSubtitles ? { burnSubtitles: true } : {}),
          ...(isCaptionPresetId(options?.captionsPreset)
            ? { captionsPreset: options.captionsPreset }
            : {}),
          ...(options?.duckMusic ? { duckMusic: true } : {}),
          ...(options?.quality && options.quality !== 'standard'
            ? { quality: options.quality }
            : {}),
          ...(options?.codec && options.codec !== 'h264' ? { codec: options.codec } : {}),
          ...(options?.watermark?.text.trim() ? { watermark: options.watermark } : {})
        })
        if (result) {
          toast.success(t('editor.renderDone', { path: result.path }))
          if (result.skipped.length > 0) {
            toast.warning(t('editor.renderSkipped', { clips: result.skipped.join(', ') }))
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // User-initiated cancellation is not an error worth surfacing.
        if (!message.includes('Render cancelled')) toast.error(message)
      } finally {
        setRenderingMp4(false)
        setRenderProgress(null)
      }
    },
    [t, toast, videoId]
  )

  const cancelRenderMp4 = useCallback(() => {
    void invoke('render:cancel', { videoId })
  }, [videoId])

  return useMemo(
    () => ({
      importWorkflow,
      exportJson: exportJsonAction,
      exportFcpxmlZip,
      exportMediaZip,
      exportMp4,
      cancelRenderMp4,
      importing,
      exporting,
      exportingZip,
      exportingMedia,
      renderingMp4,
      renderProgress,
      canExport: nodes.length > 0,
      canExportFcpxml: timelineClips.length > 0
    }),
    [
      importWorkflow,
      exportJsonAction,
      exportFcpxmlZip,
      exportMediaZip,
      exportMp4,
      cancelRenderMp4,
      importing,
      exporting,
      exportingZip,
      exportingMedia,
      renderingMp4,
      renderProgress,
      nodes.length,
      timelineClips.length
    ]
  )
}
