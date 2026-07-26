/**
 * The home assistant, credit-free: a scripted agent on the mocked Claude proxy
 * runs the flow a real one runs — create_project → create_video →
 * set_video_style → import_workflow → final report — while the driver asserts
 * the app really created the rows and the graph.
 *
 * Also guards the §4.10 contract that the send carries an <app-context> block:
 * a regression there is invisible in the UI and silently blinds the assistant.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, ok, spec, step, waitFor } from '../harness/spec.mjs'

const PROJECT_NAME = 'E2E — Anime'
const VIDEO_NAME = 'Séquence 1'

/** Mini anime workflow: 1 key visual + 2 Seedance 2 shots on @Image references. */
const WORKFLOW_JSON = JSON.stringify({
  version: 1,
  nodes: [
    {
      key: 'kv',
      modelId: 'gpt-image-2-text-to-image',
      label: '00 — Key visual',
      intent: 'Character design reference (@Image1 on every shot) — never appears on screen.',
      position: { x: 0, y: 0 },
      params: {
        prompt: 'Anime key visual, full-body character design.',
        aspect_ratio: '16:9',
        resolution: '1K'
      }
    },
    {
      key: 's1',
      modelId: 'bytedance/seedance-2-fast',
      label: 'Shot 01',
      position: { x: 420, y: 0 },
      params: {
        prompt: 'Character matches @Image1 (reference only). Shot 1: establishing.',
        resolution: '720p',
        duration: 8
      }
    },
    {
      key: 's2',
      modelId: 'bytedance/seedance-2-fast',
      label: 'Shot 02',
      position: { x: 840, y: 0 },
      params: {
        prompt: 'Character matches @Image1 (reference only). Shot 2: action.',
        resolution: '720p',
        duration: 8
      }
    }
  ],
  edges: [
    { from: 'kv', to: 's1', input: 'reference_image_urls', output: 'output' },
    { from: 'kv', to: 's2', input: 'reference_image_urls', output: 'output' }
  ]
})

/** Parsed content of the LAST tool_result in the conversation. */
function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    const result = content.filter((b) => b?.type === 'tool_result').at(-1)
    if (result) {
      try {
        return JSON.parse(typeof result.content === 'string' ? result.content : '')
      } catch {
        return {}
      }
    }
  }
  return null
}

await spec('assistant', async () => {
  const state = { projectId: null, videoId: null, sawAppContext: false, emptyMode: false }
  let turn = 0

  /** The scripted agent: one tool per turn, then a final report. */
  function nextAssistantMessage(body) {
    const messages = body.messages ?? []
    // Last step of the spec: the proxy answering with zero content blocks.
    if (state.emptyMode) {
      return {
        id: 'msg_empty',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    }
    // Registry tools return the created row — its `id` is the project/video id
    // (the turn counter already moved on when the tool_use went out).
    const previous = lastToolResult(messages)
    if (previous && typeof previous.id === 'string') {
      if (turn === 1) state.projectId = previous.id
      if (turn === 2) state.videoId = previous.id
    }
    const firstUser = messages.find((m) => m.role === 'user')
    const firstUserText = Array.isArray(firstUser?.content)
      ? firstUser.content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
      : String(firstUser?.content ?? '')
    if (firstUserText.includes('<app-context>') && firstUserText.includes('route: /')) {
      state.sawAppContext = true
    }

    const toolTurns = [
      () => ({ name: 'create_project', input: { name: PROJECT_NAME } }),
      () => ({ name: 'create_video', input: { projectId: state.projectId, name: VIDEO_NAME } }),
      () => ({ name: 'set_video_style', input: { videoId: state.videoId, styleId: 'anime' } }),
      () => ({
        name: 'import_workflow',
        input: { videoId: state.videoId, json: WORKFLOW_JSON, replace: false }
      })
    ]

    const base = {
      id: `msg_${turn}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
    if (turn < toolTurns.length) {
      const tool = toolTurns[turn]()
      turn++
      return {
        ...base,
        content: [{ type: 'tool_use', id: `tu_${turn}`, name: tool.name, input: tool.input }],
        stop_reason: 'tool_use'
      }
    }
    turn++
    return {
      ...base,
      content: [
        {
          type: 'text',
          text: `Projet « ${PROJECT_NAME} » créé : 1 vidéo, 3 nœuds, style anime.`
        }
      ],
      stop_reason: 'end_turn'
    }
  }

  const mock = await startKieMock({ claude: nextAssistantMessage })
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke, win } = app

  step('send one brief to the home assistant')
  await app.goto('#/')
  await win.waitForTimeout(500)
  // The sidebar's open state is persisted (localStorage) and defaults to open —
  // clicking the header toggle unconditionally would close it.
  const draft = win.locator('aside textarea')
  if ((await draft.count()) === 0) {
    await win
      .getByRole('button', { name: /assistant/i })
      .first()
      .click()
  }
  await draft.waitFor({ timeout: 10_000 })
  await draft.fill("Crée-moi un projet d'animé de 2,5 minutes sur un chat samouraï.")
  await draft.press('Enter')

  step('the scripted agent delivers the project')
  await waitFor(async () => (await win.getByText(PROJECT_NAME, { exact: true }).count()) > 0, {
    label: 'the project card on the home page',
    timeout: 30_000
  })
  ok('the project appears on the home page')
  await waitFor(async () => (await win.getByText(/Projet « .* » créé/).count()) > 0, {
    label: "the assistant's final report",
    timeout: 20_000
  })
  ok("the assistant's final report is rendered")
  check(state.sawAppContext, 'the send carried the <app-context> snapshot to the provider')

  step('the rows and the graph really exist')
  const projects = await invoke('projects:list')
  const project = projects.find((p) => p.name === PROJECT_NAME)
  check(Boolean(project), 'the project row exists')
  const videos = await invoke('videos:listByProject', { projectId: project.id })
  checkEqual(videos.length, 1, 'the project holds one video')
  checkEqual(videos[0].name, VIDEO_NAME, 'the video kept its name')
  checkEqual(videos[0].styleId, 'anime', 'set_video_style applied the style')

  const graph = await invoke('graph:get', { videoId: videos[0].id })
  checkEqual(graph.nodes.length, 3, 'the imported workflow has 3 nodes')
  checkEqual(graph.edges.length, 2, 'the imported workflow has 2 reference edges')
  check(
    graph.edges.every((e) => e.targetHandle === 'reference_image_urls'),
    'the design sheet is wired as a reference, never as a frame anchor'
  )
  // Agents omit or collide positions; main lays the graph out instead of
  // trusting the payload (shared graphLayout).
  check(
    new Set(graph.nodes.map((n) => `${n.position.x}:${n.position.y}`)).size === 3,
    'every imported node got its own position'
  )

  step('the editor opens on the imported graph')
  await app.goto(`#/projects/${project.id}/videos/${videos[0].id}`)
  await win.waitForSelector('.react-flow__node', { timeout: 15_000 })
  checkEqual(await win.locator('.react-flow__node').count(), 3, 'the canvas renders 3 nodes')
  checkEqual(await win.locator('.react-flow__edge').count(), 2, 'the canvas renders 2 edges')

  // A proxy that closes a stream having sent nothing used to end the turn as if
  // the model had finished: no text, no error, an empty assistant message
  // persisted in the history — a build in progress just stopped, silently.
  step('a content-less provider reply is retried, then surfaced')
  const [thread] = await invoke('chat:listThreads')
  state.emptyMode = true
  const callsBefore = mock.recorded.claude.length
  const after = await invoke('chat:send', { threadId: thread.id, text: 'et le workflow ?' })
  check(Boolean(after.error), 'the turn reports an error instead of ending in silence')
  check(!after.busy, 'the composer is released')
  checkEqual(
    mock.recorded.claude.length - callsBefore,
    3,
    'the empty reply was retried twice before giving up'
  )
  const last = after.items.at(-1)
  checkEqual(last?.type, 'user', 'no empty assistant bubble was appended')
})
