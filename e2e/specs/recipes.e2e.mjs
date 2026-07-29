/**
 * Recipe nodes end to end (§6.8): the typed IPC channel, the MCP tool and the
 * editor canvas.
 *
 * The building logic is unit-tested; what only integration can prove is that
 * the zod contract accepts the form's payload (a free-form `values` record, an
 * optional `source` object), that the agent tool reaches the same service, and
 * that the composite gesture — asset node + recipe node + edge — really lands
 * as ONE undo step through the journal that the UI drives.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, spec, step, waitFor } from '../harness/spec.mjs'

await spec('recipes', async () => {
  const mock = await startKieMock({})
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  step('a vertical project, so the video format has something to say')
  const project = await invoke('projects:create', { name: 'E2E — Recipes' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'Recipe test' })
  await invoke('videos:setStyle', { videoId: video.id, styleId: 'commercial' })
  await invoke('videos:setDefaults', {
    videoId: video.id,
    defaultAspectRatio: '9:16',
    defaultResolution: '720p'
  })

  step('create a design sheet through the typed IPC channel')
  const sheet = await invoke('recipes:createNode', {
    videoId: video.id,
    recipeId: 'character',
    values: { description: 'Léa, 20, pink hair', views: 'five-view', wardrobe: 'yellow jacket' },
    position: { x: 0, y: 0 }
  })
  check(sheet.prompt.includes('Léa, 20, pink hair'), 'the subject reached the prompt')
  check(
    sheet.prompt.includes('five aligned views'),
    'the chosen option fragment reached the prompt'
  )
  check(sheet.prompt.includes('yellow jacket'), 'the free-text field reached the prompt')
  checkEqual(sheet.sourceNodeId, null, 'a text mode wires nothing')

  const afterSheet = await invoke('graph:get', { videoId: video.id })
  const sheetNode = afterSheet.nodes.find((n) => n.id === sheet.nodeId)
  checkEqual(sheetNode.params.designId, 'character', 'the design marker is stamped')
  checkEqual(sheetNode.params.recipeMode, 'text', 'the mode marker is stamped')
  check(sheetNode.params.applyVideoStyle === true, 'style-at-payload is opted into')
  // A turnaround is reference material — it keeps the format it reads best in.
  checkEqual(sheetNode.params.aspect_ratio, '16:9', 'the sheet keeps its own format')

  step('create a shot preset through the MCP tool, wired to the sheet is NOT what we want')
  const shot = await app.mcp('add_recipe_node', {
    videoId: video.id,
    recipeId: 'shot-orbit',
    values: {
      description: 'the headphones on their stand',
      opensOn: 'the product dark, unlit',
      closesOn: 'the product fully lit, logo facing camera',
      screenDirection: 'left-to-right',
      pace: 'slow'
    },
    x: 420,
    y: 0
  })
  const afterShot = await invoke('graph:get', { videoId: video.id })
  const shotNode = afterShot.nodes.find((n) => n.id === shot.nodeId)
  check(Boolean(shotNode), 'the agent tool created the node')
  checkEqual(shotNode.params.recipeId, 'shot-orbit', 'the recipe marker is stamped')
  check(!('designId' in shotNode.params), 'a clip never claims the design-sheet marker')
  // The film is vertical: so is every shot in it.
  checkEqual(shotNode.params.aspect_ratio, '9:16', 'the shot follows the video format')
  checkEqual(shotNode.params.duration, 6, 'the preset ships its own length')
  check(shotNode.params.prompt.includes('orbits'), 'the camera move is written for the model')
  check(shotNode.params.prompt.includes('OPENS ON'), 'the continuity contract is written')
  // §6.9: the stored prompt is the BODY of the sandwich — a bracketed timeline.
  // Its universe is selected at payload time from the video's art direction.
  check(shotNode.params.prompt.includes('[TIMELINE]'), 'the body is a bracketed timeline')
  check(
    !shotNode.params.prompt.includes('[STYLE + CAMERA + ATMOSPHERE]'),
    'the capture declaration is not baked into the stored prompt'
  )

  step('the lint is happy with what the preset produced')
  const lint = await app.mcp('lint_node', { nodeId: shot.nodeId })
  check(lint.ok, `a preset must not produce a finding — got ${JSON.stringify(lint.findings)}`)

  step('a from-video mode creates the source node, the edge, and ONE undo step')
  const before = (await invoke('graph:get', { videoId: video.id })).nodes.length
  const extend = await invoke('recipes:createNode', {
    videoId: video.id,
    recipeId: 'shot-extend',
    values: { description: 'the camera keeps orbiting past the logo' },
    source: { nodeId: shot.nodeId },
    position: { x: 840, y: 0 }
  })
  checkEqual(extend.handleKey, 'reference_video_urls', 'the handle came from the model registry')
  const chained = await invoke('graph:get', { videoId: video.id })
  checkEqual(chained.nodes.length, before + 1, 'exactly one node was added')
  checkEqual(chained.edges.length, 1, 'the source was wired')
  checkEqual(chained.edges[0].sourceNodeId, shot.nodeId, 'wired from the previous clip')

  await invoke('history:undo', { videoId: video.id })
  const undone = await invoke('graph:get', { videoId: video.id })
  checkEqual(undone.nodes.length, before, 'one undo removed the whole gesture')
  checkEqual(undone.edges.length, 0, 'including its edge')

  step('the recipe nodes are on the canvas')
  await app.goto(`/projects/${project.id}/videos/${video.id}`)
  const rendered = await waitFor(
    async () => {
      const count = await win.evaluate(() => document.querySelectorAll('.react-flow__node').length)
      return count === 2 ? count : null
    },
    { label: 'the canvas renders the sheet and the shot' }
  )
  checkEqual(rendered, 2, 'the canvas renders the 2 recipe nodes')
})
