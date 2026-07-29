/**
 * Casting end to end (§6.10): the whole identity chain, from a generated sheet
 * to a role wired on every shot.
 *
 * The planning and the wording are unit-tested; what only integration can prove
 * is that the chain HOLDS across four services that never call each other in a
 * unit test — a design node's generation is promoted into the library with its
 * markers, a role is named on that asset through the typed IPC channel, the
 * agent tool reaches the same service, and the wiring lands as ONE undo step in
 * the journal the UI actually drives.
 *
 * It also pins the two properties that make the feature safe to re-run: casting
 * twice is a no-op (not a double reference and not a second role sentence), and
 * a shot whose model has no reference input is SKIPPED with a reason instead of
 * costing the rest of the cast.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, spec, step, waitFor } from '../harness/spec.mjs'

await spec('casting', async () => {
  const mock = await startKieMock({})
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  step('a character sheet, generated and promoted into the library')
  const project = await invoke('projects:create', { name: 'E2E — Casting' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'Cast test' })
  await invoke('videos:setStyle', { videoId: video.id, styleId: 'anime' })

  const sheet = await invoke('recipes:createNode', {
    videoId: video.id,
    recipeId: 'character',
    values: { description: 'Léa, 20, pink hair', views: 'five-view' },
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
    name: 'Léa — character sheet'
  })
  // Promotion carries the design markers over: they are what the role sentence
  // reads to speak in the vocabulary of a character rather than of an object.
  checkEqual(asset.designId, 'character', 'the promoted asset kept its design marker')
  checkEqual(asset.designSubject, 'Léa, 20, pink hair', 'and its subject')

  step('name the sheet as a role — the sentence the library never stored')
  const casting = await invoke('casting:create', {
    projectId: project.id,
    name: 'Léa',
    assetId: asset.id,
    notes: 'always wears the red scarf'
  })
  checkEqual(casting.name, 'Léa', 'the role is named')
  checkEqual(casting.designSubject, 'Léa, 20, pink hair', 'the sheet markers are resolved')

  const listed = await app.mcp('list_castings', { projectId: project.id })
  checkEqual(listed.length, 1, 'the agent surface sees the same cast')
  checkEqual(listed[0].name, 'Léa', 'by name')

  step('two shots that can carry a reference, one that cannot')
  const shotA = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'bytedance/seedance-2-fast',
    position: { x: 420, y: 0 },
    label: 'Shot 01'
  })
  await invoke('nodes:updateParams', {
    nodeId: shotA.id,
    params: { prompt: 'She crosses the empty street.', duration: 4, applyVideoStyle: true }
  })
  const shotB = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'bytedance/seedance-2-fast',
    position: { x: 420, y: 320 },
    label: 'Shot 02'
  })
  await invoke('nodes:updateParams', {
    nodeId: shotB.id,
    params: { prompt: 'She stops under the sign.', duration: 4, applyVideoStyle: true }
  })
  // Seedance 1.5's image inputs are frame ANCHORS — a sheet wired there would
  // appear on screen, so the role must refuse rather than wire it.
  const legacy = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'bytedance/seedance-1.5-pro',
    position: { x: 420, y: 640 },
    label: 'Shot 03'
  })
  await invoke('nodes:updateParams', {
    nodeId: legacy.id,
    params: { prompt: 'A wide of the district.', duration: 4, applyVideoStyle: true }
  })

  step('the dry run reports what it would touch, and touches nothing')
  const edgesBefore = (await invoke('graph:get', { videoId: video.id })).edges.length
  const plan = await invoke('casting:plan', { videoId: video.id, castingId: casting.id })
  checkEqual(plan.cast.length, 2, 'two shots would be cast')
  checkEqual(plan.skipped.length, 1, 'the anchor-only model is reported, not wired')
  check(plan.skipped[0].reason.includes('reference-image'), 'the skip says why')
  checkEqual(plan.sourceNodeId, null, 'no sheet node exists on the canvas yet')
  checkEqual(
    (await invoke('graph:get', { videoId: video.id })).edges.length,
    edgesBefore,
    'the preview is free'
  )

  step('cast the role: one sheet node, wired on every shot, in ONE undo step')
  const nodesBefore = (await invoke('graph:get', { videoId: video.id })).nodes.length
  const result = await invoke('casting:apply', { videoId: video.id, castingId: casting.id })
  checkEqual(result.cast.length, 2, 'both shots were cast')

  const cast = await invoke('graph:get', { videoId: video.id })
  checkEqual(cast.nodes.length, nodesBefore + 1, 'exactly one asset node was created')
  const source = cast.nodes.find((n) => n.id === result.sourceNodeId)
  checkEqual(source.modelId, 'studio/asset', 'the role fans out from an asset node')
  checkEqual(source.params.assetId, asset.id, 'pointing at the cast sheet')
  checkEqual(
    cast.edges.filter((e) => e.sourceNodeId === source.id).length,
    2,
    'one sheet feeds both shots'
  )
  check(
    cast.edges.every((e) => e.targetHandle === 'reference_image_urls'),
    'wired as a REFERENCE, never as a frame anchor'
  )

  const promptA = cast.nodes.find((n) => n.id === shotA.id).params.prompt
  check(promptA.includes('She crosses the empty street.'), 'the shot keeps what it said')
  check(promptA.includes('@Image1 is LÉA'), 'the identity is named in the prompt')
  check(promptA.includes('Léa, 20, pink hair'), 'with the subject the sheet was built from')
  check(promptA.includes('always wears the red scarf'), 'and the role’s standing direction')
  checkEqual(
    cast.nodes.find((n) => n.id === legacy.id).params.prompt,
    'A wide of the district.',
    'a skipped shot is left untouched'
  )

  step('the lint has nothing to say about a cast shot')
  const lint = await app.mcp('lint_node', { nodeId: shotA.id })
  check(
    !lint.findings.some((f) => f.rule === 'reference-role-undeclared'),
    `casting declares its own role — got ${JSON.stringify(lint.findings)}`
  )

  step('casting twice is a no-op, not a second reference')
  const again = await app.mcp('cast_role', { videoId: video.id, castingId: casting.id })
  checkEqual(again.cast.length, 0, 'nothing new was wired')
  checkEqual(again.alreadyCast.length, 2, 'both shots report the alias they already answer to')
  const afterSecond = await invoke('graph:get', { videoId: video.id })
  checkEqual(afterSecond.edges.length, cast.edges.length, 'no duplicate edge')
  checkEqual(
    afterSecond.nodes.find((n) => n.id === shotA.id).params.prompt,
    promptA,
    'and no second role sentence'
  )

  step('one undo removes the whole cast')
  await invoke('history:undo', { videoId: video.id })
  const undone = await invoke('graph:get', { videoId: video.id })
  checkEqual(undone.nodes.length, nodesBefore, 'the asset node is gone')
  checkEqual(undone.edges.length, edgesBefore, 'so are its edges')
  checkEqual(
    undone.nodes.find((n) => n.id === shotA.id).params.prompt,
    'She crosses the empty street.',
    'and the prompt is back to what the user wrote'
  )

  step('the cast is on the project page')
  await app.goto(`/projects/${project.id}`)
  await win
    .getByRole('button', { name: /casting/i })
    .first()
    .click()
  const shown = await waitFor(
    async () => {
      const found = await win.getByText('Léa', { exact: true }).count()
      return found > 0 ? found : null
    },
    { label: 'the Casting tab lists the role' }
  )
  check(shown > 0, 'the role is listed on the project page')
})
