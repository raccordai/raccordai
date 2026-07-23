import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssetWithUrl } from '@shared/ipc/contracts'
import { getStyle } from '@shared/styles/registry'
import { designIntent, designNodeParams, getDesignRecipe } from '@shared/designs/registry'
import { graphKeys, useIpcMutation, useProjectAssets, useVideo } from './data'

export interface Position {
  x: number
  y: number
}

/**
 * Node-creation actions shared by the toolbar's Add-node menu and the canvas
 * right-click menu (§4.6) — same defaults, same design/library conventions,
 * only the spawn position differs per caller.
 */
export interface NodeCreationApi {
  /** Plain model node — the graph service seeds model + video defaults. */
  addNode(modelId: string, position: Position): Promise<void>
  /** Design recipe → pre-configured image node (prompt built per model + style). */
  addDesignNode(recipeId: string, description: string, position: Position): Promise<void>
  /** Library design sheet → a studio/asset node wired to it (reference-only intent). */
  addLibraryDesignNode(asset: AssetWithUrl, position: Position): Promise<void>
  /** Published design sheets of the project ("from library" entries). */
  designAssets: AssetWithUrl[]
}

export function useNodeCreation(videoId: string, projectId: string): NodeCreationApi {
  const { t } = useTranslation()
  const { mutateAsync: createNode } = useIpcMutation('nodes:create', [graphKeys.graph(videoId)])
  const video = useVideo(videoId).data
  const projectAssets = useProjectAssets(projectId).data
  const designAssets = useMemo(
    () => (projectAssets ?? []).filter((a) => a.designId !== null),
    [projectAssets]
  )

  return {
    designAssets,
    async addNode(modelId, position) {
      await createNode({ videoId, modelId, position })
    },
    async addDesignNode(recipeId, description, position) {
      const recipe = getDesignRecipe(recipeId)
      if (!recipe) return
      const style = video?.styleId ? getStyle(video.styleId) : undefined
      const name = t(`designs.${recipeId}.name` as never) as string
      const subject = description.trim()
      await createNode({
        videoId,
        modelId: recipe.defaultModelId,
        position,
        params: designNodeParams(recipe, recipe.defaultModelId, { description: subject, style }),
        label: subject ? `${name} — ${subject.slice(0, 40)}` : name,
        intent: designIntent(recipe)
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
