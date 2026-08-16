// HTTP routes bridging the browser settings UI (client bundle) to the host.
// Same-origin only for writes; the config route never returns the App Secret.
// One registration per path (the webServer throws on duplicate exact paths);
// the handler dispatches on the request method.
const MAX_BODY_BYTES = 256 * 1024

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

// POST writes require a same-origin request.
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch (e) {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function methodNotAllowed(res) {
  res.writeHead(405)
  res.end()
}

/**
 * Mount every route on the host's webServer. `api` is a plain object of
 * business functions provided by the host entry.
 * @returns a disposer that unregisters all routes.
 */
export function mountRoutes(host, api) {
  const disposers = []
  const route = (path, handler) => {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
  }

  // GET  /feishu-bot/config   -> { appId, configured, workspace }
  // POST /feishu-bot/config   -> { appId, appSecret } (reconnect on save)
  route('/feishu-bot/config', async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, api.getConfig())
      return
    }
    if (req.method === 'POST') {
      if (!sameOrigin(req)) { res.writeHead(403); res.end(); return }
      try {
        const body = await readJsonBody(req)
        const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
        const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : ''
        if (!appId && !appSecret) { sendJson(res, 400, { ok: false, error: 'App ID 不能为空' }); return }
        const patch = { appId }
        if (appSecret) patch.appSecret = appSecret // empty = keep the configured one
        api.saveConfig(patch)
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
      }
      return
    }
    methodNotAllowed(res)
  })

  // GET  /feishu-bot/workspaces -> { workspaces, currentId, ... }
  route('/feishu-bot/workspaces', async (req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res); return }
    sendJson(res, 200, api.listWorkspaces())
  })

  // POST /feishu-bot/switch-workspace -> { id }
  route('/feishu-bot/switch-workspace', async (req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res); return }
    if (!sameOrigin(req)) { res.writeHead(403); res.end(); return }
    try {
      const body = await readJsonBody(req)
      const result = await api.switchWorkspace(String(body.id || ''))
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  })

  // GET  /feishu-bot/status -> { configured, wsPhase, workspace }
  route('/feishu-bot/status', async (req, res) => {
    if (req.method !== 'GET') { methodNotAllowed(res); return }
    sendJson(res, 200, api.getStatus())
  })

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch (e) { /* ignore */ }
    }
  }
}
