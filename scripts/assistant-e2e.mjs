/**
 * Credit-free E2E of the HOME assistant (pnpm test:assistant).
 *
 * Mocks kie.ai's Claude proxy (RACCORD_KIE_BASE) with a scripted agent that
 * behaves like the real one: create_project → create_video → set_video_style
 * → import_workflow (key visual + 2 Seedance 2 shots wired as @Image
 * references) → final report. Drives the real app UI with Playwright and
 * asserts the project, video and graph actually exist — then cleans up.
 *
 * Run from the project root, after `pnpm build`. Quits any running app
 * instance first (single-instance lock).
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { _electron } = require('playwright-core')

const PORT = 45172
const PROJECT_NAME = 'E2E — Anime'
const VIDEO_NAME = 'Séquence 1'

// ── Scripted Claude proxy ─────────────────────────────────────────────────────

/** Mini anime workflow: 1 key visual + 2 chained Seedance 2 shots (references). */
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
        prompt: '@Image2 as the first frame. Character matches @Image1. Shot 1: action.',
        resolution: '720p',
        duration: 8
      }
    }
  ],
  edges: [
    { from: 'kv', to: 's1', input: 'reference_image_urls', output: 'output' },
    { from: 'kv', to: 's2', input: 'reference_image_urls', output: 'output' },
    { from: 's1', to: 's2', input: 'reference_image_urls', output: 'lastFrame' }
  ]
})

/** Extract the parsed content of the LAST tool_result in the conversation. */
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

let step = 0
const state = { projectId: null, videoId: null }
/** §4.10 phase 2: the send must carry the <app-context> snapshot to the provider. */
let sawAppContext = false

function nextAssistantMessage(messages) {
  const prev = lastToolResult(messages)
  // Registry tools return the created row: its `id` is the project/video id
  // (step was already incremented when the tool_use went out).
  if (prev && typeof prev.id === 'string') {
    if (step === 1) state.projectId = prev.id
    if (step === 2) state.videoId = prev.id
  }

  const toolSteps = [
    () => ({ name: 'create_project', input: { name: PROJECT_NAME } }),
    () => ({ name: 'create_video', input: { projectId: state.projectId, name: VIDEO_NAME } }),
    () => ({ name: 'set_video_style', input: { videoId: state.videoId, styleId: 'anime' } }),
    () => ({
      name: 'import_workflow',
      input: { videoId: state.videoId, json: WORKFLOW_JSON, replace: false }
    })
  ]

  const base = {
    id: `msg_${step}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }
  if (step < toolSteps.length) {
    const tool = toolSteps[step]()
    step++
    return {
      ...base,
      content: [{ type: 'tool_use', id: `tu_${step}`, name: tool.name, input: tool.input }],
      stop_reason: 'tool_use'
    }
  }
  step++
  return {
    ...base,
    content: [
      {
        type: 'text',
        text: `Projet « ${PROJECT_NAME} » créé : 1 vidéo, 3 nœuds, style anime. Dis-moi quand lancer les générations.`
      }
    ],
    stop_reason: 'end_turn'
  }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/claude/v1/messages')) {
      const messages = JSON.parse(body).messages ?? []
      const firstUser = messages.find((m) => m.role === 'user')
      const firstUserText = Array.isArray(firstUser?.content)
        ? firstUser.content
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : String(firstUser?.content ?? '')
      if (firstUserText.includes('<app-context>') && firstUserText.includes('route: /')) {
        sawAppContext = true
      }
      res.end(JSON.stringify(nextAssistantMessage(messages)))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
})

// ── Driver ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return
    await sleep(700)
  }
  throw new Error(`timeout: ${label}`)
}

const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Raccord/raccord.db')

async function main() {
  // Fresh home-assistant transcript so the scripted conversation starts clean.
  execFileSync('sqlite3', [DB_PATH, "DELETE FROM chat_home_session WHERE id='home';"])
  // The mock scripts the Claude proxy: force the default model for this run,
  // restoring the user's choice afterwards.
  const prevModel = execFileSync('sqlite3', [
    DB_PATH,
    "SELECT value FROM settings WHERE key='assistantModel';"
  ])
    .toString()
    .trim()
  execFileSync('sqlite3', [DB_PATH, "DELETE FROM settings WHERE key='assistantModel';"])
  const restoreModel = () => {
    if (prevModel) {
      execFileSync('sqlite3', [
        DB_PATH,
        `INSERT OR REPLACE INTO settings(key,value) VALUES('assistantModel','${prevModel.replace(/'/g, "''")}');`
      ])
    }
  }
  process.on('exit', restoreModel)
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  const app = await _electron.launch({
    args: ['.'],
    env: { ...process.env, RACCORD_KIE_BASE: `http://127.0.0.1:${PORT}` }
  })
  const win = await app.firstWindow()
  win.on('dialog', (d) => d.accept().catch(() => {}))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(1200)

  // API key: the chat fails fast without one. Only set it if none is configured.
  let createdKey = false
  await win.locator('a[href*="/settings"]').first().click()
  await win.waitForTimeout(700)
  const keyInput = win.locator('input[placeholder*="API key" i]')
  if ((await keyInput.count()) > 0) {
    createdKey = true
    await keyInput.fill('test-key-assistant-e2e')
    await win.getByRole('button', { name: 'Save' }).click()
    await win.waitForTimeout(500)
  }
  await win.locator('a').filter({ hasText: 'Projects' }).first().click()
  await win.waitForTimeout(600)

  // Open the global assistant sidebar (permanent header toggle). Its open
  // state persists in localStorage, so it may already be open from a previous
  // session — only click when the panel isn't there yet.
  if ((await win.locator('aside textarea').count()) === 0) {
    await win.getByRole('button', { name: 'Assistant' }).click()
    await win.waitForTimeout(400)
  }
  const draft = win.locator('aside textarea')
  await draft.fill("Crée-moi un projet d'animé de 2,5 minutes sur un chat samouraï.")
  await draft.press('Enter')

  // The scripted agent creates everything; the home grid refreshes live.
  await waitFor(
    async () => (await win.getByText(PROJECT_NAME, { exact: true }).count()) > 0,
    30000,
    'project card appears on home'
  )
  console.log('✓ projet créé et visible sur l’accueil')

  await waitFor(
    async () => (await win.getByText(/Projet « .* » créé/).count()) > 0,
    15000,
    'assistant final report'
  )
  console.log('✓ rapport final de l’assistant affiché')

  if (!sawAppContext) throw new Error('<app-context> block missing from the provider request')
  console.log('✓ bloc <app-context> transmis au provider')

  // Close the assistant sidebar (header toggle) — its transcript quotes the
  // project/video names and would hijack the text-based locators below.
  await win.getByRole('button', { name: 'Assistant' }).click()
  await win.waitForTimeout(300)

  // Open the project → the video exists → the editor holds the imported graph.
  await win.locator('a, div, article').filter({ hasText: PROJECT_NAME }).last().click()
  await win.waitForTimeout(800)
  if ((await win.getByText(VIDEO_NAME).count()) === 0) throw new Error('video missing in project')
  console.log('✓ vidéo présente dans le projet')
  // Open the video: the whole LibraryCard is clickable — aim at the thumbnail
  // area (clicking the name would start the inline rename instead).
  await win
    .locator('.island')
    .filter({ hasText: VIDEO_NAME })
    .first()
    .click({ position: { x: 110, y: 70 } })
  await win.waitForTimeout(2500)
  const nodeCount = await win.locator('.react-flow__node').count()
  if (nodeCount !== 3) throw new Error(`expected 3 nodes in the editor, got ${nodeCount}`)
  const edgeCount = await win.locator('.react-flow__edge').count()
  if (edgeCount !== 3) throw new Error(`expected 3 edges in the editor, got ${edgeCount}`)
  console.log('✓ workflow importé (3 nœuds, 3 edges @Image references)')

  // Cleanup: delete every E2E project (incl. leftovers from failed runs).
  await win.evaluate(() => {
    window.location.hash = '#/'
  })
  await win.waitForTimeout(800)
  for (let i = 0; i < 5; i++) {
    const card = win.locator('.island').filter({ hasText: PROJECT_NAME }).first()
    if ((await card.count()) === 0) break
    await card.hover()
    await card
      .locator('button[title="Delete"], button[title="Supprimer"]')
      .first()
      .click({ force: true })
    // The §4.4 feedback layer replaced the native confirm() with a styled
    // modal — validate the destructive action through its confirm button.
    await win
      .locator('[role="dialog"]')
      .getByRole('button', { name: /Delete|Supprimer/ })
      .click()
    await win.waitForTimeout(800)
  }
  console.log('✓ projet(s) E2E supprimé(s)')

  await app.close()
  server.close()

  // Remove artifacts we created (never a pre-existing key).
  const cleanupSql = [
    "DELETE FROM chat_home_session WHERE id='home';",
    createdKey ? "DELETE FROM settings WHERE key='kieApiKeyEncrypted';" : ''
  ].join(' ')
  execFileSync('sqlite3', [DB_PATH, cleanupSql])
  console.log('✓ nettoyage fait — PASS')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
