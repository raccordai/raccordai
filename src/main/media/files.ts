import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app } from 'electron'

/**
 * Managed media store: userData/media/<projectId>/<ownerId>.<ext>
 * All local media (imported assets, downloaded generations, extracted frames)
 * lives here so a project's files can be bundled on export and cleaned on delete.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac'
}

export function mimeTypeFor(filePath: string): string | null {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? null
}

export function mediaKindFor(filePath: string): 'image' | 'video' | 'audio' | null {
  const mime = mimeTypeFor(filePath)
  if (!mime) return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'audio'
}

export function mediaDirFor(projectId: string): string {
  const dir = join(app.getPath('userData'), 'media', projectId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Copies a source file into the managed store; returns { filePath, size }. */
export function importFileToStore(
  projectId: string,
  ownerId: string,
  sourcePath: string
): { filePath: string; size: number } {
  const target = join(mediaDirFor(projectId), `${ownerId}${extname(sourcePath).toLowerCase()}`)
  copyFileSync(sourcePath, target)
  return { filePath: target, size: statSync(target).size }
}

export function deleteProjectMedia(projectId: string): void {
  rmSync(join(app.getPath('userData'), 'media', projectId), { recursive: true, force: true })
}

export function deleteMediaFile(filePath: string | null | undefined): void {
  if (!filePath) return
  rmSync(filePath, { force: true })
}
