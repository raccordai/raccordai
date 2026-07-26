/**
 * Credit-free kie.ai stand-in — one server for every kie surface the app talks
 * to (RACCORD_KIE_BASE points the whole client at it):
 *
 *   POST /api/v1/jobs/createTask          generation submission
 *   GET  /api/v1/jobs/recordInfo          the poller — the desktop completion path
 *   GET  /api/v1/chat/credit              balance (header chip, key validation)
 *   POST /api/file-stream-upload          local input media → temporary URL
 *   POST /api/v1/generate                 Suno music (flat body, own vocabulary)
 *   GET  /api/v1/generate/record-info     Suno poller
 *   POST /claude/v1/messages              assistant + vision QC proxy
 *   GET  /media/<file>                    the result bytes (Range-aware)
 *
 * It also records what the app sent (payloads, upload count, Claude requests),
 * which is how specs assert on the *request* side of a flow.
 */
import { createReadStream, statSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { ensureFixtures, FIXTURES, FIXTURE_DIR } from './fixtures.mjs'

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
}

/** Which fixture a model gets when the spec doesn't decide for itself. */
function defaultFixtureFor(model) {
  if (model.includes('suno')) return 'music'
  if (model.includes('image') || model.includes('nano-banana')) return 'still'
  return 'clipA'
}

function envelope(data, { code = 200, msg = 'success' } = {}) {
  return JSON.stringify({ code, msg, data })
}

/**
 * @param {object} [options]
 * @param {number} [options.credits]      balance returned by /chat/credit
 * @param {number} [options.pendingPolls] polls answered `generating` before success
 * @param {(ctx: {model: string, input: object, index: number}) => string | {fixture?: string, state?: 'fail', failMsg?: string}} [options.resultFor]
 * @param {(body: object, ctx: {index: number}) => object} [options.claude] scripted assistant turns
 */
export async function startKieMock(options = {}) {
  const { credits = 4321, pendingPolls = 0, resultFor, claude } = options
  ensureFixtures()

  /** taskId → {model, input, fixture, state, failMsg, polls, provider} */
  const tasks = new Map()
  const recorded = { createTask: [], suno: [], claude: [], uploads: 0 }
  let taskSeq = 0
  let claudeSeq = 0
  let base = ''

  const mediaUrl = (fixtureName) => `${base}/media/${FIXTURES[fixtureName].file}`

  function createTask(model, input, provider) {
    const decision = resultFor?.({ model, input, index: taskSeq }) ?? defaultFixtureFor(model)
    const plan = typeof decision === 'string' ? { fixture: decision } : decision
    const taskId = `task_${++taskSeq}`
    tasks.set(taskId, {
      model,
      input,
      provider,
      polls: 0,
      state: plan.state ?? 'success',
      failMsg: plan.failMsg,
      fixture: plan.fixture ?? defaultFixtureFor(model)
    })
    return taskId
  }

  /** 'generating' for the first `pendingPolls` polls, then the planned outcome. */
  function pollTask(taskId) {
    const task = tasks.get(taskId)
    if (!task) return null
    task.polls++
    if (task.polls <= pendingPolls) return { ...task, state: 'generating' }
    return task
  }

  function serveMedia(req, res, fileName) {
    const path = join(FIXTURE_DIR, fileName)
    let stat
    try {
      stat = statSync(path)
    } catch {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const ext = fileName.slice(fileName.lastIndexOf('.'))
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : stat.size - 1
      res.writeHead(206, {
        'content-type': type,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes'
      })
      createReadStream(path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(stat.size),
      'accept-ranges': 'bytes'
    })
    createReadStream(path).pipe(res)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const json = (payload) => {
        res.setHeader('content-type', 'application/json')
        res.end(payload)
      }
      const parsed = () => {
        try {
          return JSON.parse(body)
        } catch {
          return {}
        }
      }

      if (url.pathname.startsWith('/media/')) {
        serveMedia(req, res, decodeURIComponent(url.pathname.slice('/media/'.length)))
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/jobs/createTask') {
        const { model, input } = parsed()
        recorded.createTask.push({ model, input })
        json(envelope({ taskId: createTask(String(model), input ?? {}, 'jobs') }))
        return
      }

      if (url.pathname === '/api/v1/jobs/recordInfo') {
        const task = pollTask(url.searchParams.get('taskId') ?? '')
        if (!task) {
          json(envelope(undefined, { code: 404, msg: 'task not found' }))
          return
        }
        json(
          envelope({
            taskId: url.searchParams.get('taskId'),
            model: task.model,
            state: task.state,
            param: '{}',
            ...(task.state === 'success'
              ? { resultJson: JSON.stringify({ resultUrls: [mediaUrl(task.fixture)] }) }
              : {}),
            ...(task.state === 'fail' ? { failMsg: task.failMsg ?? 'mock failure' } : {})
          })
        )
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/generate') {
        const input = parsed()
        recorded.suno.push(input)
        json(envelope({ taskId: createTask('suno/generate-music', input, 'suno') }))
        return
      }

      if (url.pathname === '/api/v1/generate/record-info') {
        const task = pollTask(url.searchParams.get('taskId') ?? '')
        if (!task) {
          json(envelope(undefined, { code: 404, msg: 'task not found' }))
          return
        }
        const status =
          task.state === 'success'
            ? 'SUCCESS'
            : task.state === 'fail'
              ? 'GENERATE_AUDIO_FAILED'
              : 'PENDING'
        json(
          envelope({
            taskId: url.searchParams.get('taskId'),
            status,
            errorMessage: task.state === 'fail' ? (task.failMsg ?? 'mock failure') : null,
            response:
              task.state === 'success' ? { sunoData: [{ audioUrl: mediaUrl(task.fixture) }] } : {}
          })
        )
        return
      }

      if (url.pathname === '/api/v1/chat/credit') {
        json(envelope(credits))
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/file-stream-upload') {
        recorded.uploads++
        json(envelope({ downloadUrl: mediaUrl('still'), fileName: 'upload.png' }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/claude/v1/messages') {
        const payload = parsed()
        recorded.claude.push(payload)
        if (!claude) {
          res.statusCode = 501
          json(JSON.stringify({ error: { message: 'no Claude script in this mock' } }))
          return
        }
        json(JSON.stringify(claude(payload, { index: claudeSeq++ })))
        return
      }

      res.statusCode = 404
      json('{}')
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  return {
    base,
    tasks,
    recorded,
    mediaUrl,
    // closeAllConnections is what makes this resolve: server.close() alone
    // waits for the app's keep-alive sockets, so a leaked app instance would
    // hang the teardown forever.
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  }
}
