import { invoke } from '@renderer/lib/ipc'

/**
 * Everything that talks to kie.ai (running nodes, refreshing remote status,
 * cancelling, prompt refinement, promoting a generation to the asset library).
 * Backed by the main-process run engine since phase 3.
 */

export function refreshStatus(args: { nodeId: string }): Promise<{ status: string }> {
  return invoke('generations:refreshStatus', args)
}

export function cancelGeneration(args: { nodeId: string }): Promise<{ cancelled: boolean }> {
  return invoke('generations:cancel', args)
}

export function refineImagePrompt(args: {
  currentPrompt: string
  imageUrl: string
  instruction: string
}): Promise<{ prompt: string }> {
  return invoke('ai:refineImagePrompt', args)
}

export async function promoteGeneration(args: {
  generationId: string
  name: string
  description?: string
}): Promise<string> {
  const asset = await invoke('assets:promoteGeneration', args)
  return asset.id
}

export const generationEngineReady = true
