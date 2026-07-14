import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getModel } from '@shared/models'
import type { GraphNode } from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'
import { extractLastFrame } from '@renderer/lib/extractLastFrame'
import { graphKeys, useVideoGenerations } from './data'

/**
 * Watches the video's generations and extracts the last frame of every fresh
 * successful video generation (browser <video> + <canvas>), then hands the
 * JPEG to the main process which stores it next to the generation. Downstream
 * 'lastFrame' edges resolve against that file.
 */
export function useLastFrameExtractor(videoId: string, graphNodes: GraphNode[]): void {
  const generations = useVideoGenerations(videoId).data
  const queryClient = useQueryClient()
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    if (!generations) return
    const videoNodeIds = new Set(
      graphNodes.filter((n) => getModel(n.modelId)?.kind === 'video').map((n) => n.id)
    )
    const candidates = generations.filter(
      (g) =>
        g.status === 'success' &&
        !g.lastFrameUrl &&
        g.url &&
        videoNodeIds.has(g.nodeId) &&
        !inFlight.current.has(g.id)
    )
    if (candidates.length === 0) return

    // Serial: frame extraction decodes a whole video — one at a time is plenty.
    let cancelled = false
    void (async () => {
      for (const gen of candidates) {
        if (cancelled) return
        inFlight.current.add(gen.id)
        try {
          const blob = await extractLastFrame(gen.url as string)
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          }
          await invoke('generations:setLastFrame', {
            generationId: gen.id,
            jpegBase64: btoa(binary)
          })
          void queryClient.invalidateQueries({
            queryKey: graphKeys.generationsForVideo(videoId)
          })
        } catch (err) {
          console.error(`[last-frame] extraction failed for ${gen.id}`, err)
        } finally {
          inFlight.current.delete(gen.id)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [generations, graphNodes, videoId, queryClient])
}
