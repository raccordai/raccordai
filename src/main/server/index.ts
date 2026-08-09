import { serve, type HttpBindings, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { handleMcpRequest } from '../mcp/server'
import { app as electronApp } from 'electron'
import { getReleaseChannel } from '../env'
import { getLocalApiAuthDisabled, getLocalApiPort, getLocalApiToken } from '../services/settings'
import { logInfo } from '../services/logger'

/**
 * Local HTTP API (Hono), bound to loopback only.
 * Port and auth token are persisted settings so external clients (MCP config,
 * CLI tools) can rely on a stable address across launches.
 * The MCP server (Streamable HTTP transport) is mounted under /mcp below,
 * alongside any external tooling integration.
 */

let server: ServerType | null = null
let port: number | null = null

function buildApp(): Hono<{ Bindings: HttpBindings }> {
  const api = new Hono<{ Bindings: HttpBindings }>()

  api.get('/health', (c) =>
    c.json({
      name: 'raccord',
      version: electronApp.getVersion(),
      channel: getReleaseChannel()
    })
  )

  const token = getLocalApiToken()
  const authed = new Hono<{ Bindings: HttpBindings }>()
  authed.use('*', async (c, next) => {
    // Tokenless mode is re-read per request so the Settings toggle applies
    // without a restart. Loopback-only binding is what makes it acceptable.
    if (!getLocalApiAuthDisabled() && c.req.header('Authorization') !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  // MCP — Streamable HTTP endpoint (POST only in stateless JSON mode). The
  // response is written directly on the Node res by the MCP transport.
  authed.post('/mcp', async (c) => {
    const body = await c.req.json().catch(() => undefined)
    await handleMcpRequest(c.env.incoming, c.env.outgoing, body)
    return RESPONSE_ALREADY_SENT
  })
  authed.on(['GET', 'DELETE'], '/mcp', (c) => c.json({ error: 'method not allowed' }, 405))

  api.route('/', authed)
  return api
}

export function startLocalApi(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(port ?? 0)
      return
    }
    const desiredPort = getLocalApiPort()
    const instance = serve(
      { fetch: buildApp().fetch, hostname: '127.0.0.1', port: desiredPort },
      (info) => {
        server = instance
        port = info.port
        logInfo('local-api', `listening on 127.0.0.1:${info.port}`)
        resolve(info.port)
      }
    )
    // EADDRINUSE etc. — surface to the caller instead of crashing the app.
    instance.on('error', (error) => {
      instance.close()
      reject(error)
    })
  })
}

export function stopLocalApi(): void {
  server?.close()
  server = null
  port = null
}

export function getLocalApiStatus(): { running: boolean; port: number | null } {
  return { running: server !== null, port }
}
