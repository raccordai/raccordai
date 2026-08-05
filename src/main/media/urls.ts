import type { Asset, AssetWithUrl, Generation } from '@shared/ipc/contracts'
import type { GenerationRow } from '../services/generations'

/** Renderer-facing display URLs: local media goes through media://, else the remote URL. */

export function withAssetUrl(asset: Asset): AssetWithUrl {
  return { ...asset, url: asset.filePath ? `media://asset/${asset.id}` : asset.sourceUrl }
}

export function toGeneration(row: GenerationRow): Generation {
  return {
    id: row.id,
    nodeId: row.nodeId,
    videoId: row.videoId,
    status: row.status,
    kieTaskId: row.kieTaskId,
    inputSnapshot: row.inputSnapshot,
    // file:// staging URLs (synchronous providers, pre-copy) are main-only —
    // the renderer could not load them anyway.
    url: row.resultPath
      ? `media://generation/${row.id}/result`
      : row.resultUrl?.startsWith('file://')
        ? null
        : row.resultUrl,
    lastFrameUrl: row.lastFramePath ? `media://generation/${row.id}/lastFrame` : null,
    resultMimeType: row.resultMimeType,
    draft: row.draft ?? false,
    qcVerdict: row.qcVerdict,
    qcNotes: row.qcNotes,
    transcript: (row.transcript as Generation['transcript']) ?? null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    completedAt: row.completedAt
  }
}
