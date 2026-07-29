import { useMemo } from 'react'
import type { AssetWithUrl } from '@shared/ipc/contracts'
import { getStyle, type StyleTemplate } from '@shared/styles/registry'
import { getModel } from '@shared/models'
import type { RecipeValues } from '@shared/designs/registry'
import { graphKeys, useGraph, useIpcMutation, useProjectAssets, useVideo } from './data'

export interface Position {
  x: number
  y: number
}

/** A node of the current graph offered as the source of a `from-*` recipe mode. */
export interface SourceNodeOption {
  id: string
  label: string
  /** What its output produces — matched against the mode's `accepts`. */
  kind: 'image' | 'video' | 'audio'
}

export interface CreateRecipeArgs {
  recipeId: string
  modeId: string
  /** Only when it differs from the mode's own model. */
  modelId?: string
  values: RecipeValues
  source?: { assetId?: string; nodeId?: string }
}

/**
 * Node-creation actions shared by the toolbar's Add-node menu and the canvas
 * right-click menu (§4.6) — same defaults, same recipe conventions, only the
 * spawn position differs per caller.
 *
 * Recipe nodes are built by the MAIN service (`recipes:createNode`), not here:
 * the prompt-building knowledge has to reach the agent tools without a copy,
 * and creating a node WITH its source wired must land as one undo step.
 */
export interface NodeCreationApi {
  /** Plain model node — the graph service seeds model + video defaults. */
  addNode(modelId: string, position: Position): Promise<void>
  /** Recipe → pre-configured node (design sheet or shot preset), source wired. */
  addRecipeNode(args: CreateRecipeArgs, position: Position): Promise<void>
  /** Library design sheet → a studio/asset node wired to it (reference-only intent). */
  addLibraryDesignNode(asset: AssetWithUrl, position: Position): Promise<void>
  /** Published design sheets of the project ("from library" entries). */
  designAssets: AssetWithUrl[]
  /** Every project asset — the pool a `from-image`/`from-video` mode picks from. */
  projectAssets: AssetWithUrl[]
  /** Nodes of the current graph usable as a recipe source. */
  sourceNodes: SourceNodeOption[]
  /** The video's art direction, so the form can preview the real prompt. */
  style: StyleTemplate | undefined
}

export function useNodeCreation(videoId: string, projectId: string): NodeCreationApi {
  const { mutateAsync: createNode } = useIpcMutation('nodes:create', [graphKeys.graph(videoId)])
  const { mutateAsync: createRecipeNode } = useIpcMutation('recipes:createNode', [
    graphKeys.graph(videoId)
  ])
  const video = useVideo(videoId).data
  const projectAssets = useProjectAssets(projectId).data
  const graph = useGraph(videoId).data
  const designAssets = useMemo(
    () => (projectAssets ?? []).filter((a) => a.designId !== null),
    [projectAssets]
  )
  const sourceNodes = useMemo<SourceNodeOption[]>(
    () =>
      (graph?.nodes ?? []).flatMap((node) => {
        const kind = getModel(node.modelId)?.kind
        if (kind !== 'image' && kind !== 'video') return []
        return [{ id: node.id, label: node.label ?? node.key, kind }]
      }),
    [graph]
  )
  const style = video?.styleId ? getStyle(video.styleId) : undefined

  return {
    designAssets,
    projectAssets: projectAssets ?? [],
    sourceNodes,
    style,
    async addNode(modelId, position) {
      await createNode({ videoId, modelId, position })
    },
    async addRecipeNode(args, position) {
      await createRecipeNode({
        videoId,
        recipeId: args.recipeId,
        modeId: args.modeId,
        ...(args.modelId ? { modelId: args.modelId } : {}),
        values: args.values,
        ...(args.source ? { source: args.source } : {}),
        position
      })
    },
    async addLibraryDesignNode(asset, position) {
      await createNode({
        videoId,
        modelId: 'studio/asset',
        position,
        params: { assetId: asset.id },
        label: asset.name,
        intent: `Design sheet "${asset.name}"${asset.designSubject ? ` (${asset.designSubject})` : ''} from the project library — reference only; on a frame anchor it would appear on screen.`
      })
    }
  }
}
