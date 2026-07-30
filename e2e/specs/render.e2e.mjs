/**
 * MP4 render, end to end and credit-free: two deliberately heterogeneous clips
 * (different dimensions, fps and audio presence, so the lossless-concat
 * shortcut is impossible) plus a Suno music lane, rendered through the MCP
 * `render_video` tool — the headless path, which is also the only way to drive
 * a render from a script (`render:export` opens a native save dialog).
 *
 * Asserted with ffprobe on the produced file, not on the app's own report:
 * sequence spec, duration, single audio stream, and an actual non-silent
 * stretch where only the music lane can be heard.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { launchApp } from '../harness/app.mjs'
import { FFMPEG, FIXTURES, probe } from '../harness/fixtures.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkClose, checkEqual, defer, ok, spec, step, waitFor } from '../harness/spec.mjs'

const SHOT_A = 'SHOT-A: a lighthouse at dawn, slow dolly in.'
const SHOT_B = 'SHOT-B: waves crashing on the rocks, handheld.'
const MUSIC = 'Ambient cinematic pad, slow build.'

const TOTAL_SECONDS = FIXTURES.clipA.seconds + FIXTURES.clipB.seconds

/** Mean volume (dB) of a slice of a file's audio — -91 dB is digital silence. */
function meanVolume(file, from, duration) {
  // volumedetect reports on stderr, like every ffmpeg filter log.
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-ss',
      String(from),
      '-t',
      String(duration),
      '-i',
      file,
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(`${run.stdout}${run.stderr}`)
  if (!match) throw new Error(`volumedetect produced no mean_volume for ${file}`)
  return Number(match[1])
}

await spec('render', async () => {
  // Each shot gets its own fixture, keyed on the prompt: the batch runs them
  // concurrently, so submission order is not a reliable discriminator.
  const mock = await startKieMock({
    resultFor: ({ input }) => {
      const prompt = String(input?.prompt ?? '')
      if (prompt.includes('SHOT-B')) return 'clipB'
      if (prompt.includes('SHOT-A')) return 'clipA'
      return 'music'
    }
  })
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  const outDir = mkdtempSync(join(os.tmpdir(), 'raccord-e2e-render-'))
  defer(() => rmSync(outDir, { recursive: true, force: true }))

  step('build a two-shot timeline with a music lane')
  const project = await invoke('projects:create', { name: 'E2E — Render' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'Sequence' })

  const makeNode = async (modelId, label, params) => {
    const node = await invoke('nodes:create', {
      videoId: video.id,
      modelId,
      position: { x: 0, y: 0 },
      label
    })
    await invoke('nodes:updateParams', { nodeId: node.id, params: { ...node.params, ...params } })
    return node
  }
  const shotA = await makeNode('grok-imagine/text-to-video', 'Shot 01', {
    prompt: SHOT_A,
    duration: FIXTURES.clipA.seconds
  })
  const shotB = await makeNode('grok-imagine/text-to-video', 'Shot 02', {
    prompt: SHOT_B,
    duration: FIXTURES.clipB.seconds
  })
  const music = await makeNode('suno/generate-music', 'Music', { prompt: MUSIC })

  step('run the batch (2 video submissions + 1 Suno submission)')
  const batch = await invoke('generations:runBatch', {
    videoId: video.id,
    targetNodeIds: [shotA.id, shotB.id, music.id],
    reuseTargets: false
  })
  checkEqual(batch.failed, 0, 'no generation failed')
  checkEqual(batch.succeeded, 3, 'the three generations succeeded')
  checkEqual(mock.recorded.suno.length, 1, 'the music node went through the Suno endpoint')
  check(
    mock.recorded.suno[0].callBackUrl !== undefined,
    'the Suno submission carries the callBackUrl its API requires'
  )

  for (const node of [shotA, shotB, music]) {
    await waitFor(
      async () => {
        const gens = await invoke('generations:listForNode', { nodeId: node.id })
        return gens.some((g) => g.status === 'success' && g.url?.startsWith('media://'))
      },
      { label: `${node.label}'s result to land locally`, timeout: 60_000 }
    )
  }
  ok('every result was downloaded into the local media store')

  step('render through the MCP tool')
  const readProgress = await app.collectEvent('event:renderProgress')
  const outputPath = join(outDir, 'sequence.mp4')
  const result = await app.mcp('render_video', { videoId: video.id, outputPath })

  checkEqual(result.path, outputPath, 'the render honoured the explicit output path')
  checkEqual(result.skipped.length, 0, 'no timeline slot was skipped')
  checkClose(result.durationSeconds, TOTAL_SECONDS, 1, 'the reported duration is the clips sum')
  check(existsSync(outputPath), 'the MP4 exists on disk')

  const events = await readProgress()
  const steps = new Set(events.map((e) => e.step))
  check(steps.has('normalize'), 'the heterogeneous clips went through the normalize path')
  check(steps.has('mux'), 'the music lane was muxed in a dedicated pass')
  check(
    events.every((e, i) => i === 0 || e.done || e.percent >= events[i - 1].percent),
    'progress never goes backwards'
  )
  const terminal = events.at(-1)
  check(terminal?.done === true && terminal.percent === 100, 'the terminal event reports 100% done')

  step('inspect the produced file')
  const info = probe(outputPath)
  const videoStream = info.streams.find((s) => s.codec_type === 'video')
  const audioStreams = info.streams.filter((s) => s.codec_type === 'audio')
  checkEqual(videoStream.codec_name, 'h264', 'the output is H.264')
  checkEqual(videoStream.width, FIXTURES.clipA.width, 'the sequence width comes from the 1st clip')
  checkEqual(
    videoStream.height,
    FIXTURES.clipA.height,
    'the sequence height comes from the 1st clip'
  )
  checkEqual(audioStreams.length, 1, 'exactly one audio stream survived the mux')
  checkClose(Number(info.format.duration), TOTAL_SECONDS, 1, 'the file duration is the clips sum')

  // The second clip is silent, so any sound in its stretch can only be the
  // music lane — this is what proves the mux did more than copy the video.
  const duringSilentClip = meanVolume(outputPath, FIXTURES.clipA.seconds + 2, 4)
  check(duringSilentClip > -60, `the music plays over the silent clip (${duringSilentClip} dB)`)

  step('timeline editing: explicit order + trim + crossfade change the render')
  // Put B first, trim half a second off both of its ends, crossfade into A.
  await invoke('nodes:setTimelineOrder', { videoId: video.id, nodeIds: [shotB.id, shotA.id] })
  await invoke('nodes:setTrim', {
    nodeId: shotB.id,
    trimStartSec: 0.5,
    trimEndSec: FIXTURES.clipB.seconds - 0.5
  })
  await invoke('nodes:setTransition', { nodeId: shotB.id, transition: 'crossfade' })

  // A title-track layer + a watermark exercise the libass burn pass.
  await invoke('textLayers:create', {
    videoId: video.id,
    content: 'E2E TITLE',
    startSec: 0,
    endSec: 3,
    x: 0.5,
    y: 0.2,
    fontFamily: 'Arial',
    sizePct: 8,
    bold: true,
    colorHex: '#ffcc00'
  })

  const readEditedProgress = await app.collectEvent('event:renderProgress')
  const editedPath = join(outDir, 'edited.mp4')
  const edited = await app.mcp('render_video', {
    videoId: video.id,
    outputPath: editedPath,
    watermarkText: 'raccord.ai'
  })
  const editedSteps = new Set((await readEditedProgress()).map((e) => e.step))
  check(editedSteps.has('transition'), 'the crossfade went through the transition pass')
  check(editedSteps.has('subtitles'), 'the text layer + watermark went through the burn pass')
  // B loses 1 s to the trim, and the crossfade overlaps the cut by 0.5 s.
  const editedSeconds = FIXTURES.clipB.seconds - 1 + FIXTURES.clipA.seconds - 0.5
  checkClose(
    edited.durationSeconds,
    editedSeconds,
    1,
    'trim and crossfade overlap shorten the reported duration'
  )
  const editedInfo = probe(editedPath)
  checkClose(
    Number(editedInfo.format.duration),
    editedSeconds,
    1,
    'ffprobe agrees on the edited duration'
  )
  const editedVideo = editedInfo.streams.find((s) => s.codec_type === 'video')
  checkEqual(
    editedVideo.width,
    FIXTURES.clipB.width,
    'the sequence spec follows the explicit timeline order (B first)'
  )

  step('cancellation')
  const cancelledPath = join(outDir, 'cancelled.mp4')
  const pending = app.mcp('render_video', { videoId: video.id, outputPath: cancelledPath }).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  const cancelled = await waitFor(() => invoke('render:cancel', { videoId: video.id }), {
    label: 'the render to become cancellable',
    timeout: 15_000,
    interval: 25
  })
  check(cancelled, 'render:cancel reported an in-flight render')
  const outcome = await pending
  check(
    /cancel/i.test(outcome.error?.message ?? ''),
    `the cancelled render failed instead of writing a file (${outcome.error?.message ?? outcome.value})`
  )
  check(!existsSync(cancelledPath), 'the cancelled render left no output file')

  step('the timeline is rendered in the UI too')
  await app.goto(`#/projects/${project.id}/videos/${video.id}`)
  await win.waitForSelector('.react-flow__node', { timeout: 15_000 })
  checkEqual(await win.locator('.react-flow__node').count(), 3, 'the canvas renders the 3 nodes')
})
