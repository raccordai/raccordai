/**
 * Scenario → graph end to end (§6.11): a brief's shot list becoming a wired
 * graph, with no model call at the last mile.
 *
 * The matching and the planning are unit-tested; what only integration can
 * prove is that the chain HOLDS across services that never meet in a unit test
 * — the scenario written through the agent surface is the one the builder
 * reads, the shot presets it instantiates go through the same recipe creation
 * path as the editor's form, the roles named in the beats reach the casting
 * service, and the whole thing lands as ONE entry in the journal the UI drives.
 *
 * It also pins the two properties that make the feature safe to re-run: the
 * plan is free (it creates nothing), and building twice adds only the shots
 * that did not exist yet.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, spec, step, waitFor } from '../harness/spec.mjs'

const BEATS = [
  {
    title: 'Le sac',
    action: 'Gloved hands buckle a backpack strap.',
    seconds: 4,
    camera: 'insert macro sur la boucle',
    closesOn: 'the buckle snapping shut'
  },
  {
    title: 'La sortie',
    action: 'Maya bursts out of the car park.',
    seconds: 6,
    camera: 'travelling latéral',
    closesOn: 'Maya entering the neon street',
    screenDirection: 'left-to-right',
    roles: ['Maya']
  },
  {
    title: 'Le regard',
    action: 'She looks back over her shoulder.',
    seconds: 5,
    camera: 'gros plan',
    closesOn: 'her eyes flicking back to the road',
    roles: ['Maya']
  }
]

await spec('scenario-graph', async () => {
  const mock = await startKieMock({})
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  step('a project, a video, and a role already cast')
  const project = await invoke('projects:create', { name: 'E2E — Scenario graph' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'Une course' })
  await invoke('videos:setStyle', { videoId: video.id, styleId: 'anime' })

  const sheet = await invoke('recipes:createNode', {
    videoId: video.id,
    recipeId: 'character',
    values: { description: 'Maya, 24, courier' },
    position: { x: 0, y: 0 }
  })
  await invoke('generations:run', { nodeId: sheet.nodeId })
  const generation = await waitFor(
    async () => {
      const gens = await invoke('generations:listForNode', { nodeId: sheet.nodeId })
      return gens.find((g) => g.status === 'success') ?? null
    },
    { label: 'the sheet generation settles' }
  )
  const asset = await invoke('assets:promoteGeneration', {
    generationId: generation.id,
    name: 'Maya — character sheet'
  })
  const casting = await invoke('casting:create', {
    projectId: project.id,
    name: 'Maya',
    assetId: asset.id
  })

  step('the assistant writes the scenario through the agent surface')
  const scenario = await app.mcp('write_scenario', {
    videoId: video.id,
    brief: 'Une course de 15 s dans la ville, la nuit',
    modelId: 'bytedance/seedance-2-fast',
    targetSeconds: 15,
    beats: BEATS
  })
  checkEqual(scenario.shots.length, 3, 'three shots')
  checkEqual(scenario.shots[1].roles[0], 'Maya', 'the beat’s role travelled into the shot')

  step('the plan says which preset each shot lands on, and creates nothing')
  const nodesBefore = (await invoke('graph:get', { videoId: video.id })).nodes.length
  const plan = await invoke('scenario:planGraph', { videoId: video.id })
  checkEqual(
    plan.build.map((entry) => entry.recipeId).join(','),
    'shot-insert,shot-tracking,shot-reaction',
    'the camera lines picked the presets'
  )
  check(plan.build[0].reason.includes('insert'), 'and the plan says which words chose them')
  checkEqual(
    plan.build[1].roles[0].castingId,
    casting.id,
    'the role resolved to the project’s cast'
  )
  checkEqual(plan.unknownRoles.length, 0, 'no unknown role')
  checkEqual(
    (await invoke('graph:get', { videoId: video.id })).nodes.length,
    nodesBefore,
    'the preview is free'
  )

  step('build: one preset node per shot, roles cast, ONE undo step')
  const result = await invoke('scenario:buildGraph', { videoId: video.id })
  checkEqual(result.created.length, 3, 'three shots created')

  const graph = await invoke('graph:get', { videoId: video.id })
  const shotOf = (key) => graph.nodes.find((n) => n.key === key)
  checkEqual(shotOf('shot-01').label, 'Le sac', 'the node is keyed and labelled like the shot')

  // The duration is the subtle part: a preset ships its own default length and
  // writes its beat timeline against it. The scenario's length must win in BOTH.
  checkEqual(shotOf('shot-02').params.duration, 6, 'the scenario’s legal duration is the param')
  check(
    shotOf('shot-02').params.prompt.includes('OPENS ON'),
    'the shot prompt states the frame it opens on'
  )
  check(
    shotOf('shot-02').params.prompt.includes('Maya entering the neon street'),
    'and the frame it closes on'
  )
  checkEqual(shotOf('shot-02').params.recipeId, 'shot-tracking', 'the recipe markers travelled')

  const sheetNode = graph.nodes.find(
    (n) => n.modelId === 'studio/asset' && n.params.assetId === asset.id
  )
  const wired = graph.edges.filter((e) => e.sourceNodeId === sheetNode.id)
  checkEqual(wired.length, 2, 'the role is wired on exactly the two shots that name it')
  check(
    wired.every((e) => e.targetHandle === 'reference_image_urls'),
    'as a REFERENCE, never as a frame anchor'
  )
  check(shotOf('shot-02').params.prompt.includes('MAYA'), 'and named in the prompt')
  check(
    !graph.edges.some((e) => e.sourceNodeId === shotOf('shot-01').id),
    'no shot is chained into the next — between shots you CUT'
  )

  step('rebuilding adds the new shot only')
  await app.mcp('write_scenario', {
    videoId: video.id,
    brief: 'Une course de 15 s dans la ville, la nuit',
    modelId: 'bytedance/seedance-2-fast',
    beats: [
      ...BEATS,
      { title: 'La chute', action: 'The bag hits the ground.', seconds: 4, camera: 'insert' }
    ]
  })
  const second = await app.mcp('build_graph_from_scenario', { videoId: video.id })
  checkEqual(second.created.length, 1, 'only the new shot was created')
  checkEqual(second.alreadyBuilt.length, 3, 'the three generating shots were left alone')
  checkEqual(
    (await invoke('graph:get', { videoId: video.id })).nodes.filter((n) =>
      n.key.startsWith('shot-')
    ).length,
    4,
    'four shots on the canvas, no duplicate'
  )

  step('one undo removes the whole build')
  await invoke('history:undo', { videoId: video.id }) // the second build
  await invoke('history:undo', { videoId: video.id }) // the first one
  const undone = await invoke('graph:get', { videoId: video.id })
  checkEqual(
    undone.nodes.filter((n) => n.key.startsWith('shot-')).length,
    0,
    'the shots are gone in two gestures, not eight'
  )

  step('the editor offers the same build from the Scenario island')
  await app.goto(`/projects/${project.id}/videos/${video.id}`)
  await win
    .getByTitle(/scénario|scenario/i)
    .first()
    .click()
  const build = win.getByRole('button', { name: /construire le graphe|build the graph/i })
  await waitFor(async () => ((await build.count()) > 0 ? true : null), {
    label: 'the Scenario panel offers the build'
  })
  await build.first().click()
  const confirm = win.getByRole('button', { name: /créer 4 plans|create 4 shots/i })
  await waitFor(async () => ((await confirm.count()) > 0 ? true : null), {
    label: 'the plan is shown before anything is created'
  })
  checkEqual(
    (await invoke('graph:get', { videoId: video.id })).nodes.filter((n) =>
      n.key.startsWith('shot-')
    ).length,
    0,
    'showing the plan created nothing'
  )
})
