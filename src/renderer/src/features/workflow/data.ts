import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type {
  AssetWithUrl,
  Generation,
  GraphEdge,
  GraphNode,
  IpcChannel,
  IpcInput,
  IpcOutput
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
    queryFn: () => invoke('graph:timelineFallbackImages', { videoId })
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
