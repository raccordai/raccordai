/**
 * Synthetic media fixtures, generated with the ffmpeg the app itself bundles
 * (`ffmpeg-static`) so the suite needs no system ffmpeg. Files are cached in
 * `e2e/.fixtures/` (gitignored) and only regenerated when missing.
 *
 * Never borrow real user media: the mock has to serve bytes a real decoder
 * accepts (last-frame extraction, previews, the MP4 render all decode them),
 * and `testsrc2`/`sine` give that for free — deterministically.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const FFMPEG = require('ffmpeg-static')
export const FFPROBE = require('ffprobe-static').path

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.fixtures')

/**
 * The two clips are deliberately heterogeneous (dimensions, fps, audio
 * presence): that combination is what forces the render's normalize path and
 * the silent-track injection, instead of the lossless concat shortcut.
 */
export const FIXTURES = {
  clipA: {
    file: 'clip-a.mp4',
    width: 640,
    height: 360,
    fps: 24,
    // 6s is the shortest clip the video models accept as a `duration` param —
    // specs declare the fixture's real length on the node.
    seconds: 6,
    hasAudio: true,
    contentType: 'video/mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest'
    ]
  },
  clipB: {
    file: 'clip-b.mp4',
    width: 1280,
    height: 720,
    fps: 30,
    seconds: 12,
    hasAudio: false,
    contentType: 'video/mp4',
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=12',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-an'
    ]
  },
  music: {
    file: 'music.mp3',
    // Deliberately longer than the whole sequence, like a real Suno track: the
    // render must trim it, and it is the only sound during the silent clip —
    // which is what makes "the music lane was muxed" provable.
    seconds: 20,
    contentType: 'audio/mpeg',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-c:a', 'libmp3lame']
  },
  still: {
    file: 'still.png',
    width: 640,
    height: 360,
    contentType: 'image/png',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1']
  }
}

/** Absolute path of a fixture, generating it on first use. */
export function fixturePath(name) {
  const fixture = FIXTURES[name]
  if (!fixture) throw new Error(`unknown fixture: ${name}`)
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const target = join(FIXTURE_DIR, fixture.file)
  if (!existsSync(target)) {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...fixture.args, target])
  }
  return target
}

/** Generates every fixture up front (the runner does this once per session). */
export function ensureFixtures() {
  for (const name of Object.keys(FIXTURES)) fixturePath(name)
  return FIXTURE_DIR
}

/** ffprobe JSON of a media file — the render spec's assertion instrument. */
export function probe(file) {
  const raw = execFileSync(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file
  ]).toString()
  return JSON.parse(raw)
}
