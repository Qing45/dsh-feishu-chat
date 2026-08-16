// dsh-feishu-chat host entry: Feishu long-connection bridge for DeepSeek
// Harness. Receives Feishu messages over the official WS long connection,
// delegates each message to a subagent of the bound workspace's session,
// and sends the text reply back to the Feishu chat. Also registers a
// `feishu_send_message` model tool and the settings HTTP routes.
import { FeishuClient } from './feishu.js'
import { FeishuWsClient } from './ws.js'
import { FeishuRouter } from './router.js'
import { loadConfig, saveConfig } from './config.js'
import { mountRoutes } from './routes.js'

export const name = 'feishu-bot'

// Wait for the tools registry (part of dsh-base) before apply runs, so the
// model tool registers reliably; mirrors how modsearch/modlens declare it.
export const inject = ['tools']

export async function apply(ctx, config) {
  const TAG = '[feishu-bot]'
  let disposed = false
  const log = (...a) => { if (!disposed) console.log(TAG, ...a) }
  const logErr = (...a) => { if (!disposed) console.error(TAG, ...a) }

  // ---- persistent settings (bot credentials + bound workspace) ----
  let settings = loadConfig()
  const client = new FeishuClient(() => ({ appId: settings.appId, appSecret: settings.appSecret }))

  // ---- bound workspace (message routing target) ----
  let boundWorkspace = { path: null, title: null, id: null, sessionId: null }

  function listWorkspaces() {
    const wr = ctx.get('workspaceRegistry')
    if (!wr || !wr.list) return []
    try {
      return (wr.list() || []).map((w) => ({
        id: w.id,
        path: w.path,
        title: w.title,
        sessionCount: (w.sessionIds || []).length,
      }))
    } catch (e) { logErr('listWorkspaces failed:', String(e)); return [] }
  }

  async function resolveWorkspaceSession(path) {
    const sq = ctx.get('sessionQuery')
    let all = []
    if (sq && sq.listSessions) {
      try { all = await sq.listSessions() } catch (e) { logErr('listSessions failed:', String(e)) }
    }
    const pool = (all || []).filter((r) => {
      const cwd = (r.header && r.header.cwd) || ''
      return path ? cwd.toLowerCase() === path.toLowerCase() : true
    })
    const sorted = pool.slice().sort((a, b) => ((b.header && b.header.createdAt) || 0) - ((a.header && a.header.createdAt) || 0))
    return sorted.length > 0 ? sorted[0].header.id : null
  }

  async function bindWorkspace(w) {
    if (!w) return { ok: false, error: 'no workspace' }
    const sessionId = await resolveWorkspaceSession(w.path)
    boundWorkspace = { path: w.path, title: w.title, id: w.id, sessionId }
    router.resetParent()
    settings.workspaceId = w.id
    try { saveConfig(settings) } catch (e) { logErr('save config failed:', String(e)) }
    log('📌 bound workspace: ' + w.title + ' (' + w.path + ') session=' + sessionId)
    return { ok: true, sessionId }
  }

  async function initWorkspace() {
    // The workspace registry completes its one-time bootstrap asynchronously
    // after the service appears, and session query may lag too, so retry the
    // whole bind until a routed session exists (bounded, non-blocking).
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const workspaces = listWorkspaces()
      if (workspaces.length > 0) {
        let target = null
        if (settings.workspaceId) target = workspaces.find((w) => w.id === settings.workspaceId)
        if (!target) target = workspaces[0]
        const r = await bindWorkspace(target)
        if (r && r.sessionId) {
          log('📌 工作区就绪 (attempt ' + attempt + ')')
          return
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    logErr('⚠ 启动时未发现可用工作区/会话 — 可在 设置 → 飞书 选择工作区')
  }

  // ---- incoming message router ----
  const router = new FeishuRouter({ ctx, client, getBound: () => boundWorkspace, log, logErr })

  // ---- WebSocket long connection ----
  let ws = null

  function startWs() {
    if (disposed) return
    if (!settings.appId || !settings.appSecret) {
      log('⏸ 未配置 App ID / App Secret — 请在 设置 → 飞书 填写')
      return
    }
    if (ws) return
    ws = new FeishuWsClient({
      client,
      onEvent: (m) => {
        router.handleIncoming(m).catch((e) => { if (!disposed) logErr('handleIncoming:', String(e)) })
      },
      onStatus: (s) => log('ws status:', JSON.stringify(s)),
      onError: (e) => logErr('ws:', e),
    })
    ws.start()
    log('🔌 feishu ws client starting')
  }

  function restartWs() {
    if (ws) {
      try { ws.stop() } catch (e) { /* ignore */ }
      ws = null
    }
    client.resetToken()
    startWs()
  }

  // ---- settings HTTP routes (browser UI) ----
  const api = {
    getConfig: () => ({
      appId: settings.appId,
      configured: !!(settings.appId && settings.appSecret),
      workspace: { ...boundWorkspace },
    }),
    saveConfig: (patch) => {
      const clean = {}
      for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) clean[k] = patch[k]
      settings = { ...settings, ...clean }
      saveConfig(settings)
      log('💾 配置已保存，重新连接…')
      restartWs()
      return { ok: true }
    },
    listWorkspaces: () => ({
      workspaces: listWorkspaces(),
      currentId: boundWorkspace.id,
      currentTitle: boundWorkspace.title,
      currentPath: boundWorkspace.path,
      currentSessionId: boundWorkspace.sessionId,
    }),
    switchWorkspace: async (id) => {
      const target = listWorkspaces().find((w) => w.id === id)
      if (!target) return { ok: false, error: 'workspace not found: ' + id }
      try {
        const r = await bindWorkspace(target)
        return { ok: true, sessionId: r.sessionId }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    getStatus: () => ({
      configured: !!(settings.appId && settings.appSecret),
      wsPhase: ws ? ws.phase : 'idle',
      workspace: { ...boundWorkspace },
    }),
  }

  // ---- settings HTTP routes: self-healing mount ----
  // The webServer service can appear late or be re-created at boot (an HMR
  // refresh replaces the instance and drops routes registered on the old
  // one). The ctx.inject callback form proved unreliable for that case, so
  // mount on an interval, idempotently, re-mounting if the instance swaps.
  let routesState = { server: null, dispose: null }
  function serverKey(server) {
    // ctx.get returns a fresh tracing proxy per call, so object identity is
    // never stable; the underlying node http.Server is the per-instance
    // identity and changes only when the webServer is truly re-created.
    try {
      if (server && server.server) return server.server
    } catch (e) { /* fall through */ }
    return server
  }
  function tryMountRoutes() {
    if (disposed) return
    const server = ctx.get('webServer')
    if (!server) return
    const key = serverKey(server)
    if (routesState.server === key && routesState.dispose) return
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    try {
      const dispose = mountRoutes({ webServer: server, effect: (fn) => ctx.effect(fn, 'feishu-bot: http routes') }, api)
      routesState = { server: key, dispose }
      log('🌐 http routes mounted')
    } catch (e) {
      logErr('mount routes failed:', String(e))
    }
  }
  tryMountRoutes()
  const routesTimer = setInterval(tryMountRoutes, 5000)
  if (routesTimer.unref) routesTimer.unref()

  // ---- model tool: agent can push a message to Feishu ----
  const toolDisposers = []
  function registerTool() {
    try {
      const dispose = ctx.tools.register({
        name: 'feishu_send_message',
        description: '向飞书聊天发送文本消息。chat_id 省略时发送给最近给 DSH 发过消息的飞书聊天。',
        parameters: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: '目标飞书 chat_id；省略时发给最近联系过 DSH 的飞书聊天' },
            text: { type: 'string', description: '要发送的文本内容' },
          },
        },
        output: {
          schema: {
            type: 'object',
            required: ['ok', 'message_id', 'error'],
            properties: {
              ok: { type: 'boolean' },
              message_id: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: String(value.ok ? ('✅ sent ' + (value.message_id || '')) : ('❌ ' + (value.error || 'unknown'))),
          }],
        },
        async execute(args, exec) {
          try {
            const bound = boundWorkspace
            const cid = (args && args.chat_id) || router.lastChatByUser[bound.sessionId] || router.lastChatByUser['__last__']
            if (!cid) return { ok: false, message_id: '', error: 'no chat_id known — 先等一条飞书消息进来' }
            if (!args || !args.text) return { ok: false, message_id: '', error: 'text is required' }
            const data = await client.sendMessage(cid, args.text)
            return { ok: true, message_id: (data.data && data.data.message_id) || '', error: '' }
          } catch (e) {
            return { ok: false, message_id: '', error: String(e) }
          }
        },
      })
      toolDisposers.push(dispose)
      log('🔧 tool feishu_send_message registered')
    } catch (e) {
      logErr('tool registration failed:', String(e))
    }
  }

  // ---- boot ----
  log('🚀 feishu-bot starting (config=' + (settings.appId ? settings.appId : '(未配置)') + ')')
  registerTool()
  startWs()
  // Bind the workspace in the background (bounded retry) so the WS long
  // connection comes up immediately.
  initWorkspace().catch((e) => logErr('init workspace failed:', String(e)))

  // ---- lifecycle: everything reversible ----
  ctx.effect(() => () => {
    disposed = true
    if (routesState.dispose) {
      try { routesState.dispose() } catch (e) { /* ignore */ }
      routesState.dispose = null
    }
    clearInterval(routesTimer)
    if (ws) {
      try { ws.stop() } catch (e) { /* ignore */ }
      ws = null
    }
    for (const d of toolDisposers) {
      try { d() } catch (e) { /* ignore */ }
    }
    log('🛑 feishu-bot disposed')
  }, 'feishu-bot: cleanup')
}
