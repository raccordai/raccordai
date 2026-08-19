import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type {
  AssetWithUrl,
  FeedbackItem,
  Generation,
  GraphEdge,
  GraphNode,
  ImageLayer,
  IpcChannel,
  IpcInput,
  IpcOutput,
  QueueState,
  TextLayer
} from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'

/**
 * Data layer for the workflow editor — the local replacement for video-studio's
 * Convex hooks. Queries are keyed so that graph mutations invalidate exactly
 * what changed; there is no server push, so anything that must refresh after a
 * mutation goes through invalidation here.
 */

export const graphKeys = {
  graph: (videoId: string) => ['graph', videoId] as const,
  fallbackImages: (videoId: string) => ['graph', videoId, 'fallbackImages'] as const,
  generationsForNode: (nodeId: string) => ['generations', 'node', nodeId] as const,
  generationsForVideo: (videoId: string) => ['generations', 'video', videoId] as const,
  history: (videoId: string) => ['generations', 'history', videoId] as const,
  asset: (assetId: string) => ['assets', assetId] as const,
  assetsForProject: (projectId: string) => ['assets', 'project', projectId] as const,
  video: (videoId: string) => ['videos', videoId] as const,
  videosForProject: (projectId: string) => ['videos', 'project', projectId] as const,
  project: (projectId: string) => ['projects', projectId] as const
}

export type WorkflowGraphData = { nodes: GraphNode[]; edges: GraphEdge[] }

export function useGraph(videoId: string): UseQueryResult<WorkflowGraphData> {
  return useQuery({
    queryKey: graphKeys.graph(videoId),
    queryFn: () => invoke('graph:get', { videoId })
  })
}

export function useTimelineFallbackImages(videoId: string): UseQueryResult<Record<string, string>> {
  return useQuery({
    queryKey: graphKeys.fallbackImages(videoId),
    // 'missing' scope: input stills for EVERY clip without a success yet, so
    // the timeline's animatic mode can play them (the render keeps 'failed').
    queryFn: () => invoke('graph:timelineFallbackImages', { videoId, scope: 'missing' })
  })
}

/**
 * Display media of the graph's `studio/asset` nodes, keyed by NODE id — what
 * the timeline needs to show an asset still (url) and to know it is one
 * (mimeType). Refreshed with the graph key so a swapped asset follows.
 */
export function useAssetNodeMedia(
  videoId: string,
  nodes: GraphNode[]
): UseQueryResult<Record<string, { url: string; mimeType: string | null }>> {
  const assetNodes = nodes.filter((n) => n.modelId === 'studio/asset')
  const ids = assetNodes.map((n) => n.id).join('|')
  return useQuery({
    queryKey: [...graphKeys.graph(videoId), 'assetNodeMedia', ids],
    queryFn: async () => {
      const out: Record<string, { url: string; mimeType: string | null }> = {}
      for (const node of assetNodes) {
        const assetId = (node.params as { assetId?: string } | undefined)?.assetId
        if (!assetId) continue
        const asset = await invoke('assets:get', { assetId })
        if (asset?.url) out[node.id] = { url: asset.url, mimeType: asset.mimeType }
      }
      return out
    }
  })
}

/** The title track (§6.12b) — refreshed by event:workflowChanged like the graph. */
export function useTextLayers(videoId: string): UseQueryResult<TextLayer[]> {
  return useQuery({
    queryKey: ['textLayers', videoId],
    queryFn: () => invoke('textLayers:list', { videoId })
  })
}

/** The sticker track (§6.12d) — same refresh contract as the title track. */
export function useImageLayers(videoId: string): UseQueryResult<ImageLayer[]> {
  return useQuery({
    queryKey: ['imageLayers', videoId],
    queryFn: () => invoke('imageLayers:list', { videoId })
  })
}

/** The feedback bucket (§6.13) — same refresh contract as the layer tracks. */
export function useFeedback(videoId: string): UseQueryResult<FeedbackItem[]> {
  return useQuery({
    queryKey: ['feedback', videoId],
    queryFn: () => invoke('feedback:list', { videoId })
  })
}

export function useNodeGenerations(nodeId: string): UseQueryResult<Generation[]> {
  return useQuery({
    queryKey: graphKeys.generationsForNode(nodeId),
    queryFn: () => invoke('generations:listForNode', { nodeId })
  })
}

export function useVideoGenerations(videoId: string): UseQueryResult<Generation[]> {
  return useQuery({
    queryKey: graphKeys.generationsForVideo(videoId),
    queryFn: () => invoke('generations:listForVideo', { videoId })
  })
}

export function useGenerationHistory(videoId: string) {
  return useQuery({
    queryKey: graphKeys.history(videoId),
    queryFn: () => invoke('generations:historyForVideo', { videoId })
  })
}

/** Run-queue positions + retry attempts — refreshed by event:queueChanged. */
export function useQueueState(): UseQueryResult<QueueState> {
  return useQuery({
    queryKey: ['queue', 'state'],
    queryFn: () => invoke('generations:queueState')
  })
}

/** What an in-flight generation is actually doing — drives the node badges. */
export type RunState =
  | { kind: 'queued'; position: number }
  | { kind: 'retrying'; attempt: number }
  | { kind: 'generating' }

export function runStateFor(
  generation: Pick<Generation, 'id' | 'status'> | undefined,
  queue: QueueState | undefined
): RunState | null {
  if (!generation || (generation.status !== 'pending' && generation.status !== 'running')) {
    return null
  }
  if (generation.status === 'pending' && queue) {
    const attempt = queue.retrying[generation.id]
    if (attempt) return { kind: 'retrying', attempt }
    const position = queue.queued.indexOf(generation.id)
    if (position >= 0) return { kind: 'queued', position: position + 1 }
  }
  // 'running', or 'pending' mid-submission (slot already acquired).
  return { kind: 'generating' }
}

/** Pass null to skip (the Convex 'skip' sentinel equivalent). */
export function useAsset(assetId: string | null): UseQueryResult<AssetWithUrl | null> {
  return useQuery({
    queryKey: graphKeys.asset(assetId ?? 'none'),
    queryFn: () => invoke('assets:get', { assetId: assetId as string }),
    enabled: assetId !== null
  })
}

export function useProjectAssets(projectId: string): UseQueryResult<AssetWithUrl[]> {
  return useQuery({
    queryKey: graphKeys.assetsForProject(projectId),
    queryFn: () => invoke('assets:listByProject', { projectId })
  })
}

export function useVideo(videoId: string) {
  return useQuery({
    queryKey: graphKeys.video(videoId),
    queryFn: () => invoke('videos:get', { videoId })
  })
}

export function useProjectVideos(projectId: string) {
  return useQuery({
    queryKey: graphKeys.videosForProject(projectId),
    queryFn: () => invoke('videos:listByProject', { projectId })
  })
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: graphKeys.project(projectId),
    queryFn: () => invoke('projects:get', { id: projectId })
  })
}

/** Invalidate the whole graph view for a video (nodes, edges, generations, history). */
export function useInvalidateWorkflow(videoId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
    void queryClient.invalidateQueries({ queryKey: ['generations'] })
  }
}

/**
 * Generic IPC mutation bound to a channel, invalidating the given keys on success.
 * Usage: const updateLabel = useIpcMutation('nodes:updateLabel', [graphKeys.graph(videoId)])
 */
export function useIpcMutation<C extends IpcChannel>(
  channel: C,
  invalidate: ReadonlyArray<readonly unknown[]> = []
) {
  const queryClient = useQueryClient()
  return useMutation<IpcOutput<C>, Error, IpcInput<C>>({
    mutationFn: (input: IpcInput<C>) => window.api.invoke(channel, input) as Promise<IpcOutput<C>>,
    onSuccess: () => {
      for (const key of invalidate) {
        void queryClient.invalidateQueries({ queryKey: key as unknown[] })
      }
    }
  })
}
