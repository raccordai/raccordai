import ffmpegStatic from 'ffmpeg-static'
// NOT ffprobe-static: its darwin/arm64 binary is actually x86_64 (see render.ts history).
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

/**
 * Bundled ffmpeg/ffprobe resolution, shared by the MP4 render and the
 * main-side last-frame extraction. In the packaged app the binaries live
 * outside the asar (asarUnpack in electron-builder.yml) — they are spawned as
 * child processes and can't run from inside the archive.
 */

export const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')

export function ffmpegPath(): string {
  if (!ffmpegStatic) throw new Error('ffmpeg binary not bundled for this platform')
  return unpacked(ffmpegStatic)
}

export function ffprobePath(): string {
  return unpacked(ffprobeInstaller.path)
}
