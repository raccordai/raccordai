/**
 * The generation path end to end: IPC → run engine → kie submission → poller →
 * local download → media:// serving → UI.
 *
 * Covers what the unit suite deliberately leaves out (runEngine.ts, kie.ts, the
 * media protocol) plus two rules that are invisible to a unit test:
 *   - the poller IS the completion path (the mock stays `generating` for one
 *     poll, so a single lucky first poll cannot make this pass);
 *   - style-at-payload — the bible reaches the kie payload, never the stored prompt.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, ok, spec, step, waitFor } from '../harness/spec.mjs'

const PROMPT = 'A samurai cat sharpens a blade on a rainy porch, slow push-in.'
const BIBLE_FRAGMENT = '2D anime, hand-drawn cel animation'
const CREDITS = 4321

await spec('generation', async () => {
  const mock = await startKieMock({ credits: CREDITS, pendingPolls: 1 })
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  step('build a one-shot video')
  const project = await invoke('projects:create', { name: 'E2E — Generation' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'Shot test' })
  await invoke('videos:setStyle', { videoId: video.id, styleId: 'anime' })
  const node = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'grok-imagine/text-to-video',
    position: { x: 0, y: 0 },
    label: 'Shot 01'
  })
  // Params are edited (not passed at creation) so the node keeps the
  // style-at-payload marker the plain-creation path puts on it.
  await invoke('nodes:updateParams', {
    nodeId: node.id,
    params: { ...node.params, prompt: PROMPT, duration: 6, resolution: '480p' }
  })

  step('run it and wait for the poller to settle it')
  const run = await invoke('generations:run', { nodeId: node.id })
  check(Boolean(run.generationId), 'the run claimed a generation')

  const settled = await waitFor(
    async () => {
      const gens = await invoke('generations:listForNode', { nodeId: node.id })
      const gen = gens.find((g) => g.id === run.generationId)
      return gen && (gen.status === 'success' || gen.status === 'failed') ? gen : null
    },
    { label: 'the generation to settle', timeout: 120_000, interval: 1_000 }
  )
  checkEqual(settled.status, 'success', 'the generation succeeded')

  const task = [...mock.tasks.values()][0]
  checkEqual(task.model, 'grok-imagine/text-to-video', 'the model id reached kie.ai')
  check(task.polls >= 2, `the poller retried until success (${task.polls} polls)`)

  step('style-at-payload')
  const submitted = mock.recorded.createTask[0]
  check(submitted.input.prompt.startsWith(PROMPT), 'the payload prompt starts with the node prompt')
  check(submitted.input.prompt.includes(BIBLE_FRAGMENT), 'the style bible is appended at payload')
  const stored = (await invoke('graph:get', { videoId: video.id })).nodes[0]
  check(!stored.params.prompt.includes(BIBLE_FRAGMENT), 'the stored prompt stays bible-free')

  step('local media')
  const local = await waitFor(
    async () => {
      const gens = await invoke('generations:listForNode', { nodeId: node.id })
      const gen = gens.find((g) => g.id === run.generationId)
      return gen?.url?.startsWith('media://') ? gen : null
    },
    { label: 'the result to be downloaded locally', timeout: 30_000 }
  )
  checkEqual(local.resultMimeType, 'video/mp4', 'the stored mime type is the media one')
  checkEqual(
    stored.selectedGenerationId,
    run.generationId,
    'the first success auto-selected the node'
  )

  // The media:// protocol from the renderer: registered as a standard scheme,
  // allowed by the CSP, and answering Range requests — without all three the
  // <video> elements stay black.
  const ranged = await win.evaluate(async (url) => {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
    return {
      status: res.status,
      contentRange: res.headers.get('content-range'),
      contentType: res.headers.get('content-type'),
      bytes: (await res.arrayBuffer()).byteLength
    }
  }, local.url)
  checkEqual(ranged.status, 206, 'media:// answers a Range request with 206')
  checkEqual(ranged.bytes, 1024, 'the ranged body holds exactly the requested bytes')
  checkEqual(ranged.contentType, 'video/mp4', 'media:// serves the stored mime type')
  check(Boolean(ranged.contentRange), 'media:// sets Content-Range')

  step('the editor renders the settled node')
  await app.goto(`#/projects/${project.id}/videos/${video.id}`)
  await win.waitForSelector('.react-flow__node', { timeout: 15_000 })
  checkEqual(await win.locator('.react-flow__node').count(), 1, 'the canvas shows the node')
  check(
    (await win.locator('.react-flow__node').first().innerText()).includes('Shot 01'),
    'the node carries its label'
  )
  await waitFor(async () => (await win.locator('svg.lucide-coins').count()) > 0, {
    label: 'the credits chip',
    timeout: 15_000
  })
  ok('the header shows the credits chip')
  const credits = await invoke('kie:credits')
  checkEqual(credits.credits, CREDITS, 'the balance comes from the kie client')
})
