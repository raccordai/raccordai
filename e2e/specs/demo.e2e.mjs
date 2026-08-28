/**
 * Demo mode (§9), credit-free: the upload → transcode → asset-import pipeline
 * driven through the IPC surface in EXTERNAL mode — a synthetic VP9 webm
 * stands in for the MediaRecorder capture, because a real getDisplayMedia is
 * not reliable on headless CI (the real capture path is verified manually via
 * /verify on macOS). Asserted on the produced ASSET (ffprobe on the managed
 * file, journal round-trip), not on the app's report alone.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { launchApp } from '../harness/app.mjs'
import { FFMPEG, FIXTURES, fixturePath, probe } from '../harness/fixtures.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkClose, checkEqual, defer, ok, spec, step } from '../harness/spec.mjs'

/**
 * PSNR between one frame of two files at the same timecode — how we prove the
 * automatic camera really transformed the picture (a zoomed frame scores LOW
 * against the raw capture; an identity frame scores high).
 */
function psnrAt(fileA, fileB, t) {
  // Input-side -t windows: with -frames:v the psnr filter is torn down before
  // it logs its summary line — a short decoded window flushes it properly.
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-ss',
      String(t),
      '-t',
      '0.25',
      '-i',
      fileA,
      '-ss',
      String(t),
      '-t',
      '0.25',
      '-i',
      fileB,
      '-filter_complex',
      '[0:v][1:v]psnr',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const match = /average:(inf|[\d.]+)/.exec(`${run.stdout}${run.stderr}`)
  if (!match) throw new Error(`psnr produced no average for ${fileA} vs ${fileB}`)
  return match[1] === 'inf' ? 99 : Number(match[1])
}

/** Base64 slices sized to exercise several appendChunk calls, cut on 4-char boundaries. */
function base64Chunks(bytes, maxChars = 64_000) {
  const base64 = Buffer.from(bytes).toString('base64')
  const step = maxChars - (maxChars % 4)
  const chunks = []
  for (let i = 0; i < base64.length; i += step) chunks.push(base64.slice(i, i + step))
  return chunks
}

const EVENTS = [
  { t: 1, type: 'click', x: 0.25, y: 0.1 },
  { t: 2.2, type: 'move', x: 0.6, y: 0.4 },
  { t: 3.5, type: 'key' }
]

await spec('demo', async () => {
  const mock = await startKieMock()
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base, extraEnv: { RACCORD_DEMO: '1' } })
  defer(() => app.close())
  const { invoke } = app

  step('demo mode is armed by the env flag')
  const info = await invoke('app:getInfo')
  checkEqual(info.demo, true, 'app:getInfo reports demo mode on')

  step('external session: stream a synthetic capture through the pipeline')
  const project = await invoke('projects:create', { name: 'E2E — Demo' })
  const { sessionId } = await invoke('demo:start', { projectId: project.id, external: true })
  check(sessionId.length > 0, 'demo:start returned a session id')

  const doubleStart = await invoke('demo:start', { external: true }).then(
    () => null,
    (error) => error
  )
  check(/already in progress/i.test(doubleStart?.message ?? ''), 'a second start is refused')

  const webmBytes = readFileSync(fixturePath('demoWebm'))
  const chunks = base64Chunks(webmBytes)
  check(chunks.length > 1, `the capture streams as several chunks (${chunks.length})`)
  let seq = 0
  for (const base64 of chunks) {
    await invoke('demo:appendChunk', { sessionId, seq, base64 })
    seq += 1
  }

  const badSeq = await invoke('demo:appendChunk', { sessionId, seq: seq + 5, base64: 'AAAA' }).then(
    () => null,
    (error) => error
  )
  check(/out of order/i.test(badSeq?.message ?? ''), 'an out-of-order chunk fails loudly')

  await invoke('demo:finish', {
    sessionId,
    durationSec: FIXTURES.demoWebm.seconds,
    events: EVENTS
  })

  step('stop returns the imported take')
  const result = await invoke('demo:stop')
  check(result.assetId !== null, 'the take was imported as a project asset')
  checkEqual(result.format, 'mp4', 'the webm was transcoded to mp4')
  checkClose(result.durationSec, FIXTURES.demoWebm.seconds, 0.1, 'the duration is echoed back')
  checkEqual(result.events.length, EVENTS.length, 'the journal is echoed back')

  step('the asset carries the journal and a real mp4')
  const assets = await invoke('assets:listByProject', { projectId: project.id })
  const asset = assets.find((a) => a.id === result.assetId)
  check(asset !== undefined, 'the asset row exists')
  checkEqual(asset.kind, 'video', 'the take is a video asset')
  checkEqual(asset.mimeType, 'video/mp4', 'stored as mp4')
  check(
    JSON.stringify(asset.demoEvents) === JSON.stringify(EVENTS),
    'demo_events round-trips the journal'
  )

  const mediaInfo = probe(asset.filePath)
  const videoStream = mediaInfo.streams.find((s) => s.codec_type === 'video')
  checkEqual(videoStream.codec_name, 'h264', 'the managed file is H.264')
  checkEqual(videoStream.width, FIXTURES.demoWebm.width, 'dimensions survived the transcode')
  checkClose(
    Number(mediaInfo.format.duration),
    FIXTURES.demoWebm.seconds,
    0.5,
    'ffprobe agrees on the media duration'
  )
  ok('the demo take landed as an editable video asset')

  step('the session is fully released')
  const status = await invoke('demo:status')
  checkEqual(status.recording, false, 'no session left behind')
  const stopAgain = await invoke('demo:stop').then(
    () => null,
    (error) => error
  )
  check(/no demo recording/i.test(stopAgain?.message ?? ''), 'a stray stop is refused')

  step('the render bakes the automatic camera from the journal')
  const outDir = mkdtempSync(join(os.tmpdir(), 'raccord-e2e-demo-'))
  defer(() => rmSync(outDir, { recursive: true, force: true }))
  const video = await invoke('videos:create', { projectId: project.id, name: 'Demo cut' })
  const node = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'studio/asset',
    position: { x: 0, y: 0 },
    label: 'Take'
  })
  await invoke('nodes:updateParams', { nodeId: node.id, params: { assetId: result.assetId } })
  await invoke('nodes:setTimelineOrder', { videoId: video.id, nodeIds: [node.id] })

  const rawPath = fixturePath('demoWebm')
  const cameraPath = join(outDir, 'camera.mp4')
  const rendered = await app.mcp('render_video', { videoId: video.id, outputPath: cameraPath })
  checkClose(
    rendered.durationSeconds,
    FIXTURES.demoWebm.seconds,
    0.5,
    'the camera bake is 1:1 in time'
  )
  // Click at t=1 → zoom held around t=1.4; released well before t=5.5.
  const zoomedPsnr = psnrAt(cameraPath, rawPath, 1.4)
  const identityPsnr = psnrAt(cameraPath, rawPath, 5.5)
  check(
    identityPsnr - zoomedPsnr > 6,
    `the click frame is transformed, the tail is not (zoomed ${zoomedPsnr.toFixed(1)} dB vs identity ${identityPsnr.toFixed(1)} dB)`
  )

  step('params demoCamera:false keeps the raw capture')
  await invoke('nodes:updateParams', {
    nodeId: node.id,
    params: { assetId: result.assetId, demoCamera: false }
  })
  const rawRenderPath = join(outDir, 'raw.mp4')
  await app.mcp('render_video', { videoId: video.id, outputPath: rawRenderPath })
  const optOutPsnr = psnrAt(rawRenderPath, rawPath, 1.4)
  check(
    optOutPsnr - zoomedPsnr > 6,
    `the opt-out renders the raw frame (${optOutPsnr.toFixed(1)} dB vs zoomed ${zoomedPsnr.toFixed(1)} dB)`
  )
})
