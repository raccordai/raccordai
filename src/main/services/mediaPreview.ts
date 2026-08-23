import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ffmpegPath, ffprobePath } from '../media/ffbin'
import { mediaKindFor } from '../media/files'
import { getGeneration } from './generations'
import { buildPreviewArgs, resolvePreviewSeek, type PreviewPosition } from './renderPlan'
import type { ToolMediaResult } from '../mcp/registry'

/**
 * Agent vision (get_generation_media) — turns a generation's cached media into
 * a small inline JPEG the model can actually look at. Thin ffmpeg shell like
 * render.ts: every decision (seek resolution, argv) is pure in renderPlan.ts;
 * this file only spawns and reads files (E2E scope, not unit coverage).
 */

const exec = promisify(execFile)

async function probeDurationSec(path: string): Promise<number | null> {
  try {
    const { stdout } = await exec(ffprobePath(), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      path
    ])
    const n = Number.parseFloat(stdout.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Renders one media file to a downscaled base64 JPEG (shared by the tools). */
export async function previewImageBase64(
  mediaPath: string,
  seek: { atSec?: number; fromEnd?: boolean } = {}
): Promise<string> {
  const dir = join(tmpdir(), 'raccord-preview')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `${randomUUID()}.jpg`)
  try {
    await exec(ffmpegPath(), buildPreviewArgs(mediaPath, out, seek))
    return readFileSync(out).toString('base64')
  } finally {
    rmSync(out, { force: true })
  }
}

export async function generationMediaPreview(
  generationId: string,
  opts: { position?: PreviewPosition; atSec?: number } = {}
): Promise<ToolMediaResult> {
  const gen = getGeneration(generationId)
  if (!gen) throw new Error(`Unknown generation: ${generationId}`)
  if (gen.status !== 'success') {
    throw new Error(`Generation is ${gen.status} — only successful generations have media.`)
  }
  if (!gen.resultPath) {
    throw new Error(
      'The result is not cached locally yet — call refresh_generation_status, then retry.'
    )
  }
  const kind = mediaKindFor(gen.resultPath)
  if (kind !== 'image' && kind !== 'video') {
    throw new Error('This generation is audio — it has no visual preview; use get_transcript.')
  }
  const seek =
    kind === 'video'
      ? opts.atSec !== undefined
        ? { atSec: Math.max(0, opts.atSec) }
        : resolvePreviewSeek(opts.position ?? 'middle', await probeDurationSec(gen.resultPath))
      : {}
  const base64 = await previewImageBase64(gen.resultPath, seek)
  const frame =
    kind === 'video'
      ? opts.atSec !== undefined
        ? `${Math.max(0, opts.atSec)}s`
        : (opts.position ?? 'middle')
      : undefined
  return {
    kind: 'tool-media',
    text: JSON.stringify({ generationId, mediaKind: kind, ...(frame ? { frame } : {}) }),
    images: [{ mediaType: 'image/jpeg', base64 }]
  }
}
